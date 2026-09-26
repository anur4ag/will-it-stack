# Will It Stack?

An agent that tells you whether Raspberry Pi add-on boards (HATs, pHATs, bonnets, shims) can share one 40-pin GPIO header, what collides, and what to change.

**Live:** https://will-it-stack.vercel.app · **Sanity project:** `31brl2ka` (public `production` dataset) · Built for the [DEV Sanity Challenge](https://dev.to/challenges/sanity-2026-09-16), Path One.

## How it works

```
question ─► agent (AI SDK, via Vercel AI Gateway)
              ├─ groq_query ──────────► Sanity Context MCP "will-it-stack-data"  (GROQ mode: board/pin/piModel records)
              ├─ check_stack ─────────► lib/stack.ts  (deterministic: pins, I2C addresses, HAT EEPROM, per-SoC pin functions)
              └─ knowledge_base_read ─► Sanity Context MCP "will-it-stack-kb"    (Knowledge Base built from the same dataset)
```

- **Structured records** (`sanity/schema.ts`): 231 `board` documents listing every header pin they touch (with a role such as `i2c`, `spi`, `i2s`, `uart`, `gpio-out`) and every I2C device address (with alternates), 40 `pin` documents with each GPIO's alternate functions per SoC (BCM2835, BCM2711, RP1), 6 `piModel` documents, and 48 `guide` documents of prose.
- **The verdict is code, not the model.** The output guard in `lib/guard.ts` holds the answer text until the run ends and replaces any verdict that no successful `check_stack` result backs up (or corrects one that contradicts it). `check_stack` finds pins claimed by two boards for non-shareable roles, I2C address collisions (and whether an alternate address frees them), multiple HAT ID EEPROMs, and pins asked to do something their SoC can't. The agent must call it before saying anything about compatibility and may not contradict it.
- **The Knowledge Base** is built by Sanity Context from 130 documents selected from the dataset (all guides, pins with notes, boards with long descriptions). The agent reads it for fixes and caveats: address jumpers, `dtoverlay` lines, Pi 5 and current Raspberry Pi OS differences, power limits.
- **Check a stack** on the page runs the same checker without a model.

## Data

| Source | What | License |
|---|---|---|
| [pinout-xyz/Pinout.xyz](https://github.com/pinout-xyz/Pinout.xyz) | board overlays, header pin map, per-SoC pin functions, pin notes | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| [raspberrypi/documentation](https://github.com/raspberrypi/documentation) | GPIO, SPI, power, RTC, DPI, RP1, interfaces, Python on Raspberry Pi OS, accessory pages | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

Every imported document keeps `source.repo`, `source.path` and `source.commit`. The code in this repository is [MIT](LICENSE); the imported data stays [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), as does anything derived from it (the Knowledge Base entries).

Known upstream data issues handled in `scripts/import.ts`:
- `pi-supply-iot-lora-gateway-hat.md` indents pin 23's `mode: spi` one level too shallow; fixed explicitly.
- Some overlays key pins as `bcm17` rather than a physical number; converted.
- Some overlays name a pin's signal (`I2S`, `TXD / Transmit`) without a `mode`; the role is inferred from the name, but only on that bus's own pins.

## Run it

```sh
npm install
# .env.local: SANITY_CONTEXT_TOKEN (org token, Context Viewer) and AI Gateway auth (VERCEL_OIDC_TOKEN via `vercel env pull`)
npm run dev
npm test                                   # checker tests
node --env-file=.env.local scripts/ask.ts "Can a Fan SHIM go under an Inky pHAT?"
node --env-file=.env.local scripts/eval.ts # end-to-end eval, writes evidence/
```

Re-import the data: `PINOUT_DIR=… RPIDOCS_DIR=… npm run import` (needs a project token with write access).

## Limits

- **Not tested on physical hardware.** Every verdict comes from the pinout.xyz records and the checker in `lib/stack.ts`; nobody plugged these boards in to confirm it.
- It only knows boards that pinout.xyz documents, and only as well as those records are.
- It says nothing about physical clearance, current draw of the boards themselves, or software library conflicts beyond what the Knowledge Base covers.
- The public demo is rate-limited and runs on free AI Gateway credits; the "Check a stack" panel needs no model.

## How this was built

Written with Claude Code (an AI coding agent) working under Anurag Sharma's direction; see the DEV post for the process, including what went wrong.
