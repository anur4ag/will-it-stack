// Record real agent runs for the example questions, so the demo can replay them without spending
// free-tier model requests. A run the output guard didn't pass as-is is retried (up to 3 attempts);
// the attempt count and guard status are saved with each recording so the curation is visible.
// Nothing is written unless every example ends with a usable answer.
// Usage: node --env-file=.env.local scripts/record.ts
import {writeFileSync} from 'node:fs'
import {runAgent} from '../lib/agent.ts'
import {MODEL} from '../lib/model.ts'
import {EXAMPLES} from '../lib/examples.ts'
import {recordExample} from '../lib/record.ts'

const pause = () => new Promise((r) => setTimeout(r, 65_000)) // AI Gateway free tier: 5 requests/minute
let first = true
const beforeAttempt = async () => {
  if (!first) await pause()
  first = false
}
const runs = []
for (const question of EXAMPLES) {
  const r = await recordExample(question, (q) => runAgent([{role: 'user', content: q}]), {beforeAttempt})
  runs.push({question, model: MODEL, recordedAt: r.recordedAt, attempts: r.attempts, guardStatus: r.guardStatus, message: r.message})
}
writeFileSync('lib/recorded.json', JSON.stringify(runs, null, 1))
