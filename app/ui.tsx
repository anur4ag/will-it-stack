'use client'

import {useChat} from '@ai-sdk/react'
import {DefaultChatTransport} from 'ai'
import {useState} from 'react'
import Markdown from 'react-markdown'
import type {UIMessage} from 'ai'
import type {CheckResult, PiModel} from '@/lib/sanity.ts'
import {EXAMPLES} from '@/lib/examples.ts'
import recorded from '@/lib/recorded.json'

type Recorded = {question: string; model: string; recordedAt: string; message: UIMessage}
const RECORDED = new Map((recorded as Recorded[]).map((r) => [r.question, r]))

type Catalog = {boards: {slug: string; name: string; manufacturer: string | null}[]; models: PiModel[]}

const PRESETS: {label: string; boards: string[]}[] = [
  {label: 'Two audio DACs', boards: ['raspberrypi-dac-plus', 'phat-dac']},
  {label: 'Unicorn HAT + Pirate Audio', boards: ['unicorn-hat', 'pimoroni-pirate-audio-speaker']},
  {label: 'ADC Pi + RTC Pi', boards: ['ab-adc-pi', 'ab-rtc-pi']},
  {label: 'Sense HAT + Enviro pHAT', boards: ['sense-hat', 'enviro-phat']},
]
const BOARD_COLORS = ['var(--b1)', 'var(--b2)', 'var(--b3)', 'var(--b4)', 'var(--b5)', 'var(--b6)']

export function App({catalog}: {catalog: Catalog}) {
  return (
    <main>
      <header className="hero">
        <h1>Will It Stack?</h1>
        <p>
          Plan which Raspberry Pi add-on boards can share one 40-pin header. Pin, I2C and HAT&nbsp;EEPROM collisions are computed from
          structured records of {catalog.boards.length} boards; the agent reads a Sanity Knowledge Base for fixes and caveats.
        </p>
      </header>
      <Ask />
      <Check catalog={catalog} />
      <footer>
        Board and pin data from <a href="https://pinout.xyz">Pinout.xyz</a> (CC BY-SA 4.0) and the{' '}
        <a href="https://www.raspberrypi.com/documentation/">Raspberry Pi documentation</a> (CC BY-SA 4.0), stored in Sanity project 31brl2ka.{' '}
        <a href="https://github.com/anur4ag/will-it-stack">Source</a>. Not affiliated with Raspberry Pi Ltd or Pinout.xyz. Double-check before wiring anything that carries 5&nbsp;V.
      </footer>
    </main>
  )
}

function Ask() {
  const {messages, sendMessage, setMessages, status, error} = useChat({transport: new DefaultChatTransport({api: '/api/chat'})})
  const [input, setInput] = useState('')
  const [replay, setReplay] = useState<Recorded | null>(null)
  const busy = status === 'submitted' || status === 'streaming'
  const send = (text: string) => {
    if (!text.trim() || busy) return
    setReplay(null)
    sendMessage({text})
    setInput('')
  }
  // Example questions replay a recorded real run first: the live model allows about one question a minute.
  const example = (q: string) => {
    const r = RECORDED.get(q)
    if (!r) return send(q)
    setReplay(r)
    setMessages([{id: 'recorded-q', role: 'user', parts: [{type: 'text', text: q}]}, r.message])
  }
  return (
    <section className="card" aria-labelledby="ask-h">
      <h2 id="ask-h">Ask the agent</h2>
      {replay && (
        <p className="replay">
          Recorded run from {new Date(replay.recordedAt).toUTCString().slice(5, 22)} UTC with {replay.model}.{' '}
          <button className="link" onClick={() => (setMessages([]), send(replay.question))} disabled={busy}>Run it live</button>
        </p>
      )}
      <div className="thread">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((p, i) => {
              if (p.type === 'text') return m.role === 'user' ? <p key={i}>{p.text}</p> : <Answer key={i} text={p.text} read={kbPathsRead(m)} />
              if (p.type === 'dynamic-tool') return <ToolStep key={i} name={p.toolName} state={p.state} input={p.input} output={'output' in p ? p.output : undefined} />
              if (p.type === 'tool-check_stack') {
                const part = p as {state: string; input?: unknown; output?: CheckResult}
                return part.state === 'output-available' && part.output ? <StackView key={i} result={part.output} /> : <ToolStep key={i} name="check_stack" state={part.state} input={part.input} />
              }
              return null
            })}
          </div>
        ))}
        {status === 'submitted' && <p className="muted">Thinking…</p>}
        {error && <p className="error" role="alert">{readError(error)}</p>}
      </div>
      {!messages.length && (
        <div className="chips">
          {EXAMPLES.map((q) => (
            <button key={q} className="chip" onClick={() => example(q)} disabled={busy}>{q}</button>
          ))}
        </div>
      )}
      <form className="ask" onSubmit={(e) => (e.preventDefault(), send(input))}>
        <label className="sr" htmlFor="q">Your question</label>
        <input id="q" value={input} onChange={(e) => setInput(e.target.value)} maxLength={600} placeholder="e.g. Can a Fan SHIM go under an Inky pHAT on a Pi 5?" autoComplete="off" />
        <button type="submit" disabled={busy || !input.trim()}>{busy ? 'Working…' : 'Ask'}</button>
      </form>
    </section>
  )
}

