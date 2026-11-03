/**
 * Bulk exam import, built 2026-10-26.
 *
 * The teacher pastes a whole objective question-and-answer sheet into one
 * space and the theory questions, as written, into another. The model only
 * arranges that pasted text into the slots the exam already uses
 * (question, four options, correct answer, marks; theory question, marks,
 * and marking guide). It never writes the exam's marks and it never marks
 * a student's work: objective marking stays with the existing system
 * code, and nothing arranged here is saved until the teacher has checked
 * it in the preview and confirmed it.
 *
 * Safety rules, enforced by the pure functions in this module:
 * - Nothing is dropped silently: every numbered item the model returns is
 *   kept, even when it is incomplete, and incomplete items are flagged.
 * - A correct answer is never guessed: when the model cannot identify
 *   one, answerIndex is null and the item is flagged for the teacher.
 * - Theory wording is kept exactly as pasted (only leading/trailing
 *   blank space is trimmed). The model is told not to rewrite it, and
 *   this module never rewrites it either.
 * - Theory model answers, when pasted, go into the marking guide only.
 *   That guide is teacher-only today and is never shown to students.
 * - No secret of any kind lives in this module.
 */

import { AiError, extractJson, type AiProvider } from './aiSpark'

export interface ArrangedObjective {
  number: number
  text: string
  options: string[]
  answerIndex: number | null
  marks: number
  needsCheck: boolean
  checkReason: string
}

export interface ArrangedTheory {
  number: number
  text: string
  maxMarks: number
  rubric: string
  needsCheck: boolean
  checkReason: string
}

export interface ArrangedExam {
  objective: ArrangedObjective[]
  theory: ArrangedTheory[]
}

interface RawObjective {
  number?: unknown
  text?: unknown
  options?: unknown
  answerIndex?: unknown
  marks?: unknown
  needsCheck?: unknown
  checkReason?: unknown
}

