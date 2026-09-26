// ponytail: in-memory limits per server instance. Enough to stop one visitor from draining the free
// AI Gateway credits (which hard-stop at $5 anyway); move to a shared store if traffic ever needs it.
const PER_IP = 6 // agent runs per IP per window
const WINDOW_MS = 10 * 60_000
const PER_DAY = 200 // agent runs per instance per day
const hits = new Map<string, number[]>()
let day = {start: Date.now(), count: 0}

export function allow(ip: string, now = Date.now()): {ok: true} | {ok: false; reason: string} {
  if (now - day.start > 86_400_000) day = {start: now, count: 0}
  if (day.count >= PER_DAY) return {ok: false, reason: 'The demo has used its model budget for today. The "Check a stack" panel still works without the model.'}
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= PER_IP) return {ok: false, reason: 'Too many questions from this address; try again in a few minutes. The "Check a stack" panel still works without the model.'}
  hits.set(ip, [...recent, now])
  day.count++
  return {ok: true}
}
