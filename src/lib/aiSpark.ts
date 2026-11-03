/**
 * Muse Spark integration, built 2026-10-26 onward.
 *
 * This module is the single place in EduPath Ai that knows about the
 * Muse Spark model. It contains only pure prompt building, strict JSON
 * parsing, and mark validation. It contains no API key, no password,
 * and no secret of any kind.
 *
 * How a call reaches the model:
 * - In tests and in the local test harness, a caller is injected
 *   (the AiProvider interface below).
 * - In the app, the UI calls the Cloudflare Worker proxy in
 *   src/lib/aiProxy.ts. The app sends structured data plus its Firebase
 *   sign-in token; the proxy builds the prompt server-side and calls
 *   Meta with the key from its own secret store. The app never talks
 *   to Meta directly and never holds the Meta API key, and no direct
 *   Meta call path remains in this module: the old build-time-key
 *   provider was removed 2026-10-27 when the proxy replaced it, so a
 *   shipped bundle contains no Meta endpoint and no key material.
 *   When the proxy URL is not set, the proxy client is null and the UI
 *   falls back to manual marking, with a plain message.
 *
 * Token budget, learned live 2026-10-26: without a reasoning effort
 *   setting, Muse Spark reasoning alone consumed 1,536 and then 4,096
 *   tokens with no visible output for a two-question marking prompt.
 *   With reasoning_effort "minimal", the same marking used 205 prompt
 *   and 339 completion tokens and returned valid JSON. The proxy
 *   therefore always sends reasoning_effort "minimal", and all four
 *   features request 2,048 max tokens (bulk arranging 8192). Do not
 *   remove the reasoning setting or lower these budgets without a
 *   live re-test.
 *
 * Model rules, binding for this integration:
 * - Standard tier only: muse-spark-1.3. Its data is not used for
 *   training. Never use a -contributor model for real student work.
 * - Suggested marks are a draft only. A teacher must check them and
 *   save them with the existing Save Final Score step before any
 *   suggested mark becomes a result. Suggested result comments are
 *   final as shown (the teacher may edit the text, with no separate
 *   approval step for comments), but comments and results still
 *   reach the student only when the teacher saves the final score.
 *   Practice marking never becomes a result at all.
 * - Students write exams offline. AI steps run only when online.
 *   When offline, when the model fails, or when credits run out,
 *   the app falls back to manual marking, never to an invented mark.
 * - Multi-tenant, any school: this module hardcodes no school, no
 *   school name, and no school's real data. Marking is scoped by the
 *   existing school workspace in the calling view, practice is scoped
 *   to the signed-in student's class and subjects, and live testing
 *   uses synthetic data in a fresh test school created by the school
 *   admin, not by this code.
 */

export type AiErrorKind = 'not-configured' | 'offline' | 'api' | 'parse' | 'validation'

export class AiError extends Error {
  kind: AiErrorKind
  constructor(kind: AiErrorKind, message: string) {
    super(message)
    this.name = 'AiError'
    this.kind = kind
  }
}

export interface TheoryQuestionInput {
  id: string
  text: string
  maxMarks: number
  rubric: string
  answer: string
}

export interface AiMark {
  questionId: string
  marks: number
  feedback: string
}

export interface AiMarkResult {
  marks: Record<string, number>
  feedback: Record<string, string>
  total: number
  warnings: string[]
}

export interface PracticeQuestion {
  id: string
  kind: 'objective' | 'theory'
  text: string
  options: string[]
  answerIndex: number | null
  marks: number
  rubric: string
}

export interface PracticeSet {
  subject: string
  className: string
  topic: string
  questions: PracticeQuestion[]
}

export interface PracticeMark {
  questionId: string
  marks: number
  maxMarks: number
  feedback: string
  correct: boolean | null
}

export interface AiProvider {
  complete: (prompt: string, system: string, maxTokens: number) => Promise<{ text: string }>
}

function isOnline(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false
  } catch {
    return true
  }
}

function requireOnline(): void {
  if (!isOnline()) throw new AiError('offline', 'You are offline. Connect to the internet and try again, or mark this work manually.')
}

