/**
 * EduPath Ai — proxy AI provider (Cloudflare Worker).
 *
 * The app NEVER talks to Meta directly and NEVER holds the Meta API key.
 * It sends structured data plus its Firebase sign-in token to the proxy
 * URL (one setting, VITE_AI_PROXY_URL); the proxy checks the caller,
 * builds the fixed school prompt itself, and calls Meta with the key
 * from its own secret store.
 *
 * When VITE_AI_PROXY_URL is empty (the default until the owner deploys
 * the Worker and sends the URL back), every AI feature fails closed
 * with the same plain "not set up" behaviour as before — manual marking
 * still works. The URL itself is not a secret; the key is, and the key
 * is never in this file, the repo, or the bundle.
 *
 * The wrappers below mirror the direct-provider functions in aiSpark.ts
 * and bulkExam.ts (same checks, same plain messages, same parsers), but
 * they send structured data to the proxy instead of prompt text — the
 * client never sends prompt text to the proxy, by design.
 */

import {
  AiError, parseTheoryMarks, parseFeedback, parsePracticeSet, parsePracticeMarks,
  type TheoryQuestionInput, type PracticeSet,
} from './aiSpark'
import { parseBulkExamResponse, type ArrangedExam } from './bulkExam'
import { firebaseAuth } from '../shared/auth'

/** The proxy URL, from the build setting. Empty means AI is not wired up yet. */
export function getProxyUrl(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    return (env?.VITE_AI_PROXY_URL ?? '').trim().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function isOnline(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false
  } catch {
    return true
  }
}

function requireOnline(feature: 'arrange' | 'mark' | 'feedback' | 'practice'): void {
  if (isOnline()) return
  if (feature === 'arrange') throw new AiError('offline', 'You are offline. Connect to the internet and try arranging again, or enter the questions one by one.')
  if (feature === 'practice') throw new AiError('offline', 'You are offline. Connect to the internet and try again.')
  throw new AiError('offline', 'You are offline. Connect to the internet and try again, or mark this work manually.')
}

function notConfigured(feature: 'arrange' | 'mark' | 'feedback' | 'practice'): AiError {
  if (feature === 'arrange') return new AiError('not-configured', 'Arranging with AI is not set up on this device. Enter the questions one by one, or set up arranging on this device first.')
  if (feature === 'mark') return new AiError('not-configured', 'Suggested marking is not set up on this device. Mark this work manually, or set up suggested marking on this device first.')
  if (feature === 'feedback') return new AiError('not-configured', 'Suggested feedback is not set up on this device. Write your own feedback, or set up suggested feedback on this device first.')
  return new AiError('not-configured', 'Practice questions are not set up on this device. Ask your teacher for practice questions, or set up practice on this device first.')
}

function requireSchoolId(schoolId: string): void {
  if (!schoolId.trim()) throw new AiError('validation', 'Open a school workspace first, then try again.')
}

type Feature = 'arrange' | 'mark' | 'feedback' | 'practice'

/** Plain-language error for a proxy HTTP status. Never surfaces server internals. */
function statusError(status: number, feature: Feature): AiError {
  if (status === 401) return new AiError('not-configured', 'Your sign-in has expired. Sign in again, then try again.')
  if (status === 403) return new AiError('api', 'You do not have permission to use this AI feature for this school.')
  if (status === 429) return new AiError('api', 'The AI service is busy, or this school has used its AI allowance for today. Try again later.')
  if (status === 400) return new AiError('api', 'That request was not accepted. Check the content and try again.')
  if (feature === 'practice') return new AiError('api', 'The AI service returned an error. Try again later.')
  if (feature === 'arrange') return new AiError('api', 'The AI service returned an error. Try again, or enter the questions one by one below.')
  return new AiError('api', 'The AI service returned an error. Try again, or mark this work manually.')
}

function networkError(feature: Feature): AiError {
  if (feature === 'practice') return new AiError('api', 'Could not reach the AI service. Check your connection and try again.')
  if (feature === 'arrange') return new AiError('api', 'Could not reach the AI service. Check your connection and try again, or enter the questions one by one below.')
  return new AiError('api', 'Could not reach the AI service. Check your connection and try again, or mark this work manually.')
}

export interface ProxyClient {
  request: (route: string, body: Record<string, unknown>, feature: Feature) => Promise<{ text: string }>
}

type FetchImpl = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

