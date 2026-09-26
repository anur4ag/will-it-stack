import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './sanity/schema.ts'

export default defineConfig({
  name: 'default',
  title: 'Will It Stack',
  projectId: '31brl2ka',
  dataset: 'production',
  basePath: '/studio',
  plugins: [structureTool()],
  schema: {types: schemaTypes},
})