const kbPathsRead = (m: UIMessage) =>
  new Set(m.parts.flatMap((p) => (p.type === 'dynamic-tool' && p.toolName === 'knowledge_base_read' ? ((p.input as {paths?: string[]})?.paths ?? []) : [])))

// Knowledge Base citations become badges; one the agent cites without having read it is flagged.
function Answer({text, read}: {text: string; read: Set<string>}) {
  const marked = text.replace(/\[kb:\s*([^\]]+)\]/gi, (_, list: string) =>
    list.split(/[,;]\s*/).map((p) => `\`${read.has(p.trim()) ? 'kb' : 'kb?'} ${p.trim()}\``).join(' '),
  )
  return (
    <div className="md">
      <Markdown
        components={{
          code: ({children}) => {
            const t = String(children)
            if (!/^kb\??\s/.test(t)) return <code>{children}</code>
            const ok = t.startsWith('kb ')
            return <span className={`cite ${ok ? '' : 'unread'}`} title={ok ? 'Knowledge Base entry the agent read' : 'Cited but not read in this answer'}>{t.replace(/^kb\??\s/, '')}{ok ? '' : ' (not read)'}</span>
          },
        }}
      >
        {marked}
      </Markdown>
    </div>
  )
}

function readError(e: Error) {
  try {
    return JSON.parse(e.message).error ?? e.message
  } catch {
    return e.message
  }
}

// One line per MCP tool call, so you can see exactly what the agent read from Sanity.
function ToolStep({name, state, input, output}: {name: string; state: string; input?: unknown; output?: unknown}) {
  const inp = (input ?? {}) as Record<string, unknown>
  const label = name === 'groq_query' ? 'GROQ query' : name === 'knowledge_base_read' ? 'Knowledge Base read' : name === 'check_stack' ? 'Stack check' : name
  const detail = name === 'groq_query' ? String(inp.query ?? '') : name === 'knowledge_base_read' ? ((inp.paths as string[]) ?? []).join(', ') : JSON.stringify(inp)
  const text = (output as {content?: {text?: string}[]})?.content?.map((c) => c.text ?? '').join('\n') ?? (output ? JSON.stringify(output, null, 2) : '')
  return (
    <details className="step">
      <summary>
        <span className={`dot ${state === 'output-available' ? 'done' : state === 'output-error' ? 'err' : ''}`} aria-hidden />
        <b>{label}</b> <code>{detail.length > 140 ? detail.slice(0, 140) + '…' : detail}</code>
      </summary>
      {text && <pre>{text.length > 4000 ? text.slice(0, 4000) + '\n…' : text}</pre>}
    </details>
  )
}

