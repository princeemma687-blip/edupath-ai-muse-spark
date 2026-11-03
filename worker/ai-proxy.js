/**
 * EduPath Ai — Cloudflare Worker AI proxy (single file, zero dependencies).
 *
 * PASTE THIS WHOLE FILE into a Worker in the Cloudflare dashboard
 * (Workers & Pages -> Create Worker -> paste as the Worker code, module
 * format) and deploy. No wrangler, no bundler, no build step.
 *
 * What it does: the EduPath app never talks to Meta directly and never
 * holds the Meta API key. The app sends structured data plus its Firebase
 * sign-in token to this Worker; the Worker checks the caller, builds the
 * fixed school prompt itself, calls Meta with the key from its secret
 * store, and returns the model's text. The key lives ONLY as a Worker
 * secret (META_API_KEY, set in the dashboard's secret UI by the owner).
 * It is never in the app, the repo, or this file.
 *
 * Routes (all POST, JSON):
 *   /ai/arrange           staff only (teacher / school owner / global admin)
 *   /ai/mark-theory       staff only
 *   /ai/feedback          staff only
 *   /ai/practice-generate any member of the school (students included)
 *   /ai/practice-mark     any member of the school
 *
 * Security, in order, on every request:
 *   1. Firebase ID token (Authorization: Bearer <token>) verified as
 *      RS256 against Google's JWKS, requiring aud = scholarmanagementapp
 *      and an unexpired exp. Missing/invalid -> 401.
 *   2. School membership + role via the Firestore REST API, using the
 *      caller's own token (so the Worker can only see what the existing
 *      Firestore rules already let that user see). Staff routes need a
 *      teacher record for the school, or the school owner, or the global
 *      admin. Practice routes accept any member of the school.
 *      Wrong school / wrong role -> 403.
 *   3. Structured fields only, with strict size limits. Unknown fields
 *      are dropped. Prompt text from the client is NEVER accepted: the
 *      prompts below are the only prompts that ever reach Meta, so this
 *      proxy can never be used as a general-purpose chatbot.
 *   4. Per-feature token caps server-side, so a client can never ask for
 *      a bigger, more expensive completion.
 *   5. Per-school daily cap (300 calls/school/day) when a KV namespace is
 *      bound as AI_CAPS; without a binding the Worker still works and
 *      only logs counts (documented in worker/README.md).
 *   6. Logs contain counts, school IDs and statuses ONLY — never student
 *      answers, prompts, or model output.
 *
 * CORS is deliberately permissive (the web app, desktop app and phone
 * app all call from different origins) because authentication is the
 * gate, not CORS: every request without a valid token is refused.
 *
 * Kill switch: delete/rotate the Meta key and update the Worker secret.
 * No app update or reship is needed.
 */

const SPARK_MODEL = 'muse-spark-1.3'
const SPARK_ENDPOINT = 'https://api.meta.ai/v1/chat/completions'
const PROJECT_ID = 'scholarmanagementapp'
// The global admin UID from firestore.rules isAdmin(). Not a secret: it is
// an identifier, and it is overridable via the ADMIN_UID Worker variable.
const DEFAULT_ADMIN_UID = 'YOUR_GLOBAL_ADMIN_UID'
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/scholarmanagementapp/databases/(default)/documents'
const DAILY_CAP_PER_SCHOOL = 300
const MAX_PASTE_CHARS = 20000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function plainError(status, message) {
  return jsonResponse(status, { error: message })
}

function base64UrlToBytes(s) {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes)
}

// --- Firebase ID token verification (RS256 via WebCrypto) -----------------

let jwksCache = null
let jwksFetchedAt = 0

async function getJwks() {
  const now = Date.now()
  if (jwksCache && now - jwksFetchedAt < 3600_000) return jwksCache
  const res = await fetch(JWKS_URL)
  if (!res.ok) throw new Error('jwks-fetch-failed')
  const data = await res.json()
  if (!data || !Array.isArray(data.keys)) throw new Error('jwks-bad-shape')
  jwksCache = data.keys
  jwksFetchedAt = now
  return jwksCache
}

/** Verify a Firebase ID token. Returns { sub } or throws with status 401. */
async function verifyIdToken(token) {
  const err = new Error('invalid-token')
  err.status = 401
  const parts = token.split('.')
  if (parts.length !== 3) throw err
  let header
  let claims
  try {
    header = JSON.parse(bytesToText(base64UrlToBytes(parts[0])))
    claims = JSON.parse(bytesToText(base64UrlToBytes(parts[1])))
  } catch {
    throw err
  }
  if (header.alg !== 'RS256' || !header.kid) throw err
  const keys = await getJwks().catch(() => { throw err })
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) throw err
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = base64UrlToBytes(parts[2])
  let ok = false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput)
  } catch {
    throw err
  }
  if (!ok) throw err
  const nowSec = Math.floor(Date.now() / 1000)
  if (claims.aud !== PROJECT_ID) throw err
  if (claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw err
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw err
  if (typeof claims.sub !== 'string' || !claims.sub) throw err
  return { sub: claims.sub }
}

