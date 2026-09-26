import {getCatalog} from '@/lib/sanity.ts'
import {App} from './ui.tsx'

export const revalidate = 3600

export default async function Page() {
  return <App catalog={await getCatalog()} />
}
