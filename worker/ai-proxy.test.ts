/**
 * Worker tests (vitest, plain node — no wrangler).
 * The Worker is a single ES module, so its handler is imported directly
 * and every external call (JWKS, Firestore, Meta) is stubbed via fetch.
 * Run with: npm test
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { handleAiRequest } from './ai-proxy.js'

const ADMIN_UID = 'lWuG4kjJAEPHifNtDQxf1FBVJW92'
const SCHOOL = 'school-1'

function b64url(data: string | Uint8Array): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { pair, jwk: { ...jwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' } }
}

async function makeToken(
  pair: CryptoKeyPair,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`
}

function goodClaims(sub: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    aud: 'scholarmanagementapp',
    iss: 'https://securetoken.google.com/scholarmanagementapp',
    exp: now + 3600,
    iat: now,
    sub,
    ...overrides,
  }
}

function firestoreDoc(schoolId: string, role: string) {
  return {
    fields: {
      schoolId: { stringValue: schoolId },
      role: { stringValue: role },
    },
  }
}

type FetchStub = (url: string, init?: Record<string, unknown>) => Promise<unknown>

describe('worker auth + routing', () => {
  let keyPair: CryptoKeyPair
  let otherPair: CryptoKeyPair
  let jwk: Record<string, unknown>
  let fetchHandler: FetchStub
  let metaBodies: Record<string, unknown>[]

  // Keypairs are generated ONCE per file, not per test: the Worker caches
  // the JWKS for an hour (correct in production — Google rotates keys
  // slowly), so regenerating keys per test would make every later test
  // verify against a stale cached key and fail with 401.
  beforeAll(async () => {
    const k = await makeKeyPair()
    keyPair = k.pair
    jwk = k.jwk
    const o = await makeKeyPair()
    otherPair = o.pair
  })

  beforeEach(() => {
    metaBodies = []
    fetchHandler = async (url: string) => {
      if (url.includes('service_accounts')) {
        return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) }
      }
      if (url.includes('firestore.googleapis.com')) {
        return { ok: false, status: 404, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"marks":[]}' } }] }) }
    }
    vi.stubGlobal('fetch', async (url: string, init?: Record<string, unknown>) => {
      const res = await fetchHandler(url, init)
      return res as Response
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function call(path: string, body: Record<string, unknown>, token?: string, env: Record<string, unknown> = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    return handleAiRequest(
      new Request(`https://proxy.example${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
      { META_API_KEY: 'server-key-not-real', ...env } as never,
    )
  }

  async function tokenFor(sub: string, signer: CryptoKeyPair = keyPair, overrides: Record<string, unknown> = {}) {
    return makeToken(signer, 'test-kid-1', goodClaims(sub, overrides))
  }

  function memberFetch(role: string, schoolId: string) {
    const prev = fetchHandler
    fetchHandler = async (url: string, init?: Record<string, unknown>) => {
      if (url.includes('firestore.googleapis.com')) {
        return { ok: true, status: 200, json: async () => firestoreDoc(schoolId, role) }
      }
      if (url.includes('api.meta.ai')) {
        metaBodies.push(JSON.parse((init?.body as string) ?? '{}'))
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"marks":[{"questionId":"q1","marks":4,"feedback":"Good."}]}' } }] }) }
      }
      return prev(url, init)
    }
  }

  const markBody = {
    schoolId: SCHOOL,
    examTitle: 'Test',
    subject: 'English',
    className: 'JSS 1',
    questions: [{ id: 'q1', text: 'Explain.', maxMarks: 5, rubric: 'guide', answer: 'ans' }],
  }

  it('answers OPTIONS with CORS headers', async () => {
    const res = await handleAiRequest(
      new Request('https://proxy.example/ai/mark-theory', { method: 'OPTIONS' }),
      {} as never,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('rejects a request with no token (401)', async () => {
    const res = await call('/ai/mark-theory', markBody)
    expect(res.status).toBe(401)
  })

  it('rejects a token signed with the wrong key (401)', async () => {
    const bad = await tokenFor('teacher-1', otherPair)
    const res = await call('/ai/mark-theory', markBody, bad)
    expect(res.status).toBe(401)
  })

  it('rejects an expired token (401)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expired = await tokenFor('teacher-1', keyPair, { exp: now - 60 })
    const res = await call('/ai/mark-theory', markBody, expired)
    expect(res.status).toBe(401)
  })

  it('rejects a token for the wrong audience (401)', async () => {
    const wrong = await tokenFor('teacher-1', keyPair, { aud: 'another-project' })
    const res = await call('/ai/mark-theory', markBody, wrong)
    expect(res.status).toBe(401)
  })

  it('rejects a student on a staff-only route (403)', async () => {
    memberFetch('student', SCHOOL)
    const tok = await tokenFor('student-1')
    const res = await call('/ai/mark-theory', markBody, tok)
    expect(res.status).toBe(403)
  })

  it('rejects a teacher from the wrong school (403)', async () => {
    memberFetch('teacher', 'school-2')
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/mark-theory', markBody, tok)
    expect(res.status).toBe(403)
  })

  it('lets a teacher of the school through, with server-built prompt only', async () => {
    memberFetch('teacher', SCHOOL)
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/mark-theory', { ...markBody, prompt: 'INJECTED-PROMPT-XYZ' }, tok)
    expect(res.status).toBe(200)
    expect(metaBodies.length).toBe(1)
    const body = metaBodies[0]
    expect(body.model).toBe('muse-spark-1.3')
    expect((body.model as string)).not.toContain('contributor')
    expect(body.reasoning_effort).toBe('minimal')
    expect(body.max_tokens).toBe(2048)
    const text = JSON.stringify(body)
    expect(text).toContain('strictly against the marking guides')
    expect(text).not.toContain('INJECTED-PROMPT-XYZ')
  })

  it('lets the school owner (sub == schoolId) use staff routes', async () => {
    const tok = await tokenFor(SCHOOL)
    const res = await call('/ai/mark-theory', markBody, tok)
    expect(res.status).toBe(200)
  })

  it('lets the global admin use staff routes', async () => {
    const tok = await tokenFor(ADMIN_UID)
    const res = await call('/ai/mark-theory', markBody, tok)
    expect(res.status).toBe(200)
  })

  it('lets a student use practice routes', async () => {
    memberFetch('student', SCHOOL)
    const tok = await tokenFor('student-1')
    const res = await call('/ai/practice-generate', { schoolId: SCHOOL, subject: 'English', className: 'JSS 1', topic: 'Nouns', count: 99 }, tok)
    expect(res.status).toBe(200)
    const text = JSON.stringify(metaBodies[0])
    expect(text).toContain('10 practice questions')
  })

  it('rejects an oversized paste (400)', async () => {
    memberFetch('teacher', SCHOOL)
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/arrange', { schoolId: SCHOOL, objectivePaste: 'x'.repeat(20001), theoryPaste: '' }, tok)
    expect(res.status).toBe(400)
  })

  it('arrange uses 8192 tokens and the arrange prompt', async () => {
    memberFetch('teacher', SCHOOL)
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/arrange', { schoolId: SCHOOL, objectivePaste: '1. Q? A. a B. b C. c D. d Answer: A', theoryPaste: '' }, tok)
    expect(res.status).toBe(200)
    expect(metaBodies[0].max_tokens).toBe(8192)
    expect(JSON.stringify(metaBodies[0])).toContain('Do not write new questions')
  })

  it('never leaks Meta error bodies to the client', async () => {
    memberFetch('teacher', SCHOOL)
    const prev = fetchHandler
    fetchHandler = async (url: string, init?: Record<string, unknown>) => {
      if (url.includes('api.meta.ai')) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'SECRET-LEAK-XYZ' } }) }
      }
      return prev(url, init)
    }
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/mark-theory', markBody, tok)
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('SECRET-LEAK-XYZ')
  })

  it('enforces the daily cap when KV is bound', async () => {
    const store = new Map<string, string>([[`cap:${SCHOOL}:${new Date().toISOString().slice(0, 10)}`, '300']])
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
    }
    memberFetch('teacher', SCHOOL)
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/mark-theory', markBody, tok, { AI_CAPS: kv })
    expect(res.status).toBe(429)
  })

  it('works without a KV binding (cap unenforced, request proceeds)', async () => {
    memberFetch('teacher', SCHOOL)
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/mark-theory', markBody, tok)
    expect(res.status).toBe(200)
  })

  it('returns 404 for unknown routes', async () => {
    const tok = await tokenFor('teacher-1')
    const res = await call('/ai/nope', { schoolId: SCHOOL }, tok)
    expect(res.status).toBe(404)
  })
})