// --- Firestore membership check (caller's own token, rules-gated) ----------

function firestoreString(doc, field) {
  const v = doc && doc.fields && doc.fields[field]
  return v && typeof v.stringValue === 'string' ? v.stringValue : ''
}

/**
 * Authorize a caller for a school. Returns 'staff' | 'member' | null.
 * The global admin and the school owner (school docs are keyed by owner
 * uid) need no membership doc; everyone else is checked against their own
 * edupathMemberships/{uid} doc, which the rules let every user read for
 * themselves — so this check can only see what the rules already allow.
 */
async function authorizeCaller(idToken, sub, schoolId, adminUid) {
  if (sub === adminUid) return 'staff'
  if (sub === schoolId) return 'staff'
  const url = `${FIRESTORE_BASE}/edupathMemberships/${encodeURIComponent(sub)}`
  let res
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } })
  } catch {
    return null
  }
  if (!res.ok) return null
  let doc
  try {
    doc = await res.json()
  } catch {
    return null
  }
  if (firestoreString(doc, 'schoolId') !== schoolId) return null
  return firestoreString(doc, 'role') === 'teacher' ? 'staff' : 'member'
}

// --- Input validation (structured fields only, unknown fields dropped) ----

function isStr(v, max) {
  return typeof v === 'string' && v.length <= max
}

function reqStr(body, field, max) {
  if (!isStr(body[field], max)) throw Object.assign(new Error('bad-field'), { status: 400 })
  return body[field]
}

function optStr(body, field, max) {
  if (body[field] === undefined) return ''
  if (!isStr(body[field], max)) throw Object.assign(new Error('bad-field'), { status: 400 })
  return body[field]
}

function reqQuestions(body, withAnswer) {
  const qs = body.questions
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 100) {
    throw Object.assign(new Error('bad-questions'), { status: 400 })
  }
  return qs.map((q) => {
    if (!q || typeof q !== 'object') throw Object.assign(new Error('bad-question'), { status: 400 })
    const out = {
      id: reqStr(q, 'id', 100),
      text: reqStr(q, 'text', 5000),
      maxMarks: typeof q.maxMarks === 'number' && Number.isFinite(q.maxMarks) && q.maxMarks >= 0 && q.maxMarks <= 1000 ? q.maxMarks : 0,
      rubric: optStr(q, 'rubric', 5000),
    }
    if (withAnswer) out.answer = optStr(q, 'answer', 10000)
    return out
  })
}

// --- Server-side prompts (ported from the app's pure prompt builders) -----
// These are the ONLY prompts that ever reach Meta. The client sends data;
// the Worker builds the prompt. Any prompt text sent by a client is ignored.

function theoryMarkingPrompt(examTitle, subject, className, questions) {
  const lines = questions.map((q, i) => [
    `Question ${i + 1} (id: ${q.id}, maximum ${q.maxMarks} marks): ${q.text}`,
    `Marking guide: ${q.rubric || '(no guide recorded)'}`,
    `Student answer: ${q.answer || '(no answer given)'}`,
  ].join('\n'))
  return [
    `Mark this ${className} ${subject} theory exam, titled "${examTitle}", strictly against the marking guides below.`,
    'Award whole or half marks only, from 0 up to each question maximum. A blank answer scores 0. Do not award marks for work that is not in the answer.',
    'Return JSON only, with no explanation outside the JSON, in exactly this shape:',
    '{"marks":[{"questionId":"<id>","marks":<number>,"feedback":"<one short sentence, kind and specific>"}]}',
    '',
    ...lines,
  ].join('\n')
}

function feedbackPrompt(examTitle, subject, className, questions, marks) {
  const lines = questions.map((q, i) => [
    `Question ${i + 1} (id: ${q.id}, maximum ${q.maxMarks} marks, awarded ${marks[q.id] ?? 0} marks): ${q.text}`,
    `Marking guide: ${q.rubric || '(no guide recorded)'}`,
    `Student answer: ${q.answer || '(no answer given)'}`,
  ].join('\n'))
  return [
    `Write short, encouraging feedback for this ${className} ${subject} exam, titled "${examTitle}". One sentence per question, naming what was good and one thing to improve. Do not change any mark.`,
    'Return JSON only, with no explanation outside the JSON, in exactly this shape:',
    '{"feedback":{"<questionId>":"<one sentence>"}}',
    '',
    ...lines,
  ].join('\n')
}

