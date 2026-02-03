import type { Metadata, Viewport } from "next"
import { Outfit, JetBrains_Mono } from "next/font/google"
import "./globals.css"

const outfit = Outfit({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
})

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://triqual.dev'),
  title: "Triqual | Autonomous Test Automation for Claude Code",
  description:
    "Open-source Claude Code plugin that writes Playwright tests, heals failures autonomously, and learns from every run. Built for QA engineers and developers.",
  keywords: [
    "test automation",
    "playwright",
    "e2e testing",
    "claude code",
    "quoth",
    "exolar",
  ],
  authors: [{ name: "Montinou" }],
  icons: {
    icon: "/triqual_logo.png",
    apple: "/triqual_logo.png",
  },
  openGraph: {
    title: "Triqual | Autonomous Test Automation for Claude Code",
    description:
      "Open-source Claude Code plugin that writes Playwright tests, heals failures autonomously, and learns from every run. Built for QA engineers and developers.",
    type: "website",
    images: ["/og-image.png"],
  },
}

export const viewport: Viewport = {
  themeColor: "#05080f",
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className={`${outfit.variable} ${jetbrainsMono.variable} font-display antialiased`}
      >
        {children}
      </body>
    </html>
  )
}
