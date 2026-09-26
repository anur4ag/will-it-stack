import {defineArrayMember, defineField, defineType} from 'sanity'

// Every document imported from pinout.xyz or the Raspberry Pi docs keeps a pointer to the exact file and commit it came from.
const source = defineField({
  name: 'source',
  type: 'object',
  description: 'Where this record was imported from. Content is CC BY-SA 4.0 unless stated.',
  fields: [
    defineField({name: 'url', type: 'url', description: 'Human-readable page for this record'}),
    defineField({name: 'repo', type: 'string'}),
    defineField({name: 'path', type: 'string'}),
    defineField({name: 'commit', type: 'string'}),
    defineField({name: 'license', type: 'string'}),
  ],
})

export const pin = defineType({
  name: 'pin',
  title: 'Header pin',
  type: 'document',
  description: 'One of the 40 physical pins on the Raspberry Pi GPIO header.',
  fields: [
    defineField({name: 'physical', type: 'number', description: 'Physical pin number, 1–40', validation: (r) => r.required().min(1).max(40)}),
    defineField({name: 'label', type: 'string', description: 'Default label, e.g. "GPIO 2 (I2C1 SDA)" or "Ground"'}),
    defineField({name: 'kind', type: 'string', options: {list: ['gpio', '5v', '3v3', 'ground']}}),
    defineField({name: 'bcm', type: 'number', description: 'Broadcom/RP1 GPIO number (BCM numbering). Empty for power and ground.'}),
    defineField({
      name: 'functions',
      type: 'object',
      description: 'Alternate functions this GPIO can take, per SoC. The header is the same on every 40-pin Pi, but the silicon behind it is not.',
      fields: [
        defineField({name: 'bcm2835', title: 'Pi 1–3, Zero (BCM2835/6/7)', type: 'array', of: [{type: 'string'}]}),
        defineField({name: 'bcm2711', title: 'Pi 4, 400, CM4 (BCM2711)', type: 'array', of: [{type: 'string'}]}),
        defineField({name: 'rp1', title: 'Pi 5 (RP1)', type: 'array', of: [{type: 'string'}]}),
      ],
    }),
    defineField({name: 'notes', type: 'text', description: 'Prose notes about this pin from pinout.xyz'}),
    source,
  ],
  orderings: [{title: 'Physical', name: 'physical', by: [{field: 'physical', direction: 'asc'}]}],
  preview: {select: {title: 'label', n: 'physical'}, prepare: ({title, n}) => ({title: `${n} · ${title}`})},
})

