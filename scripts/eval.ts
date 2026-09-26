// Small end-to-end eval of the agent. Ground truth for each stack comes from the deterministic checker,
// so this measures whether the agent finds the right boards, calls the check, reports its verdict
// faithfully and reads the Knowledge Base. Usage: node --env-file=.env.local scripts/eval.ts
import {writeFileSync, mkdirSync} from 'node:fs'
import {runAgent} from '../lib/agent.ts'
import {MODEL} from '../lib/model.ts'
import {runCheck} from '../lib/sanity.ts'

const CASES: {q: string; boards?: string[]; pi?: string; offTopic?: boolean}[] = [
  {q: 'Can I use a Sense HAT and an Enviro pHAT together on a Raspberry Pi 5?', boards: ['sense-hat', 'enviro-phat']},
  {q: 'Will a Unicorn HAT work alongside a Pirate Audio Speaker?', boards: ['unicorn-hat', 'pimoroni-pirate-audio-speaker']},
  {q: 'Will an AB Electronics ADC Pi and RTC Pi clash on I2C?', boards: ['ab-adc-pi', 'ab-rtc-pi']},
  {q: 'Can I put a Fan SHIM under an Inky pHAT on my Pi 5?', boards: ['pimoroni-fan-shim', 'inkyphat']},
  {q: 'Raspberry Pi DAC+ and the Pimoroni pHAT DAC on one Pi 5, possible?', boards: ['raspberrypi-dac-plus', 'phat-dac']},
  {q: 'Explorer HAT Pro plus a Unicorn HAT HD on a Pi 4?', boards: ['explorer-hat-pro', 'unicorn-hat-hd'], pi: 'raspberry-pi-4-model-b'},
  {q: 'Automation HAT and Display-o-Tron HAT together on a Pi 3B+?', boards: ['automation-hat', 'display-o-tron-hat'], pi: 'raspberry-pi-3-model-b'},
  {q: 'I have a Pirate Audio Speaker. Can I add a Fan SHIM for cooling?', boards: ['pimoroni-pirate-audio-speaker', 'pimoroni-fan-shim']},
  {q: 'Weather station on a Pi 4: environmental sensors plus a small e-ink display. What stacks?'},
  {q: 'What is a good pizza topping?', offTopic: true},
]
const LABEL = {stacks: 'Stacks', 'stacks-with-changes': 'Stacks with changes', conflicts: 'Conflicts'} as const
const firstBold = (t: string) => t.match(/\*\*([^*]+)\*\*/)?.[1].trim().toLowerCase() ?? ''

const rows = []
for (const [n, c] of CASES.entries()) {
  if (n) await new Promise((r) => setTimeout(r, 65_000)) // AI Gateway free tier: 5 requests/minute for the team
  const t0 = Date.now()
  try {
    const result = await runAgent([{role: 'user', content: c.q}])
    const r = {text: await result.text, steps: await result.steps, totalUsage: await result.totalUsage}
    const calls = r.steps.flatMap((s) => s.toolCalls)
    const checks = r.steps.flatMap((s) => s.toolResults).filter((t) => t.toolName === 'check_stack')
    const lastCheck = checks.at(-1)?.output as Awaited<ReturnType<typeof runCheck>> | undefined
    const checkedSlugs = (calls.filter((t) => t.toolName === 'check_stack').at(-1)?.input as {boards?: string[]})?.boards ?? []
    const expected = c.boards ? (await runCheck(c.boards, c.pi ?? 'raspberry-pi-5')).report.verdict : undefined
    const said = firstBold(r.text)
    const read = new Set(calls.filter((t) => t.toolName === 'knowledge_base_read').flatMap((t) => (t.input as {paths?: string[]}).paths ?? []))
    const cited = [...r.text.matchAll(/\[kb:\s*([^\]]+)\]/gi)].flatMap((m) => m[1].split(/[,;]\s*/).map((p) => p.trim()))
    rows.push({
      q: c.q,
      tools: calls.map((t) => t.toolName),
      rightBoards: c.boards ? c.boards.every((b) => checkedSlugs.includes(b)) : null,
      checkCalled: checks.length > 0,
      verdictFaithful: lastCheck ? said.startsWith(LABEL[lastCheck.report.verdict].toLowerCase()) : null,
      verdictCorrect: expected ? lastCheck?.report.verdict === expected && said.startsWith(LABEL[expected].toLowerCase()) : null,
      readKb: read.size > 0,
      kbCitations: cited.length,
      unreadCitations: cited.filter((p) => !read.has(p)),
      offTopicHandled: c.offTopic ? calls.length === 0 : null,
      seconds: +((Date.now() - t0) / 1000).toFixed(1),
      tokens: {in: r.totalUsage.inputTokens, out: r.totalUsage.outputTokens},
      answer: r.text,
    })
    console.log(JSON.stringify({...rows.at(-1), answer: undefined}))
  } catch (e) {
    rows.push({q: c.q, error: String(e)})
    console.log('ERROR', c.q, String(e).slice(0, 200))
  }
}
mkdirSync('evidence', {recursive: true})
const file = `evidence/eval-${new Date().toISOString().slice(0, 16).replace(':', '')}-${MODEL.replace('/', '_')}.json`
writeFileSync(file, JSON.stringify({model: MODEL, at: new Date().toISOString(), rows}, null, 2))
console.log(`wrote ${file}`)