/** Build the theory-marking prompt. The model must return JSON only. */
export function buildTheoryMarkingPrompt(
  examTitle: string,
  subject: string,
  className: string,
  questions: TheoryQuestionInput[],
): string {
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

/** Build a feedback-only prompt for work that is already marked. */
export function buildFeedbackPrompt(
  examTitle: string,
  subject: string,
  className: string,
  questions: TheoryQuestionInput[],
  marks: Record<string, number>,
): string {
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

/** Build a practice-question generation prompt for the student dashboard. */
export function buildPracticePrompt(subject: string, className: string, topic: string, count: number): string {
  const safeCount = Number.isFinite(count) ? Math.min(Math.max(Math.floor(count), 1), 10) : 5
  return [
    `Write ${safeCount} practice questions for a ${className} student in ${subject}${topic.trim() ? `, on the topic "${topic.trim()}"` : ''}.`,
    'Make a mix of multiple-choice questions with exactly 4 options and one correct option, and short theory questions. Keep the language clear for a school student in Nigeria.',
    'Return JSON only, with no explanation outside the JSON, in exactly this shape:',
    '{"questions":[{"kind":"objective","text":"<question>","options":["A","B","C","D"],"answerIndex":0,"marks":2,"rubric":""},{"kind":"theory","text":"<question>","options":[],"answerIndex":null,"marks":5,"rubric":"<what a good answer should include>"}]}',
  ].join('\n')
}

/** Build a practice-marking prompt. Practice marks never become results. */
export function buildPracticeMarkingPrompt(set: PracticeSet, answers: Record<string, string | number>): string {
  const lines = set.questions.map((q, i) => {
    const given = answers[q.id]
    const givenText = q.kind === 'objective'
      ? (typeof given === 'number' && q.options[given] ? q.options[given] : '(no answer given)')
      : (typeof given === 'string' && given.trim() ? given : '(no answer given)')
    return [
      `Question ${i + 1} (id: ${q.id}, kind: ${q.kind}, maximum ${q.marks} marks): ${q.text}`,
      ...(q.kind === 'objective' ? [`Options: ${q.options.map((o, oi) => `${String.fromCharCode(65 + oi)}. ${o}`).join(' | ')}`, `Correct option: ${q.answerIndex !== null ? String.fromCharCode(65 + q.answerIndex) : '(not set)'}`] : [`Marking guide: ${q.rubric || '(no guide recorded)'}`]),
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

/** Extract the first JSON object from model text, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  if (!text || !text.trim()) throw new AiError('parse', 'The suggested marks came back empty. Try again, or mark this work manually.')
  const cleaned = text.replace(/```json\s*/gi, '```').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AiError('parse', 'The suggested marks were not in a readable form. Try again, or mark this work manually.')
  const slice = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    throw new AiError('parse', 'The suggested marks were not in a readable form. Try again, or mark this work manually.')
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Clamp suggested marks into 0..maxMarks and collect warnings for anything
 * that was out of range, missing, or not a number. Clamping never invents
 * a mark: a missing or non-numeric mark becomes 0 with a warning, so the
 * teacher can see it and correct it before saving.
 */
export function validateAiMarks(
  raw: Record<string, unknown>,
  questions: { id: string; maxMarks: number }[],
): { marks: Record<string, number>; warnings: string[] } {
  const marks: Record<string, number> = {}
  const warnings: string[] = []
  for (const q of questions) {
    const v = raw[q.id]
    if (!isFiniteNumber(v)) {
      marks[q.id] = 0
      warnings.push(`Question ${q.id}: no usable suggested mark, set to 0 for you to check.`)
    } else if (v < 0) {
      marks[q.id] = 0
      warnings.push(`Question ${q.id}: suggested mark was below 0, set to 0.`)
    } else if (v > q.maxMarks) {
      marks[q.id] = q.maxMarks
      warnings.push(`Question ${q.id}: suggested mark was above the maximum of ${q.maxMarks}, set to ${q.maxMarks}.`)
    } else {
      marks[q.id] = v
    }
  }
  return { marks, warnings }
}

/** Parse a theory-marking JSON reply into validated marks and feedback. */
export function parseTheoryMarks(rawText: string, questions: { id: string; maxMarks: number }[]): AiMarkResult {
  const data = extractJson(rawText) as { marks?: unknown }
  if (!data || !Array.isArray(data.marks)) throw new AiError('parse', 'The suggested marks were not in a readable form. Try again, or mark this work manually.')
  const raw: Record<string, unknown> = {}
  const feedback: Record<string, string> = {}
  for (const entry of data.marks as Record<string, unknown>[]) {
    if (!entry || typeof entry.questionId !== 'string') continue
    raw[entry.questionId] = entry.marks
    feedback[entry.questionId] = typeof entry.feedback === 'string' ? entry.feedback : ''
  }
  const { marks, warnings } = validateAiMarks(raw, questions)
  for (const q of questions) if (!(q.id in feedback)) feedback[q.id] = ''
  const total = questions.reduce((a, q) => a + (marks[q.id] ?? 0), 0)
  return { marks, feedback, total, warnings }
}

/** Parse a feedback-only JSON reply. Accepts both shapes the model may
 * return: an object mapping questionId to feedback, and an array of
 * {questionId, feedback} entries (seen live 2026-10-26). */
export function parseFeedback(rawText: string, questionIds: string[]): Record<string, string> {
  const data = extractJson(rawText) as { feedback?: unknown }
  if (!data || typeof data.feedback !== 'object' || data.feedback === null) {
    throw new AiError('parse', 'The suggested feedback was not in a readable form. Try again, or write your own feedback.')
  }
  const out: Record<string, string> = {}
  if (Array.isArray(data.feedback)) {
    for (const entry of data.feedback as Record<string, unknown>[]) {
      if (entry && typeof entry.questionId === 'string' && typeof entry.feedback === 'string') out[entry.questionId] = entry.feedback
    }
  } else {
    const src = data.feedback as Record<string, unknown>
    for (const id of questionIds) out[id] = typeof src[id] === 'string' ? (src[id] as string) : ''
  }
  for (const id of questionIds) if (!(id in out)) out[id] = ''
  return out
}

/** Parse a practice-set JSON reply into questions, with ids normalised. */
export function parsePracticeSet(rawText: string, subject: string, className: string, topic: string): PracticeSet {
  const data = extractJson(rawText) as { questions?: unknown }
  if (!data || !Array.isArray(data.questions) || !data.questions.length) {
    throw new AiError('parse', 'The practice questions were not in a readable form. Try again.')
  }
  const questions: PracticeQuestion[] = []
  for (const [i, entry] of (data.questions as Record<string, unknown>[]).entries()) {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) continue
    const kind = entry.kind === 'theory' ? 'theory' : 'objective'
    const options = Array.isArray(entry.options) ? entry.options.filter((o): o is string => typeof o === 'string').slice(0, 4) : []
    const answerIndex = kind === 'objective' && isFiniteNumber(entry.answerIndex) && (entry.answerIndex as number) >= 0 && (entry.answerIndex as number) < Math.max(options.length, 1)
      ? (entry.answerIndex as number)
      : null
    const marks = isFiniteNumber(entry.marks) && (entry.marks as number) > 0 ? (entry.marks as number) : (kind === 'objective' ? 2 : 5)
    questions.push({
      id: `pq${i + 1}`,
      kind,
      text: entry.text.trim(),
      options: kind === 'objective' ? options : [],
      answerIndex,
      marks,
      rubric: typeof entry.rubric === 'string' ? entry.rubric : '',
    })
  }
  if (!questions.length) throw new AiError('parse', 'The practice questions were not in a readable form. Try again.')
  return { subject, className, topic, questions }
}

/** Parse a practice-marking JSON reply, clamped like exam marks. */
export function parsePracticeMarks(rawText: string, questions: PracticeQuestion[]): { marks: PracticeMark[]; total: number; maxTotal: number; warnings: string[] } {
  const data = extractJson(rawText) as { marks?: unknown }
  if (!data || !Array.isArray(data.marks)) throw new AiError('parse', 'The practice marks were not in a readable form. Try again.')
  const raw: Record<string, unknown> = {}
  const feedback: Record<string, string> = {}
  for (const entry of data.marks as Record<string, unknown>[]) {
    if (!entry || typeof entry.questionId !== 'string') continue
    raw[entry.questionId] = entry.marks
    feedback[entry.questionId] = typeof entry.feedback === 'string' ? entry.feedback : ''
  }
  const { marks, warnings } = validateAiMarks(raw, questions.map(q => ({ id: q.id, maxMarks: q.marks })))
  const out: PracticeMark[] = questions.map(q => {
    const m = marks[q.id] ?? 0
    return {
      questionId: q.id,
      marks: m,
      maxMarks: q.marks,
      feedback: feedback[q.id] ?? '',
      correct: q.kind === 'objective' && q.answerIndex !== null ? m >= q.marks : null,
    }
  })
  return { marks: out, total: out.reduce((a, m) => a + m.marks, 0), maxTotal: questions.reduce((a, q) => a + q.marks, 0), warnings }
}

/** Suggest theory marks for one attempt. Throws AiError on offline, missing provider, API, or parse failure.
 * The provider is injected: tests pass a fake, and the app passes the
 * proxy client (see aiProxy.ts). This function never sees a Meta key. */
export async function suggestTheoryMarks(
  provider: AiProvider | null,
  examTitle: string,
  subject: string,
  className: string,
  questions: TheoryQuestionInput[],
): Promise<AiMarkResult> {
  if (!provider) throw new AiError('not-configured', 'Suggested marking is not set up on this device. Mark this work manually, or set up suggested marking on this device first.')
  requireOnline()
  const prompt = buildTheoryMarkingPrompt(examTitle, subject, className, questions)
  const { text } = await provider.complete(prompt, 'You are a careful school teacher marking theory answers strictly against the marking guides given. Return JSON only.', 2048)
  return parseTheoryMarks(text, questions)
}

/** Suggest feedback for work that is already marked. */
export async function suggestFeedback(
  provider: AiProvider | null,
  examTitle: string,
  subject: string,
  className: string,
  questions: TheoryQuestionInput[],
  marks: Record<string, number>,
): Promise<Record<string, string>> {
  if (!provider) throw new AiError('not-configured', 'Suggested feedback is not set up on this device. Write your own feedback, or set up suggested feedback on this device first.')
  requireOnline()
  const prompt = buildFeedbackPrompt(examTitle, subject, className, questions, marks)
  const { text } = await provider.complete(prompt, 'You are a kind school teacher writing short, specific feedback. Return JSON only.', 2048)
  return parseFeedback(text, questions.map(q => q.id))
}

/** Generate a practice set for a student. */
export async function generatePractice(
  provider: AiProvider | null,
  subject: string,
  className: string,
  topic: string,
  count: number,
): Promise<PracticeSet> {
  if (!provider) throw new AiError('not-configured', 'Practice questions are not set up on this device. Ask your teacher for practice questions, or set up practice on this device first.')
  requireOnline()
  const prompt = buildPracticePrompt(subject, className, topic, count)
  const { text } = await provider.complete(prompt, 'You are a school teacher writing clear practice questions. Return JSON only.', 2048)
  return parsePracticeSet(text, subject, className, topic)
}

/** Mark a practice attempt. The result is practice only and never becomes an exam result. */
export async function markPractice(
  provider: AiProvider | null,
  set: PracticeSet,
  answers: Record<string, string | number>,
): Promise<{ marks: PracticeMark[]; total: number; maxTotal: number; warnings: string[] }> {
  if (!provider) throw new AiError('not-configured', 'Practice marking is not set up on this device. Check your answers against the marking guide, or set up practice marking on this device first.')
  requireOnline()
  const prompt = buildPracticeMarkingPrompt(set, answers)
  const { text } = await provider.complete(prompt, 'You are a school teacher marking a practice attempt fairly. Return JSON only.', 2048)
  return parsePracticeMarks(text, set.questions)
}

/** Cost estimate in US dollars at Standard rates, for reporting only. */
export function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens * 1.25 + completionTokens * 4.25) / 1_000_000
}