function practicePrompt(subject, className, topic, count) {
  const safeCount = Number.isFinite(count) ? Math.min(Math.max(Math.floor(count), 1), 10) : 5
  return [
    `Write ${safeCount} practice questions for a ${className} student in ${subject}${topic.trim() ? `, on the topic "${topic.trim()}"` : ''}.`,
    'Make a mix of multiple-choice questions with exactly 4 options and one correct option, and short theory questions. Keep the language clear for a school student in Nigeria.',
    'Return JSON only, with no explanation outside the JSON, in exactly this shape:',
    '{"questions":[{"kind":"objective","text":"<question>","options":["A","B","C","D"],"answerIndex":0,"marks":2,"rubric":""},{"kind":"theory","text":"<question>","options":[],"answerIndex":null,"marks":5,"rubric":"<what a good answer should include>"}]}',
  ].join('\n')
}

function practiceMarkingPrompt(set, answers) {
  const lines = set.questions.map((q, i) => {
    const given = answers[q.id]
    const givenText = q.kind === 'objective'
      ? (typeof given === 'number' && q.options[given] ? q.options[given] : '(no answer given)')
      : (typeof given === 'string' && given.trim() ? given : '(no answer given)')
    return [
      `Question ${i + 1} (id: ${q.id}, kind: ${q.kind}, maximum ${q.marks} marks): ${q.text}`,
      ...(q.kind === 'objective'
        ? [`Options: ${q.options.map((o, oi) => `${String.fromCharCode(65 + oi)}. ${o}`).join(' | ')}`, `Correct option: ${q.answerIndex !== null ? String.fromCharCode(65 + q.answerIndex) : '(not set)'}`]
        : [`Marking guide: ${q.rubric || '(no guide recorded)'}`]),
      `Student answer: ${givenText}`,
    ].join('\n')
  })
  return [
    `Mark this ${set.className} ${set.subject} practice attempt${set.topic ? ` on "${set.topic}"` : ''}. Award whole or half marks only, from 0 up to each question maximum. This is practice only, not an exam result.`,
    'Return JSON only, with no explanation outside the JSON, in exactly this shape:',
    '{"marks":[{"questionId":"<id>","marks":<number>,"feedback":"<one short sentence>"}]}',
    '',
    ...lines,
  ].join('\n')
}

function bulkExamPrompt(objectivePaste, theoryPaste) {
  return [
    'You are arranging a teacher\'s own exam questions into slots. Do not write new questions, do not rewrite any wording, and do not mark anything.',
    'The teacher pasted their questions in whatever neat layout they typed. Questions may be numbered like 1., 1), Q1, or Question 1. Options may be labelled A-D, a-d, or (a)-(d). A correct answer may be given beside a question (for example "Answer: B") or in an answer key at the end (for example "1-B, 2-A"). Identify each question number by number, in order, and match each answer to its question.',
    'Rules you must follow:',
    '- Include every question you can find, even an incomplete one. Never drop a question.',
    '- Keep each theory question word for word, exactly as pasted. Do not shorten, rephrase, or tidy it.',
    '- Give each objective question exactly 4 options, in the order pasted.',
    '- If a correct answer is missing or could fit more than one option, set answerIndex to null and set needsCheck to true, with a short reason. Never guess a correct answer.',
    '- If a question is missing options, has fewer than 4 options, or its split from the next question is unclear, include it anyway, set needsCheck to true, and explain what is unclear.',
    '- Use the marks stated in the paste when given; otherwise use 5.',
    '- If a theory model answer is pasted, put it in rubric. The rubric is for the teacher only.',
    'Return JSON only, with no explanation outside the JSON, in exactly this shape:',
    '{"objective":[{"number":1,"text":"<question exactly as pasted>","options":["<option A>","<option B>","<option C>","<option D>"],"answerIndex":0,"marks":5,"needsCheck":false,"checkReason":""}],"theory":[{"number":1,"text":"<theory question exactly as pasted>","maxMarks":5,"rubric":"<model answer or marking guide, or empty>","needsCheck":false,"checkReason":""}]}',
    '',
    'OBJECTIVE QUESTIONS AND ANSWERS PASTED BY THE TEACHER:',
    objectivePaste.trim() || '(none pasted)',
    '',
    'THEORY QUESTIONS PASTED BY THE TEACHER:',
    theoryPaste.trim() || '(none pasted)',
  ].join('\n')
}

