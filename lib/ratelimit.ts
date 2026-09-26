// ponytail: in-memory limits per server instance. The binding constraint is the AI Gateway free tier
// (5 model requests per minute for the whole team, about one agent run); move to a shared store if needed.
const GLOBAL_GAP_MS = 50_000 // one live run per 50 s across all visitors of this instance (Vercel may run several)
const PER_IP = 4 // live runs per IP per window
const WINDOW_MS = 15 * 60_000
const hits = new Map<string, number[]>()
let lastRun = 0

const LATER = 'The "Check a stack" panel and the recorded examples still work without the model.'

export function allow(ip: string, now = Date.now()): {ok: true} | {ok: false; reason: string} {
  const wait = Math.ceil((lastRun + GLOBAL_GAP_MS - now) / 1000)
  if (wait > 0) return {ok: false, reason: `The live agent runs on a free model tier that allows about one question a minute. Try again in ${wait} s. ${LATER}`}
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= PER_IP) return {ok: false, reason: `You have used your live questions for now; try again in a few minutes. ${LATER}`}
  hits.set(ip, [...recent, now])
  lastRun = now
  return {ok: true}
}