async function defaultGetToken(): Promise<string> {
  const user = firebaseAuth().currentUser
  if (!user) throw new AiError('not-configured', 'Your sign-in has expired. Sign in again, then try again.')
  return user.getIdToken()
}

/**
 * Build a proxy client for a URL. Returns null when the URL is empty
 * (AI not wired up yet — callers fail closed with "not set up").
 * The token getter defaults to the signed-in Firebase user; tests may
 * inject their own fetch and token functions.
 */
export function createProxyClient(
  proxyUrl: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  getToken: () => Promise<string> = defaultGetToken,
): ProxyClient | null {
  const base = proxyUrl.trim().replace(/\/+$/, '')
  if (!base) return null
  return {
    async request(route: string, body: Record<string, unknown>, feature: Feature): Promise<{ text: string }> {
      const token = await getToken()
      let response
      try {
        response = await fetchImpl(`${base}${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        })
      } catch {
        throw networkError(feature)
      }
      if (!response.ok) throw statusError(response.status, feature)
      const data = await response.json() as { text?: unknown }
      if (typeof data.text !== 'string' || !data.text.trim()) {
        throw new AiError('parse', feature === 'practice'
          ? 'The AI reply was not in a readable form. Try again.'
          : 'The AI reply was not in a readable form. Try again, or mark this work manually.')
      }
      return { text: data.text }
    },
  }
}

/** The default proxy client for this build, or null when no URL is set. */
export function getProxyClient(): ProxyClient | null {
  return createProxyClient(getProxyUrl())
}

/** Arrange a paste through the proxy. Mirrors arrangeBulkExam's checks. */
export async function arrangeBulkExamViaProxy(
  client: ProxyClient | null,
  schoolId: string,
  objectivePaste: string,
  theoryPaste: string,
): Promise<ArrangedExam> {
  if (!client) throw notConfigured('arrange')
  requireSchoolId(schoolId)
  requireOnline('arrange')
  if (!objectivePaste.trim() && !theoryPaste.trim()) throw new AiError('validation', 'Paste at least one question first.')
  const { text } = await client.request('/ai/arrange', { schoolId, objectivePaste, theoryPaste }, 'arrange')
  return parseBulkExamResponse(text)
}

/** Suggest theory marks through the proxy. Mirrors suggestTheoryMarks. */
export async function suggestTheoryMarksViaProxy(
  client: ProxyClient | null,
  schoolId: string,
  examTitle: string,
  subject: string,
  className: string,
  questions: TheoryQuestionInput[],
) {
  if (!client) throw notConfigured('mark')
  requireSchoolId(schoolId)
  requireOnline('mark')
  const { text } = await client.request('/ai/mark-theory', { schoolId, examTitle, subject, className, questions }, 'mark')
  return parseTheoryMarks(text, questions)
}

/** Suggest feedback through the proxy. Mirrors suggestFeedback. */
export async function suggestFeedbackViaProxy(
  client: ProxyClient | null,
  schoolId: string,
  examTitle: string,
  subject: string,
  className: string,
  questions: TheoryQuestionInput[],
  marks: Record<string, number>,
) {
  if (!client) throw notConfigured('feedback')
  requireSchoolId(schoolId)
  requireOnline('feedback')
  const { text } = await client.request('/ai/feedback', { schoolId, examTitle, subject, className, questions, marks }, 'feedback')
  return parseFeedback(text, questions.map(q => q.id))
}

/** Generate a practice set through the proxy. Mirrors generatePractice. */
export async function generatePracticeViaProxy(
  client: ProxyClient | null,
  schoolId: string,
  subject: string,
  className: string,
  topic: string,
  count: number,
): Promise<PracticeSet> {
  if (!client) throw notConfigured('practice')
  requireSchoolId(schoolId)
  requireOnline('practice')
  const { text } = await client.request('/ai/practice-generate', { schoolId, subject, className, topic, count }, 'practice')
  return parsePracticeSet(text, subject, className, topic)
}

/** Mark a practice attempt through the proxy. Mirrors markPractice. */
export async function markPracticeViaProxy(
  client: ProxyClient | null,
  schoolId: string,
  set: PracticeSet,
  answers: Record<string, string | number>,
) {
  if (!client) throw notConfigured('practice')
  requireSchoolId(schoolId)
  requireOnline('practice')
  const { text } = await client.request('/ai/practice-mark', { schoolId, set, answers }, 'practice')
  return parsePracticeMarks(text, set.questions)
}