interface RawTheory {
  number?: unknown
  text?: unknown
  maxMarks?: unknown
  rubric?: unknown
  needsCheck?: unknown
  checkReason?: unknown
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function cleanText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function positiveMarks(v: unknown, fallback: number): number {
  return isFiniteNumber(v) && (v as number) > 0 ? (v as number) : fallback
}

/** Build the prompt that asks the model to arrange a paste, not to write or mark anything. */
export function buildBulkExamPrompt(objectivePaste: string, theoryPaste: string): string {
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

/** Re-check one arranged objective item after the teacher edits it in the preview. */
export function refreshObjectiveCheck(q: ArrangedObjective): ArrangedObjective {
  const reasons: string[] = []
  if (!q.text.trim()) reasons.push('The question text is empty.')
  const emptyOptions = q.options.filter(o => !o.trim()).length
  if (q.options.length !== 4) reasons.push('This question does not have 4 options yet.')
  else if (emptyOptions) reasons.push(`${emptyOptions} option${emptyOptions === 1 ? ' is' : 's are'} empty.`)
  if (q.answerIndex === null || q.answerIndex < 0 || q.answerIndex > 3) reasons.push('The correct answer has not been chosen yet.')
  if (!(q.marks > 0)) reasons.push('The marks must be more than 0.')
  const kept = q.checkReason && !reasons.length ? '' : q.checkReason
  // Keep a model-supplied reason only while the item still needs a check;
  // a fully fixed item must not stay flagged by an old reason.
  return { ...q, needsCheck: reasons.length > 0, checkReason: reasons.length ? reasons.join(' ') : kept }
}

/** Re-check one arranged theory item after the teacher edits it in the preview. */
export function refreshTheoryCheck(q: ArrangedTheory): ArrangedTheory {
  const reasons: string[] = []
  if (!q.text.trim()) reasons.push('The question text is empty.')
  if (!(q.maxMarks > 0)) reasons.push('The marks must be more than 0.')
  return { ...q, needsCheck: reasons.length > 0, checkReason: reasons.length ? reasons.join(' ') : (reasons.length ? q.checkReason : '') }
}

function validateObjective(raw: RawObjective, fallbackNumber: number): ArrangedObjective {
  const reasons: string[] = []
  const text = cleanText(raw.text)
  if (!text) reasons.push('The question text is empty.')
  const rawOptions = Array.isArray(raw.options)
    ? raw.options.filter((o): o is string => typeof o === 'string').map(o => o.trim())
    : []
  if (rawOptions.length < 4) reasons.push(`Only ${rawOptions.length} option${rawOptions.length === 1 ? '' : 's'} were found; this question needs 4.`)
  if (rawOptions.length > 4) reasons.push('More than 4 options were found; the extra options were left off for you to check.')
  const options = rawOptions.slice(0, 4)
  while (options.length < 4) options.push('')
  const emptyOptions = options.filter(o => !o).length
  if (emptyOptions) reasons.push(`${emptyOptions} option${emptyOptions === 1 ? ' is' : 's are'} empty.`)
  const answerIndex = isFiniteNumber(raw.answerIndex) && (raw.answerIndex as number) >= 0 && (raw.answerIndex as number) <= 3
    ? (raw.answerIndex as number)
    : null
  if (answerIndex === null) reasons.push('The correct answer could not be identified — choose it in the preview.')
  const modelReason = cleanText(raw.checkReason)
  if (modelReason) reasons.push(modelReason)
  const needsCheck = raw.needsCheck === true || reasons.length > 0
  return {
    number: isFiniteNumber(raw.number) ? (raw.number as number) : fallbackNumber,
    text,
    options,
    answerIndex,
    marks: positiveMarks(raw.marks, 5),
    needsCheck,
    checkReason: reasons.join(' '),
  }
}

function validateTheory(raw: RawTheory, fallbackNumber: number): ArrangedTheory {
  const reasons: string[] = []
  const text = cleanText(raw.text)
  if (!text) reasons.push('The question text is empty.')
  const modelReason = cleanText(raw.checkReason)
  if (modelReason) reasons.push(modelReason)
  return {
    number: isFiniteNumber(raw.number) ? (raw.number as number) : fallbackNumber,
    text,
    maxMarks: positiveMarks(raw.maxMarks, 5),
    rubric: cleanText(raw.rubric),
    needsCheck: raw.needsCheck === true || reasons.length > 0,
    checkReason: reasons.join(' '),
  }
}

/** Validate a parsed arranged result. Never drops an item; incomplete items are flagged. */
export function validateArrangedExam(data: unknown): ArrangedExam {
  const src = (data ?? {}) as { objective?: unknown; theory?: unknown }
  const objectiveRaw = Array.isArray(src.objective) ? (src.objective as RawObjective[]) : []
  const theoryRaw = Array.isArray(src.theory) ? (src.theory as RawTheory[]) : []
  const objective = objectiveRaw.map((q, i) => validateObjective(q ?? {}, i + 1))
  const theory = theoryRaw.map((q, i) => validateTheory(q ?? {}, i + 1))
  // Flag repeated numbers, which usually mean two questions were merged or split wrongly.
  const seenObj = new Set<number>()
  for (const q of objective) {
    if (seenObj.has(q.number)) {
      q.needsCheck = true
      q.checkReason = `${q.checkReason} This question number appears more than once — check it was not split or merged wrongly.`.trim()
    }
    seenObj.add(q.number)
  }
  const seenTh = new Set<number>()
  for (const q of theory) {
    if (seenTh.has(q.number)) {
      q.needsCheck = true
      q.checkReason = `${q.checkReason} This question number appears more than once — check it was not split or merged wrongly.`.trim()
    }
    seenTh.add(q.number)
  }
  return { objective, theory }
}

/** Parse a model reply into a validated arranged result. Throws a plain-language error on bad output. */
export function parseBulkExamResponse(rawText: string): ArrangedExam {
  let data: unknown
  try {
    data = extractJson(rawText)
  } catch {
    throw new AiError('parse', 'The arranged questions were not in a readable form. Your pasted text is still there — try arranging it again, or enter the questions one by one.')
  }
  if (!data || typeof data !== 'object') {
    throw new AiError('parse', 'The arranged questions were not in a readable form. Your pasted text is still there — try arranging it again, or enter the questions one by one.')
  }
  const result = validateArrangedExam(data)
  if (!result.objective.length && !result.theory.length) {
    throw new AiError('parse', 'No questions could be arranged from that paste. Check the paste is complete and neatly typed, then try again, or enter the questions one by one.')
  }
  return result
}

function isOnline(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false
  } catch {
    return true
  }
}

/**
 * Arrange a paste with the existing model path. A full exam needs far more
 * output than a short reply, so this uses 8192 tokens, not the 2048 used
 * for short marking and practice replies.
 */
export async function arrangeBulkExam(
  provider: AiProvider | null,
  objectivePaste: string,
  theoryPaste: string,
): Promise<ArrangedExam> {
  if (!provider) throw new AiError('not-configured', 'Arranging with AI is not set up on this device. Enter the questions one by one, or set up arranging on this device first.')
  if (!isOnline()) throw new AiError('offline', 'You are offline. Connect to the internet and try arranging again, or enter the questions one by one.')
  if (!objectivePaste.trim() && !theoryPaste.trim()) throw new AiError('validation', 'Paste at least one question first.')
  const prompt = buildBulkExamPrompt(objectivePaste, theoryPaste)
  const { text } = await provider.complete(prompt, 'You are arranging a teacher\'s own exam questions into slots. Keep every question, keep theory wording exact, never guess a correct answer, and return JSON only.', 8192)
  return parseBulkExamResponse(text)
}