export const board = defineType({
  name: 'board',
  title: 'Add-on board',
  type: 'document',
  description: 'A HAT, pHAT or other add-on that plugs into the GPIO header, with exactly which pins and I2C addresses it claims.',
  fields: [
    defineField({name: 'name', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'name'}, validation: (r) => r.required()}),
    defineField({name: 'manufacturer', type: 'string'}),
    defineField({name: 'formFactor', type: 'string', options: {list: ['HAT', 'pHAT', 'Custom', 'USB']}}),
    defineField({name: 'categories', type: 'array', of: [{type: 'string'}], options: {layout: 'tags'}, description: 'e.g. audio, display, sensor, motor, led, adc, rtc'}),
    defineField({name: 'summary', type: 'text', rows: 2}),
    defineField({name: 'headerPins', type: 'number', description: 'How many header pins the board connects to (40, 26, …)'}),
    defineField({
      name: 'idEeprom',
      title: 'ID EEPROM',
      type: 'string',
      description: 'Whether the board carries a HAT ID EEPROM on pins 27/28. Only one EEPROM-bearing board can be probed at boot.',
      options: {list: ['yes', 'no', 'setup', 'detect', 'unknown']},
    }),
    defineField({
      name: 'pins',
      title: 'Pins used',
      type: 'array',
      description: 'Every header pin the board touches and what it uses it for. The stack checker reads this field.',
      of: [
        defineArrayMember({
          name: 'pinUse',
          type: 'object',
          fields: [
            defineField({name: 'pin', type: 'reference', to: [{type: 'pin'}], validation: (r) => r.required()}),
            defineField({name: 'physical', type: 'number', description: 'Denormalised physical pin number, so GROQ can filter without a join'}),
            defineField({
              name: 'role',
              type: 'string',
              description: 'Shared buses (i2c, spi, 1-wire, power, ground) can be shared between boards; everything else is exclusive.',
              options: {list: ['i2c', 'spi', 'spi-cs', 'i2s', 'pcm', 'uart', 'pwm', '1-wire', 'gpio-in', 'gpio-out', 'gpio', 'eeprom', 'power-5v', 'power-3v3', 'ground']},
            }),
            defineField({name: 'signal', type: 'string', description: 'What the board calls this pin, e.g. "LED Data" or "Chip Select"'}),
            defineField({name: 'activeLow', type: 'boolean'}),
          ],
          preview: {select: {n: 'physical', role: 'role', signal: 'signal'}, prepare: ({n, role, signal}) => ({title: `Pin ${n} · ${role}`, subtitle: signal})},
        }),
      ],
    }),
    defineField({
      name: 'i2cDevices',
      title: 'I2C devices',
      type: 'array',
      description: 'Devices on the I2C1 bus (pins 3/5) and their 7-bit addresses. Two devices at the same address on one bus collide.',
      of: [
        defineArrayMember({
          name: 'i2cDevice',
          type: 'object',
          fields: [
            defineField({name: 'address', type: 'string', description: 'Lower-case hex, e.g. "0x68"', validation: (r) => r.regex(/^0x[0-9a-f]{2}$/)}),
            defineField({name: 'alternates', type: 'array', of: [{type: 'string'}], description: 'Addresses the device can be moved to (jumper, solder bridge or software)'}),
            defineField({name: 'device', type: 'string', description: 'Chip part number, e.g. "bme280"'}),
            defineField({name: 'label', type: 'string'}),
          ],
          preview: {select: {title: 'address', subtitle: 'device'}},
        }),
      ],
    }),
    defineField({name: 'dtoverlay', type: 'string', description: 'Device tree overlay the board needs in config.txt, if any'}),
    defineField({name: 'install', type: 'text', rows: 2, description: 'Install command as published with the board'}),
    defineField({
      name: 'links',
      type: 'object',
      fields: ['url', 'github', 'schematic', 'buy'].map((n) => defineField({name: n, type: 'url'})),
    }),
    defineField({name: 'body', type: 'text', description: 'Long description in Markdown, as published on pinout.xyz'}),
    source,
  ],
  preview: {select: {title: 'name', subtitle: 'manufacturer'}},
})

export const piModel = defineType({
  name: 'piModel',
  title: 'Raspberry Pi model',
  type: 'document',
  fields: [
    defineField({name: 'name', type: 'string'}),
    defineField({name: 'slug', type: 'slug', options: {source: 'name'}}),
    defineField({name: 'soc', type: 'string', description: 'Which GPIO silicon drives the header; selects the function table on each pin', options: {list: ['bcm2835', 'bcm2711', 'rp1']}}),
    defineField({name: 'headerPins', type: 'number'}),
  ],
})

export const guide = defineType({
  name: 'guide',
  title: 'Guide',
  type: 'document',
  description: 'A prose reference page (official Raspberry Pi docs or a pinout.xyz interface page). These feed the Knowledge Base.',
  fields: [
    defineField({name: 'title', type: 'string'}),
    defineField({name: 'slug', type: 'slug', options: {source: 'title'}}),
    defineField({name: 'publisher', type: 'string', options: {list: ['Raspberry Pi Ltd', 'pinout.xyz']}}),
    defineField({name: 'topics', type: 'array', of: [{type: 'string'}], options: {layout: 'tags'}}),
    defineField({name: 'body', type: 'text', description: 'Markdown or AsciiDoc as published'}),
    source,
  ],
})

export const schemaTypes = [board, pin, piModel, guide]
