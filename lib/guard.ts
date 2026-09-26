import type {TextStreamPart, ToolSet} from 'ai'
import type {HeaderPin, StackReport} from './stack.ts'

export const VERDICT_LABEL: Record<StackReport['verdict'], string> = {
  stacks: 'Stacks',
  'stacks-with-changes': 'Stacks with changes',
  conflicts: 'Conflicts',
  incomplete: 'Incomplete',
}
const LABEL_TO_VERDICT = new Map(Object.entries(VERDICT_LABEL).map(([v, l]) => [l.toLowerCase(), v as StackReport['verdict']]))

// The first bold phrase, normalised: "**Stacks with changes**:" → "stacks with changes".
export const firstBold = (t: string) => (t.match(/\*\*([^*]+)\*\*/)?.[1] ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()

// The subset of runCheck()'s result the guard relies on.
export type CheckedStack = {report: StackReport; pi?: {name: string}; header?: HeaderPin[]; unknownBoards?: string[]}

export const UNVERIFIED =
  "**Not verified**\n\nI only answer whether specific Raspberry Pi add-on boards can share a header, and only after the stack checker has run on exactly those boards. That didn't happen for this answer, so nothing here is verified. Name the boards (and your Pi model) and ask again, or use **Check a stack directly** below, which runs the checker without the model."

const checkedLine = (c: CheckedStack) => `_Checked with the stack checker: ${c.report.boards.join(' + ') || 'no boards'}${c.pi ? ` on ${c.pi.name}` : ''} → ${VERDICT_LABEL[c.report.verdict]}._`

// An answer built only from the check result, for when the model's own answer can't be trusted.
export function answerFromCheck(c: CheckedStack): string {
  const bcm = new Map((c.header ?? []).map((h) => [h.physical, h.bcm]))
  const pin = (n?: number) => (n ? `Physical pin ${n}${bcm.get(n) != null ? ` (GPIO ${bcm.get(n)})` : ''}` : '')
  const lines = c.report.issues.map((i) => {
    const what = i.kind === 'pin' ? pin(i.pin) : i.kind === 'i2c' ? `I2C address ${i.address}` : i.kind === 'eeprom' ? 'HAT ID EEPROM' : `${pin(i.pin)} function`
    return `- **${what}** (${i.severity}): ${i.detail}${i.fix ? ` Fix: ${i.fix}` : ''}`
  })
  return [
    `**${VERDICT_LABEL[c.report.verdict]}** for ${c.report.boards.join(' + ') || 'no known boards'}${c.pi ? ` on ${c.pi.name}` : ''}.`,
    lines.length ? lines.join('\n') : 'No header pin, I2C address or HAT EEPROM collisions in the data.',
    ...c.report.notes.map((n) => `- ${n}`),
  ].join('\n\n')
}

export type GuardStatus = 'ok' | 'unverified' | 'replaced'

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
// The "Checked with" line is the guard's to write. In a follow-up question the model sees it in the history
// and can imitate it, possibly naming a different check, so any copy in the model's text is dropped.
const dropCheckedLines = (t: string) => t.replace(/^.*Checked with the stack checker.*$/gim, '').replace(/\n{3,}/g, '\n\n').trim()

/**
 * Fail closed. `check` is the result of the most recent check_stack call, or null if there was none,
 * or it failed, or it never finished.
 * - no valid check → the fixed UNVERIFIED answer, whatever the model wrote
 * - the model's answer is complete, its verdict label matches the check, and it names every checked board
 *   → its answer, plus a line naming exactly what was checked
 * - anything else (wrong or missing label, other boards, cut off) → an answer built from the check alone
 */
export function guardAnswer(text: string, check: CheckedStack | null, opts: {truncated?: boolean} = {}): {text: string; status: GuardStatus} {
  if (!check) return {text: UNVERIFIED, status: 'unverified'}
  text = dropCheckedLines(text)
  const labelMatches = LABEL_TO_VERDICT.get(firstBold(text)) === check.report.verdict
  const words = ` ${squash(text)} `
  const namesBoards = check.report.boards.every((b) => words.includes(` ${squash(b)} `))
  if (labelMatches && namesBoards && !opts.truncated) return {text: `${text.trim()}\n\n${checkedLine(check)}`, status: 'ok'}
  const why = opts.truncated ? 'was cut off' : !labelMatches ? "didn't match the stack check" : "didn't name the boards that were checked"
  return {text: `${answerFromCheck(check)}\n\n_The model's explanation ${why}, so this answer comes from the check alone._`, status: 'replaced'}
}

type Streamed = {stream: AsyncIterable<TextStreamPart<ToolSet>>; steps: PromiseLike<unknown>; totalUsage: PromiseLike<unknown>}

/**
 * Wraps a streamText result. Tool calls and results pass straight through (so the UI shows progress),
 * but answer text is held until the run finishes and then released through guardAnswer().
 * Only the latest check_stack call counts: starting a new one voids the previous result, and if that
 * latest call fails or never finishes, nothing is verified. Results and errors of earlier calls are ignored.
 */
export function guard<R extends Streamed>(result: R) {
  let settle!: (v: {text: string; status: GuardStatus | 'error'}) => void
  const outcome = new Promise<{text: string; status: GuardStatus | 'error'}>((r) => (settle = r))
  const stream = new ReadableStream<TextStreamPart<ToolSet>>({
    async start(controller) {
      let text = ''
      let latest: {callId: string; result: CheckedStack | null} | null = null
      let heldFinishStep: TextStreamPart<ToolSet> | undefined
      try {
        for await (const part of result.stream) {
          if (part.type === 'text-start' && text) text += '\n\n'
          if (part.type === 'text-delta') text += part.text
          if (part.type === 'text-start' || part.type === 'text-delta' || part.type === 'text-end') continue
          if (part.type === 'tool-call' && part.toolName === 'check_stack') latest = {callId: part.toolCallId, result: null}
          if (part.type === 'tool-result' && part.toolName === 'check_stack' && latest?.callId === part.toolCallId) {
            const out = part.output as CheckedStack | undefined
            latest = {callId: part.toolCallId, result: out?.report?.verdict ? out : null}
          }
          if (part.type === 'tool-error' && part.toolName === 'check_stack' && latest?.callId === part.toolCallId) latest = {callId: part.toolCallId, result: null}
          // Hold each finish-step until we know whether another step follows, so the answer lands inside the last step.
          if (heldFinishStep && part.type !== 'finish') controller.enqueue(heldFinishStep), (heldFinishStep = undefined)
          if (part.type === 'finish-step') {
            heldFinishStep = part
            continue
          }
          if (part.type === 'finish') {
            const g = guardAnswer(text, latest?.result ?? null, {truncated: part.finishReason === 'length'})
            controller.enqueue({type: 'text-start', id: 'answer'})
            controller.enqueue({type: 'text-delta', id: 'answer', text: g.text})
            controller.enqueue({type: 'text-end', id: 'answer'})
            if (heldFinishStep) controller.enqueue(heldFinishStep), (heldFinishStep = undefined)
            settle(g)
          }
          controller.enqueue(part)
        }
        settle({text: '', status: 'error'}) // no-op if the finish part already settled it
        controller.close()
      } catch (e) {
        settle({text: '', status: 'error'})
        controller.error(e)
      }
    },
  })
  // StreamTextResult exposes steps/totalUsage as getters, so they are passed on explicitly.
  return {stream, steps: result.steps as R['steps'], totalUsage: result.totalUsage as R['totalUsage'], text: outcome.then((o) => o.text), guardStatus: outcome.then((o) => o.status)}
}
