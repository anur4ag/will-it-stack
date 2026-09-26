import type {TextStreamPart, ToolSet} from 'ai'
import type {StackReport} from './stack.ts'

export const VERDICT_LABEL: Record<StackReport['verdict'], string> = {
  stacks: 'Stacks',
  'stacks-with-changes': 'Stacks with changes',
  conflicts: 'Conflicts',
  incomplete: 'Incomplete',
}
const LABEL_TO_VERDICT = new Map(Object.entries(VERDICT_LABEL).map(([v, l]) => [l.toLowerCase(), v as StackReport['verdict']]))

// The first bold phrase, normalised: "**Stacks with changes**:" → "stacks with changes".
export const firstBold = (t: string) => (t.match(/\*\*([^*]+)\*\*/)?.[1] ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
const SOUNDS_LIKE_A_VERDICT = /\b(compatible|can be stacked|will stack|stack(s)? (fine|together|without)|no (pin )?conflicts?)\b/i

export const UNVERIFIED =
  "**Not verified**\n\nThe stack checker didn't return a result for this question, so I can't say whether these boards fit together. Try asking again, or use **Check a stack directly** below, which runs the checker without the model."

/**
 * The model may only state a verdict that a successful check_stack result backs up.
 * - verdict (or compatibility language) with no successful check → replaced by UNVERIFIED
 * - verdict that contradicts the last check → the verdict line is corrected to the checker's
 */
export function guardAnswer(text: string, checks: StackReport['verdict'][]): {text: string; status: 'ok' | 'unverified' | 'corrected'} {
  const claimed = LABEL_TO_VERDICT.get(firstBold(text))
  const last = checks.at(-1)
  if (!last) return claimed || SOUNDS_LIKE_A_VERDICT.test(text) ? {text: UNVERIFIED, status: 'unverified'} : {text, status: 'ok'}
  if (claimed === last) return {text, status: 'ok'}
  const body = claimed ? text.replace(/\*\*[^*]+\*\*/, '') : text
  return {text: `**${VERDICT_LABEL[last]}**${body.startsWith('\n') ? '' : '\n\n'}${body.trimStart()}\n\n_The verdict line was set from the stack check; the model's own summary disagreed._`, status: 'corrected'}
}

type Streamed = {stream: AsyncIterable<TextStreamPart<ToolSet>>; steps: PromiseLike<unknown>; totalUsage: PromiseLike<unknown>}

/**
 * Wraps a streamText result. Tool calls and results pass straight through (so the UI shows progress),
 * but answer text is held until the run finishes and then released through guardAnswer().
 */
export function guard<R extends Streamed>(result: R) {
  let settle!: (v: {text: string; status: 'ok' | 'unverified' | 'corrected' | 'error'}) => void
  const outcome = new Promise<{text: string; status: 'ok' | 'unverified' | 'corrected' | 'error'}>((r) => (settle = r))
  const stream = new ReadableStream<TextStreamPart<ToolSet>>({
    async start(controller) {
      let text = ''
      const checks: StackReport['verdict'][] = []
      let heldFinishStep: TextStreamPart<ToolSet> | undefined
      try {
        for await (const part of result.stream) {
          if (part.type === 'text-start' && text) text += '\n\n'
          if (part.type === 'text-delta') text += part.text
          if (part.type === 'text-start' || part.type === 'text-delta' || part.type === 'text-end') continue
          if (part.type === 'tool-result' && part.toolName === 'check_stack') {
            const verdict = (part.output as {report?: StackReport} | undefined)?.report?.verdict
            if (verdict) checks.push(verdict)
          }
          // Hold each finish-step until we know whether another step follows, so the answer lands inside the last step.
          if (heldFinishStep && part.type !== 'finish') controller.enqueue(heldFinishStep), (heldFinishStep = undefined)
          if (part.type === 'finish-step') {
            heldFinishStep = part
            continue
          }
          if (part.type === 'finish') {
            const g = guardAnswer(text, checks)
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
