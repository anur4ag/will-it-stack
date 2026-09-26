// Record real agent runs for the example questions, so the demo can replay them without spending
// free-tier model requests. Usage: node --env-file=.env.local scripts/record.ts
import {writeFileSync} from 'node:fs'
import {readUIMessageStream, toUIMessageStream, type UIMessage} from 'ai'
import {runAgent} from '../lib/agent.ts'
import {MODEL} from '../lib/model.ts'
import {EXAMPLES} from '../lib/examples.ts'

const runs = []
for (const [i, question] of EXAMPLES.entries()) {
  if (i) await new Promise((r) => setTimeout(r, 65_000)) // stay under 5 requests/minute
  const result = await runAgent([{role: 'user', content: question}])
  let message: UIMessage | undefined
  for await (const m of readUIMessageStream({stream: toUIMessageStream({stream: result.stream})})) message = m
  runs.push({question, model: MODEL, recordedAt: new Date().toISOString(), message})
  console.log(`recorded: ${question} (${message?.parts.length} parts)`)
}
writeFileSync('lib/recorded.json', JSON.stringify(runs, null, 1))
