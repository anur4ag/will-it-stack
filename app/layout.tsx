import type {Metadata} from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Will It Stack?',
  description: 'Plan which Raspberry Pi HATs can share one GPIO header: pin, I2C and EEPROM collisions from structured data, explained from a Sanity Knowledge Base.',
}

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
