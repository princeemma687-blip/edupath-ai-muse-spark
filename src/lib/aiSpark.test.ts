import { describe, it, expect } from 'vitest'
import {
  AiError, buildTheoryMarkingPrompt, buildPracticePrompt, buildPracticeMarkingPrompt,
  extractJson, parseTheoryMarks, parseFeedback, parsePracticeSet, parsePracticeMarks,
  validateAiMarks, estimateCostUsd,
  suggestTheoryMarks, generatePractice, markPractice,
  type TheoryQuestionInput, type PracticeSet, type AiProvider,
} from './aiSpark'

const qs = [
  { id: 'th1', text: 'Explain photosynthesis.', maxMarks: 5, rubric: 'sunlight, chlorophyll, oxygen', answer: 'Plants use sunlight.' },
  { id: 'th2', text: 'Name two parts of a flower.', maxMarks: 4, rubric: 'petal, sepal', answer: 'Petal and sepal.' },
] satisfies TheoryQuestionInput[]

describe('prompt building', () => {
  it('includes every question, guide, answer and maximum', () => {
    const p = buildTheoryMarkingPrompt('Science Test', 'Basic Science', 'JSS 1', qs)
    expect(p).toContain('photosynthesis')
    expect(p).toContain('sunlight, chlorophyll, oxygen')
    expect(p).toContain('Plants use sunlight.')
    expect(p).toContain('maximum 5 marks')
    expect(p).toContain('JSON only')
  })
  it('practice prompt clamps count to 1..10 and asks for JSON', () => {
    expect(buildPracticePrompt('Mathematics', 'Primary 4', 'Fractions', 99)).toContain('10 practice questions')
    expect(buildPracticePrompt('Mathematics', 'Primary 4', '', 0)).toContain('1 practice question')
    expect(buildPracticePrompt('Mathematics', 'Primary 4', 'Fractions', 5)).toContain('Fractions')
  })
  it('practice marking prompt includes the student answer and the correct option', () => {
    const set: PracticeSet = {
      subject: 'Mathematics', className: 'Primary 4', topic: 'Fractions',
      questions: [{ id: 'pq1', kind: 'objective', text: 'What is 1/2 + 1/2?', options: ['0', '1', '2', '3'], answerIndex: 1, marks: 2, rubric: '' }],
    }
    const p = buildPracticeMarkingPrompt(set, { pq1: 1 })
    expect(p).toContain('1/2 + 1/2')
    expect(p).toContain('Correct option: B')
  })
})

describe('JSON extraction', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('strips code fences and surrounding prose', () => {
    expect(extractJson('Here you go:\n```json\n{"a":2}\n```\nDone.')).toEqual({ a: 2 })
  })
  it('throws AiError on empty or non-JSON text', () => {
    expect(() => extractJson('')).toThrow(AiError)
    expect(() => extractJson('no json here')).toThrow(AiError)
  })
})

