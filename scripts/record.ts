// Record real agent runs for the example questions, so the demo can replay them without spending
// free-tier model requests. A run the output guard didn't pass as-is is retried (up to 3 attempts);
// the attempt count and guard status are saved with each recording so the curation is visible.
// Usage: node --env-file=.env.local scripts/record.ts
import {writeFileSync} from 'node:fs'
import {readUIMessageStream, toUIMessageStream, type UIMessage} from 'ai'
import {runAgent} from '../lib/agent.ts'
import {MODEL} from '../lib/model.ts'
import {EXAMPLES} from '../lib/examples.ts'

const pause = () => new Promise((r) => setTimeout(r, 65_000)) // AI Gateway free tier: 5 requests/minute
const runs = []
let first = true
for (const question of EXAMPLES) {
  let message: UIMessage | undefined
  let status = 'error'
  let attempts = 0
  while (attempts < 3 && status !== 'ok') {
    if (!first) await pause()
    first = false
    attempts++
    const result = await runAgent([{role: 'user', content: question}])
    for await (const m of readUIMessageStream({stream: toUIMessageStream({stream: result.stream})})) message = m
    status = await result.guardStatus
    console.log(`attempt ${attempts}: ${question} → guard ${status}`)
  }
  runs.push({question, model: MODEL, recordedAt: new Date().toISOString(), attempts, guardStatus: status, message})
}
writeFileSync('lib/recorded.json', JSON.stringify(runs, null, 1))