function Check({catalog}: {catalog: Catalog}) {
  const [pi, setPi] = useState('raspberry-pi-5')
  const [picked, setPicked] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<CheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const byName = new Map(catalog.boards.map((b) => [`${b.name}${b.manufacturer ? ` (${b.manufacturer})` : ''}`, b.slug]))
  const nameOf = (slug: string) => catalog.boards.find((b) => b.slug === slug)?.name ?? slug
  const add = (value: string) => {
    const slug = byName.get(value)
    if (slug && !picked.includes(slug) && picked.length < 6) setPicked([...picked, slug])
    setQuery('')
  }
  const run = async (boards = picked, model = pi) => {
    if (!boards.length) return
    setLoading(true)
    const r = await fetch(`/api/check?boards=${boards.join(',')}&pi=${model}`)
    setResult(await r.json())
    setLoading(false)
  }
  return (
    <section className="card" aria-labelledby="check-h">
      <h2 id="check-h">Check a stack directly</h2>
      <p className="muted">Same checker the agent calls, no model involved.</p>
      <div className="chips">
        {PRESETS.map((p) => (
          <button key={p.label} className="chip" onClick={() => (setPicked(p.boards), run(p.boards))}>{p.label}</button>
        ))}
      </div>
      <div className="row">
        <label>
          Pi model
          <select value={pi} onChange={(e) => setPi(e.target.value)}>
            {catalog.models.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
          </select>
        </label>
        <label className="grow">
          Add a board
          <input list="boards" value={query} onChange={(e) => (byName.has(e.target.value) ? add(e.target.value) : setQuery(e.target.value))} placeholder="Type to search 231 boards" />
          <datalist id="boards">{[...byName.keys()].map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <button onClick={() => run()} disabled={!picked.length || loading}>{loading ? 'Checking…' : 'Check'}</button>
      </div>
      {!!picked.length && (
        <ul className="picked">
          {picked.map((s, i) => (
            <li key={s} style={{'--c': BOARD_COLORS[i]} as React.CSSProperties}>
              {nameOf(s)} <button aria-label={`Remove ${nameOf(s)}`} onClick={() => setPicked(picked.filter((x) => x !== s))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {result && <StackView result={result} />}
    </section>
  )
}

const VERDICT = {stacks: 'Stacks', 'stacks-with-changes': 'Stacks with changes', conflicts: 'Conflicts'} as const

export function StackView({result}: {result: CheckResult}) {
  if ('error' in result) return <p className="error">{String((result as {error: unknown}).error)}</p>
  const {report, header, pi, unknownBoards} = result
  const color = new Map(report.boards.map((b, i) => [b, BOARD_COLORS[i % BOARD_COLORS.length]]))
  const use = new Map(report.pins.map((p) => [p.physical, p]))
  const cell = (n: number, side: 'l' | 'r') => {
    const h = header.find((x) => x.physical === n)
    const u = use.get(n)
    const kind = h?.bcm == null ? (/5v/i.test(h?.label ?? '') ? 'v5' : /3v3/i.test(h?.label ?? '') ? 'v3' : 'gnd') : 'gpio'
    const chips = (u?.users ?? []).filter((x) => !['ground', 'power-5v', 'power-3v3'].includes(x.role)).map((x) => (
      <span key={x.board} className="use" style={{'--c': color.get(x.board)} as React.CSSProperties} title={`${x.board}: ${x.role}${x.signal ? ` (${x.signal})` : ''}`}>{x.role}</span>
    ))
    const label = h?.bcm == null ? h?.label : `GPIO ${h.bcm}`
    return (
      <div className={`pin ${side} ${chips.length ? (u?.state ?? 'free') : 'free'}`}>
        <span className="lbl">{label}</span>
        <span className="uses">{chips}</span>
        <span className={`num ${kind}`}>{n}</span>
      </div>
    )
  }
  return (
    <div className="stack">
      <p className={`verdict ${report.verdict}`}>
        <b>{VERDICT[report.verdict]}</b> on {pi.name}
      </p>
      {result.note && <p className="muted">{result.note}</p>}
      {!!unknownBoards.length && <p className="error">Not in the data: {unknownBoards.join(', ')}</p>}
      <ul className="legend">
        {report.boards.map((b) => <li key={b} style={{'--c': color.get(b)} as React.CSSProperties}>{b}</li>)}
      </ul>
      <div className="header" role="img" aria-label={`GPIO header with ${report.issues.length} issues`}>
        {Array.from({length: 20}, (_, r) => (
          <div className="hrow" key={r}>{cell(r * 2 + 1, 'l')}{cell(r * 2 + 2, 'r')}</div>
        ))}
      </div>
      {!!report.issues.length && (
        <ul className="issues">
          {report.issues.map((i, k) => (
            <li key={k} className={i.severity}>
              <b>{i.kind === 'pin' ? `Pin ${i.pin}` : i.kind === 'i2c' ? `I2C ${i.address}` : i.kind === 'eeprom' ? 'HAT EEPROM' : `Pin ${i.pin} function`}</b>: {i.detail}
              {i.fix && <div className="fix">Fix: {i.fix}</div>}
            </li>
          ))}
        </ul>
      )}
      {!!report.i2c.length && (
        <p className="muted">
          I2C addresses: {report.i2c.map((d) => `${d.address} ${d.device ?? ''} (${d.board})`).join(' · ')}
        </p>
      )}
      {report.notes.map((n) => <p key={n} className="muted">{n}</p>)}
    </div>
  )
}