describe('theory mark parsing and validation', () => {
  const good = '{"marks":[{"questionId":"th1","marks":4,"feedback":"Good start, add oxygen."},{"questionId":"th2","marks":3,"feedback":"Both parts named."}]}'
  it('parses marks, feedback and total', () => {
    const r = parseTheoryMarks(good, qs)
    expect(r.marks).toEqual({ th1: 4, th2: 3 })
    expect(r.total).toBe(7)
    expect(r.feedback.th1).toMatch(/Good start/)
    expect(r.warnings).toEqual([])
  })
  it('clamps over-maximum and negative marks, never invents a total above the maximum', () => {
    const r = parseTheoryMarks('{"marks":[{"questionId":"th1","marks":99,"feedback":"x"},{"questionId":"th2","marks":-2,"feedback":"y"}]}', qs)
    expect(r.marks).toEqual({ th1: 5, th2: 0 })
    expect(r.total).toBe(5)
    expect(r.warnings.length).toBe(2)
  })
  it('missing mark becomes 0 with a warning, not a silent pass', () => {
    const r = parseTheoryMarks('{"marks":[{"questionId":"th1","marks":4,"feedback":"x"}]}', qs)
    expect(r.marks.th2).toBe(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('throws on a reply with no marks array', () => {
    expect(() => parseTheoryMarks('{"hello":"world"}', qs)).toThrow(AiError)
  })
  it('validateAiMarks clamps and warns, and never returns a negative or over-max mark', () => {
    const { marks, warnings } = validateAiMarks({ th1: 99, th2: -1 }, qs)
    expect(marks).toEqual({ th1: 5, th2: 0 })
    expect(warnings).toHaveLength(2)
    const { marks: m2 } = validateAiMarks({ th1: Number.NaN }, qs)
    expect(m2.th1).toBe(0)
  })
})

describe('feedback parsing', () => {
  it('returns feedback per question id', () => {
    const f = parseFeedback('{"feedback":{"th1":"Well done.","th2":"Add more detail."}}', ['th1', 'th2'])
    const f2 = parseFeedback('{"feedback":[{"questionId":"th1","feedback":"Lovely clear explanation."},{"questionId":"th2","feedback":"Perfect work!"}]}', ['th1', 'th2'])
    expect(f2).toEqual({ th1: 'Lovely clear explanation.', th2: 'Perfect work!' })
    expect(f).toEqual({ th1: 'Well done.', th2: 'Add more detail.' })
  })
  it('throws on a reply with no feedback object', () => {
    expect(() => parseFeedback('{"marks":[]}', ['th1'])).toThrow(AiError)
  })
})

describe('practice parsing', () => {
  it('parses a mixed objective and theory set', () => {
    const set = parsePracticeSet('{"questions":[{"kind":"objective","text":"2+2?","options":["3","4","5","6"],"answerIndex":1,"marks":2,"rubric":""},{"kind":"theory","text":"Explain water.","options":[],"answerIndex":null,"marks":5,"rubric":"evaporation"}]}', 'Mathematics', 'Primary 4', 'Numbers')
    expect(set.questions).toHaveLength(2)
    expect(set.questions[0]).toMatchObject({ kind: 'objective', answerIndex: 1, marks: 2 })
    expect(set.questions[1]).toMatchObject({ kind: 'theory', marks: 5, rubric: 'evaporation' })
    expect(set.subject).toBe('Mathematics')
  })
  it('throws on an empty question list', () => {
    expect(() => parsePracticeSet('{"questions":[]}', 'Mathematics', 'Primary 4', '')).toThrow(AiError)
  })
  it('practice marks clamp and total correctly, and never exceed the set maximum', () => {
    const set: PracticeSet = {
      subject: 'Mathematics', className: 'Primary 4', topic: '',
      questions: [
        { id: 'pq1', kind: 'objective', text: '2+2?', options: ['3', '4', '5', '6'], answerIndex: 1, marks: 2, rubric: '' },
        { id: 'pq2', kind: 'theory', text: 'Explain water.', options: [], answerIndex: null, marks: 5, rubric: 'evaporation' },
      ],
    }
    const r = parsePracticeMarks('{"marks":[{"questionId":"pq1","marks":99,"feedback":"Correct."},{"questionId":"pq2","marks":3,"feedback":"Partly right."}]}', set.questions)
    expect(r.marks[0].marks).toBe(2)
    expect(r.total).toBe(5)
    expect(r.maxTotal).toBe(7)
  })
})

describe('live budget: marking and generation request 2048 tokens', () => {
  it('suggestTheoryMarks, generatePractice and markPractice all request 2048', async () => {
    const seen: number[] = []
    const fake: AiProvider = {
      complete: async (prompt: string, _system: string, maxTokens: number) => {
        seen.push(maxTokens)
        if (prompt.includes('practice questions')) return { text: '{"questions":[{"kind":"objective","text":"2+2?","options":["3","4","5","6"],"answerIndex":1,"marks":2,"rubric":""}]}' }
        if (prompt.includes('practice attempt')) return { text: '{"marks":[{"questionId":"pq1","marks":2,"feedback":"Correct."}]}' }
        return { text: '{"marks":[{"questionId":"th1","marks":4,"feedback":"Good."},{"questionId":"th2","marks":3,"feedback":"Good."}]}' }
      },
    }
    await suggestTheoryMarks(fake, 'Test', 'Basic Science', 'JSS 1', qs)
    const set = await generatePractice(fake, 'Mathematics', 'Primary 4', 'Numbers', 1)
    await markPractice(fake, set, { pq1: 1 })
    expect(seen).toEqual([2048, 2048, 2048])
  })
})

describe('cost estimate', () => {
  it('matches Standard rates', () => {
    expect(estimateCostUsd(1_000_000, 0)).toBeCloseTo(1.25, 6)
    expect(estimateCostUsd(0, 1_000_000)).toBeCloseTo(4.25, 6)
  })
})
