import { describe, it, expect } from 'vitest'
import {
  buildBulkExamPrompt,
  parseBulkExamResponse,
  validateArrangedExam,
  refreshObjectiveCheck,
  refreshTheoryCheck,
  arrangeBulkExam,
} from './bulkExam'

const validReply = JSON.stringify({
  objective: [
    { number: 1, text: 'What is 2 + 3?', options: ['4', '5', '6', '7'], answerIndex: 1, marks: 5, needsCheck: false, checkReason: '' },
    { number: 2, text: 'Which gas do plants use?', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'], answerIndex: 1, marks: 10, needsCheck: false, checkReason: '' },
  ],
  theory: [
    { number: 1, text: 'Explain photosynthesis in your own words. (10 marks)', maxMarks: 10, rubric: 'A good answer mentions sunlight, chlorophyll and glucose.', needsCheck: false, checkReason: '' },
  ],
})

describe('bulk exam prompt', () => {
  it('tells the model to keep theory wording exact and never guess an answer', () => {
    const prompt = buildBulkExamPrompt('1. What is 2+3? A. 4 B. 5 Answer: B', 'Explain photosynthesis.')
    expect(prompt).toContain('word for word')
    expect(prompt).toContain('Never guess a correct answer')
    expect(prompt).toContain('Never drop a question')
    expect(prompt).toContain('1. What is 2+3?')
    expect(prompt).toContain('Explain photosynthesis.')
  })
})

describe('bulk exam response parsing', () => {
  it('parses a valid arranged reply, keeping stated marks', () => {
    const out = parseBulkExamResponse(validReply)
    expect(out.objective).toHaveLength(2)
    expect(out.objective[0].answerIndex).toBe(1)
    expect(out.objective[1].marks).toBe(10)
    expect(out.objective[0].needsCheck).toBe(false)
    expect(out.theory[0].maxMarks).toBe(10)
  })

  it('keeps theory text exactly as given, without rewriting it', () => {
    const out = parseBulkExamResponse(validReply)
    expect(out.theory[0].text).toBe('Explain photosynthesis in your own words. (10 marks)')
  })

  it('accepts a fenced reply', () => {
    const out = parseBulkExamResponse('```json\n' + validReply + '\n```')
    expect(out.objective).toHaveLength(2)
  })

  it('defaults marks to 5 when none are stated', () => {
    const out = parseBulkExamResponse(JSON.stringify({
      objective: [{ number: 1, text: 'Q?', options: ['a', 'b', 'c', 'd'], answerIndex: 0 }],
      theory: [{ number: 1, text: 'T?', rubric: '' }],
    }))
    expect(out.objective[0].marks).toBe(5)
    expect(out.theory[0].maxMarks).toBe(5)
  })

  it('flags an objective question with fewer than 4 options and pads the slots for editing', () => {
    const out = parseBulkExamResponse(JSON.stringify({
      objective: [{ number: 1, text: 'Q?', options: ['a', 'b'], answerIndex: 0, marks: 5 }],
      theory: [],
    }))
    expect(out.objective[0].options).toHaveLength(4)
    expect(out.objective[0].needsCheck).toBe(true)
    expect(out.objective[0].checkReason).toMatch(/2 option/)
  })

  it('never guesses a correct answer: a missing or out-of-range answer is flagged, not defaulted', () => {
    const out = parseBulkExamResponse(JSON.stringify({
      objective: [
        { number: 1, text: 'Q1?', options: ['a', 'b', 'c', 'd'], answerIndex: null, marks: 5 },
        { number: 2, text: 'Q2?', options: ['a', 'b', 'c', 'd'], answerIndex: 9, marks: 5 },
      ],
      theory: [],
    }))
    expect(out.objective[0].answerIndex).toBeNull()
    expect(out.objective[0].needsCheck).toBe(true)
    expect(out.objective[1].answerIndex).toBeNull()
    expect(out.objective[1].needsCheck).toBe(true)
    expect(out.objective[1].checkReason).toMatch(/correct answer could not be identified/)
  })

  it('flags empty question text and repeated numbers instead of dropping them', () => {
    const out = validateArrangedExam({
      objective: [
        { number: 1, text: '', options: ['a', 'b', 'c', 'd'], answerIndex: 0, marks: 5 },
        { number: 1, text: 'Q?', options: ['a', 'b', 'c', 'd'], answerIndex: 0, marks: 5 },
      ],
      theory: [],
    })
    expect(out.objective).toHaveLength(2)
    expect(out.objective[0].needsCheck).toBe(true)
    expect(out.objective[1].checkReason).toMatch(/more than once/)
  })

  it('rejects unreadable output and empty results in plain language', () => {
    expect(() => parseBulkExamResponse('not a reply at all')).toThrow(/not in a readable form/)
    expect(() => parseBulkExamResponse(JSON.stringify({ objective: [], theory: [] }))).toThrow(/No questions could be arranged/)
  })

  it('accepts an answer-key style reply (numbers matched to letters) when the model has already matched them', () => {
    const out = parseBulkExamResponse(JSON.stringify({
      objective: [
        { number: 1, text: 'First?', options: ['a', 'b', 'c', 'd'], answerIndex: 1, marks: 5 },
        { number: 2, text: 'Second?', options: ['a', 'b', 'c', 'd'], answerIndex: 0, marks: 5 },
      ],
      theory: [],
    }))
    expect(out.objective.map(q => q.answerIndex)).toEqual([1, 0])
    expect(out.objective.every(q => !q.needsCheck)).toBe(true)
  })
})

describe('preview re-checking after teacher edits', () => {
  it('clears the flag once the teacher fixes every problem', () => {
    const fixed = refreshObjectiveCheck({
      number: 1, text: 'Q?', options: ['a', 'b', 'c', 'd'], answerIndex: 2, marks: 5,
      needsCheck: true, checkReason: 'The correct answer could not be identified — choose it in the preview.',
    })
    expect(fixed.needsCheck).toBe(false)
    expect(fixed.checkReason).toBe('')
  })

  it('keeps the flag while an option is still empty or no answer is chosen', () => {
    const still = refreshObjectiveCheck({
      number: 1, text: 'Q?', options: ['a', '', 'c', 'd'], answerIndex: null, marks: 5,
      needsCheck: true, checkReason: '',
    })
    expect(still.needsCheck).toBe(true)
    expect(still.checkReason).toMatch(/empty/)
    expect(still.checkReason).toMatch(/correct answer has not been chosen/)
  })

  it('flags empty theory text', () => {
    const out = refreshTheoryCheck({ number: 1, text: '  ', maxMarks: 5, rubric: '', needsCheck: false, checkReason: '' })
    expect(out.needsCheck).toBe(true)
  })
})

describe('arrangeBulkExam with an injected provider', () => {
  it('uses the provider and returns validated questions', async () => {
    const provider = { complete: async () => ({ text: validReply }) }
    const out = await arrangeBulkExam(provider, 'paste', '')
    expect(out.objective).toHaveLength(2)
    expect(out.theory).toHaveLength(1)
  })

  it('refuses without a provider, keeping the paste for the manual form', async () => {
    await expect(arrangeBulkExam(null, 'paste', '')).rejects.toThrow(/not set up on this device/)
  })

  it('refuses an empty paste', async () => {
    const provider = { complete: async () => ({ text: validReply }) }
    await expect(arrangeBulkExam(provider, '  ', ' ')).rejects.toThrow(/Paste at least one question/)
  })
})
