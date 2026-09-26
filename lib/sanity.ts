import {createClient} from 'next-sanity'
import {checkStack, type Board, type HeaderPin, type Soc} from './stack.ts'

// Public dataset: reads need no token.
export const client = createClient({projectId: '31brl2ka', dataset: 'production', apiVersion: '2025-02-19', useCdn: true})

const BOARD = `{"slug": slug.current, name, manufacturer, formFactor, categories, summary, headerPins, idEeprom, dtoverlay, "url": coalesce(links.url, source.url), "source": source.url, pins[]{physical, role, signal}, i2cDevices[]{address, alternates, device, label}}`

export type PiModel = {slug: string; name: string; soc: Soc}

export const getCatalog = () =>
  client.fetch<{boards: {slug: string; name: string; manufacturer: string | null}[]; models: PiModel[]}>(
    `{"boards": *[_type == "board"] | order(name asc){"slug": slug.current, name, manufacturer}, "models": *[_type == "piModel"] | order(name asc){"slug": slug.current, name, soc}}`,
  )

export async function runCheck(slugs: string[], pi: string) {
  const {boards, model, header} = await client.fetch<{boards: (Board & Record<string, unknown>)[]; model: PiModel | null; header: HeaderPin[]}>(
    `{"boards": *[_type == "board" && slug.current in $slugs]${BOARD}, "model": *[_type == "piModel" && slug.current == $pi][0]{"slug": slug.current, name, soc}, "header": *[_type == "pin"] | order(physical asc){physical, label, bcm, functions}}`,
    {slugs, pi},
  )
  boards.sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug)) // keep the order the person picked
  const found = new Set(boards.map((b) => b.slug))
  const model_ = model ?? {slug: 'raspberry-pi-5', name: 'Raspberry Pi 5', soc: 'rp1' as const}
  return {
    pi: model_,
    ...(!model && {note: `Unknown Pi model "${pi}", so the check assumed a Raspberry Pi 5.`}),
    unknownBoards: slugs.filter((s) => !found.has(s)),
    boards: boards.map(({pins, i2cDevices, ...b}) => b),
    header,
    report: checkStack(boards, model_.soc, header),
  }
}
export type CheckResult = Awaited<ReturnType<typeof runCheck>>
