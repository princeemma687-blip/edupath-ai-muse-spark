/**
 * App-side proxy client tests. The client sends structured data + a
 * Firebase sign-in token to the proxy URL — never prompt text, never a
 * Meta key. The proxy itself is tested in worker/ai-proxy.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { AiError } from './aiSpark'
import {
  createProxyClient,
  suggestTheoryMarksViaProxy, arrangeBulkExamViaProxy, generatePracticeViaProxy,
} from './aiProxy'

type FakeInit = { url: string; init: Record<string, unknown> }

function fakeFetchFactory(
  status: number,
  body: unknown,
  calls: FakeInit[],
): (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
}

const fakeToken = async () => 'firebase-token-not-real'
const qs = [{ id: 'q1', text: 'Explain.', maxMarks: 5, rubric: 'guide', answer: 'ans' }]

describe('proxy client', () => {
  it('returns null when no proxy URL is set, so the UI fails closed', () => {
    expect(createProxyClient('')).toBeNull()
    expect(createProxyClient('   ')).toBeNull()
  })

  it('posts to the owner\'s deployed Worker URL (trailing slash trimmed)', async () => {
    // The production build bakes VITE_AI_PROXY_URL from .env.local into
    // the bundle (verified by grepping dist, since vitest cannot see
    // another module's import.meta.env). Here we prove the client built
    // from that exact URL posts structured data + token to the right
    // route, with no prompt text and no Meta key material.
    const calls: FakeInit[] = []
    const fetchImpl = fakeFetchFactory(200, { text: '{"marks":[{"questionId":"q1","marks":4,"feedback":"Good."}]}' }, calls)
    const client = createProxyClient('https://edupath-ai.princeemma687.workers.dev/', fetchImpl as never, fakeToken)!
    expect(client).not.toBeNull()
    await suggestTheoryMarksViaProxy(client, 'school-1', 'Test', 'English', 'JSS 1', qs)
    expect(calls[0].url).toBe('https://edupath-ai.princeemma687.workers.dev/ai/mark-theory')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer firebase-token-not-real')
    const body = JSON.parse(calls[0].init.body as string)
    expect(body).not.toHaveProperty('prompt')
    expect(JSON.stringify(body)).not.toContain('api.meta.ai')
  })

  it('posts structured data + Firebase token to the route, never prompt text', async () => {
    const calls: FakeInit[] = []
    const fetchImpl = fakeFetchFactory(200, { text: '{"marks":[{"questionId":"q1","marks":4,"feedback":"Good."}]}' }, calls)
    const client = createProxyClient('https://proxy.example', fetchImpl as never, fakeToken)!
    const result = await suggestTheoryMarksViaProxy(client, 'school-1', 'Test', 'English', 'JSS 1', qs)
    expect(result.marks.q1).toBe(4)
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://proxy.example/ai/mark-theory')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer firebase-token-not-real')
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.schoolId).toBe('school-1')
    expect(body.questions[0].text).toBe('Explain.')
    expect(body).not.toHaveProperty('prompt')
    expect(JSON.stringify(body)).not.toContain('api.meta.ai')
  })

  it('maps 401 to not-configured, 403 to permission, 429 to try-later', async () => {
    const mk = (status: number) => {
      const calls: FakeInit[] = []
      return createProxyClient('https://proxy.example', fakeFetchFactory(status, { error: 'x' }, calls) as never, fakeToken)!
    }
    await expect(suggestTheoryMarksViaProxy(mk(401), 'school-1', 'T', 'E', 'J', qs)).rejects.toMatchObject({ kind: 'not-configured' })
    await expect(suggestTheoryMarksViaProxy(mk(403), 'school-1', 'T', 'E', 'J', qs)).rejects.toThrow(/permission/)
    await expect(suggestTheoryMarksViaProxy(mk(429), 'school-1', 'T', 'E', 'J', qs)).rejects.toThrow(/later/)
  })

  it('throws not-configured when the client is null (URL unset)', async () => {
    await expect(suggestTheoryMarksViaProxy(null, 'school-1', 'T', 'E', 'J', qs)).rejects.toThrow(AiError)
    await expect(suggestTheoryMarksViaProxy(null, 'school-1', 'T', 'E', 'J', qs)).rejects.toThrow(/not set up/)
  })

  it('arrange wrapper validates empty pastes before calling', async () => {
    const calls: FakeInit[] = []
    const client = createProxyClient('https://proxy.example', fakeFetchFactory(200, { text: '{}' }, calls) as never, fakeToken)!
    await expect(arrangeBulkExamViaProxy(client, 'school-1', '', '  ')).rejects.toThrow(/Paste at least one question/)
    expect(calls.length).toBe(0)
  })

  it('practice wrapper parses a generated set from the proxy', async () => {
    const calls: FakeInit[] = []
    const text = '{"questions":[{"kind":"objective","text":"2+2?","options":["3","4","5","6"],"answerIndex":1,"marks":2,"rubric":""}]}'
    const client = createProxyClient('https://proxy.example', fakeFetchFactory(200, { text }, calls) as never, fakeToken)!
    const set = await generatePracticeViaProxy(client, 'school-1', 'Mathematics', 'Primary 4', 'Numbers', 1)
    expect(set.questions.length).toBe(1)
    expect(set.questions[0].answerIndex).toBe(1)
    expect(calls[0].url).toBe('https://proxy.example/ai/practice-generate')
  })
})