// --- Per-route handling -----------------------------------------------------

const ROUTES = {
  '/ai/arrange': { staffOnly: true, maxTokens: 8192 },
  '/ai/mark-theory': { staffOnly: true, maxTokens: 2048 },
  '/ai/feedback': { staffOnly: true, maxTokens: 2048 },
  '/ai/practice-generate': { staffOnly: false, maxTokens: 2048 },
  '/ai/practice-mark': { staffOnly: false, maxTokens: 2048 },
}

const SYSTEM_PROMPTS = {
  '/ai/arrange': 'You are arranging a teacher\'s own exam questions into slots. Keep every question, keep theory wording exact, never guess a correct answer, and return JSON only.',
  '/ai/mark-theory': 'You are a careful school teacher marking theory answers strictly against the marking guides given. Return JSON only.',
  '/ai/feedback': 'You are a kind school teacher writing short, specific feedback. Return JSON only.',
  '/ai/practice-generate': 'You are a school teacher writing clear practice questions. Return JSON only.',
  '/ai/practice-mark': 'You are a school teacher marking a practice attempt fairly. Return JSON only.',
}

function buildRoutePrompt(path, body) {
  if (path === '/ai/arrange') {
    const objectivePaste = reqStr(body, 'objectivePaste', MAX_PASTE_CHARS)
    const theoryPaste = reqStr(body, 'theoryPaste', MAX_PASTE_CHARS)
    if (!objectivePaste.trim() && !theoryPaste.trim()) throw Object.assign(new Error('empty-paste'), { status: 400 })
    return bulkExamPrompt(objectivePaste, theoryPaste)
  }
  if (path === '/ai/mark-theory') {
    const examTitle = reqStr(body, 'examTitle', 200)
    const subject = reqStr(body, 'subject', 100)
    const className = reqStr(body, 'className', 50)
    return theoryMarkingPrompt(examTitle, subject, className, reqQuestions(body, true))
  }
  if (path === '/ai/feedback') {
    const examTitle = reqStr(body, 'examTitle', 200)
    const subject = reqStr(body, 'subject', 100)
    const className = reqStr(body, 'className', 50)
    const questions = reqQuestions(body, true)
    const marksRaw = body.marks && typeof body.marks === 'object' ? body.marks : {}
    const marks = {}
    for (const q of questions) {
      const v = marksRaw[q.id]
      marks[q.id] = typeof v === 'number' && Number.isFinite(v) ? v : 0
    }
    return feedbackPrompt(examTitle, subject, className, questions, marks)
  }
  if (path === '/ai/practice-generate') {
    const subject = reqStr(body, 'subject', 100)
    const className = reqStr(body, 'className', 50)
    const topic = optStr(body, 'topic', 500)
    const count = typeof body.count === 'number' ? body.count : 5
    return practicePrompt(subject, className, topic, count)
  }
  // /ai/practice-mark
  const setRaw = body.set && typeof body.set === 'object' ? body.set : null
  if (!setRaw) throw Object.assign(new Error('bad-set'), { status: 400 })
  const subject = reqStr(setRaw, 'subject', 100)
  const className = reqStr(setRaw, 'className', 50)
  const topic = optStr(setRaw, 'topic', 500)
  const rawQs = setRaw.questions
  if (!Array.isArray(rawQs) || rawQs.length < 1 || rawQs.length > 100) {
    throw Object.assign(new Error('bad-set-questions'), { status: 400 })
  }
  const questions = rawQs.map((q) => {
    if (!q || typeof q !== 'object') throw Object.assign(new Error('bad-set-question'), { status: 400 })
    const kind = q.kind === 'theory' ? 'theory' : 'objective'
    const options = Array.isArray(q.options)
      ? q.options.filter((o) => typeof o === 'string').map((o) => o.slice(0, 1000)).slice(0, 4)
      : []
    const answerIndex = kind === 'objective' && typeof q.answerIndex === 'number' && q.answerIndex >= 0 && q.answerIndex < Math.max(options.length, 1)
      ? q.answerIndex
      : null
    return {
      id: reqStr(q, 'id', 100),
      kind,
      text: reqStr(q, 'text', 5000),
      options: kind === 'objective' ? options : [],
      answerIndex,
      marks: typeof q.marks === 'number' && Number.isFinite(q.marks) && q.marks > 0 ? q.marks : (kind === 'objective' ? 2 : 5),
      rubric: optStr(q, 'rubric', 5000),
    }
  })
  const answersRaw = body.answers && typeof body.answers === 'object' ? body.answers : {}
  const answers = {}
  for (const q of questions) {
    const v = answersRaw[q.id]
    answers[q.id] = typeof v === 'string' ? v.slice(0, 10000) : (typeof v === 'number' ? v : '')
  }
  return practiceMarkingPrompt({ subject, className, topic, questions }, answers)
}

async function checkDailyCap(env, schoolId) {
  // Optional KV binding. Without it the Worker still works and only logs.
  const kv = env ? env.AI_CAPS : undefined
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return false
  const today = new Date().toISOString().slice(0, 10)
  const key = `cap:${schoolId}:${today}`
  try {
    const raw = await kv.get(key)
    const used = raw ? parseInt(raw, 10) || 0 : 0
    if (used >= DAILY_CAP_PER_SCHOOL) return true
    await kv.put(key, String(used + 1), { expirationTtl: 90000 })
  } catch {
    // KV failure must not break AI for a school; counts are logged anyway.
    return false
  }
  return false
}

async function callMeta(env, system, prompt, maxTokens) {
  if (!env || !env.META_API_KEY) {
    throw Object.assign(new Error('no-server-key'), { status: 500 })
  }
  let res
  try {
    res = await fetch(SPARK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.META_API_KEY}` },
      body: JSON.stringify({
        model: SPARK_MODEL,
        messages: [
          ...(system.trim() ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        max_tokens: Math.max(maxTokens, 256),
        reasoning_effort: 'minimal',
      }),
    })
  } catch {
    throw Object.assign(new Error('meta-unreachable'), { status: 502 })
  }
  if (!res.ok) {
    if (res.status === 429) throw Object.assign(new Error('meta-rate-limited'), { status: 429 })
    // A 401/403 from Meta means the server key is wrong — never leak that.
    throw Object.assign(new Error('meta-error'), { status: 502 })
  }
  let data
  try {
    data = await res.json()
  } catch {
    throw Object.assign(new Error('meta-bad-json'), { status: 502 })
  }
  const text = data.choices?.[0]?.message?.content
    ?? (Array.isArray(data.content) ? data.content.map((c) => c.text ?? '').join('') : '')
  if (!text || !text.trim()) throw Object.assign(new Error('meta-empty'), { status: 502 })
  return text
}

/** The full request handler. Importable in plain node for tests. */
export async function handleAiRequest(request, env) {
  const url = new URL(request.url)
  const path = url.pathname
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  const route = ROUTES[path]
  if (!route) return plainError(404, 'Not found.')
  if (request.method !== 'POST') return plainError(405, 'Only POST is allowed here.')
  const adminUid = (env && env.ADMIN_UID) || DEFAULT_ADMIN_UID
  let status = 200
  let schoolId = ''
  try {
    let body
    try {
      body = await request.json()
    } catch {
      return plainError(400, 'That request was not understood.')
    }
    if (!body || typeof body !== 'object') return plainError(400, 'That request was not understood.')
    const authHeader = request.headers.get('Authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) return plainError(401, 'Sign in again to use this feature.')
    let sub
    try {
      sub = (await verifyIdToken(token)).sub
    } catch (e) {
      return plainError(e.status || 401, 'Sign in again to use this feature.')
    }
    if (typeof body.schoolId !== 'string' || !body.schoolId.trim() || body.schoolId.length > 100) {
      return plainError(400, 'That request was not understood.')
    }
    schoolId = body.schoolId
    const level = await authorizeCaller(token, sub, schoolId, adminUid)
    if (level === null) return plainError(403, 'You do not have permission to use this feature for this school.')
    if (route.staffOnly && level !== 'staff') {
      return plainError(403, 'You do not have permission to use this feature for this school.')
    }
    let prompt
    try {
      prompt = buildRoutePrompt(path, body)
    } catch (e) {
      return plainError(e.status || 400, 'That request was not accepted. Check the content and try again.')
    }
    if (await checkDailyCap(env, schoolId)) {
      return plainError(429, 'This school has used its AI allowance for today. Try again tomorrow.')
    }
    let text
    try {
      text = await callMeta(env, SYSTEM_PROMPTS[path], prompt, route.maxTokens)
    } catch (e) {
      if (e.status === 429) return plainError(429, 'The AI service is busy. Try again later.')
      if (e.status === 500) return plainError(500, 'AI is not set up on the server yet.')
      return plainError(502, 'The AI service returned an error. Try again later.')
    }
    console.log(JSON.stringify({ route: path, schoolId, status: 200 }))
    return jsonResponse(200, { text })
  } catch {
    console.log(JSON.stringify({ route: path, schoolId, status: 500 }))
    return plainError(500, 'Something went wrong. Try again later.')
  }
}

export default {
  async fetch(request, env) {
    return handleAiRequest(request, env)
  },
}
