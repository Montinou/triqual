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
  title: "Triqual | Intelligent Test Automation",
  description:
    "Unified test automation plugin combining Playwright execution, Quoth pattern documentation, and Exolar analytics into one self-learning system.",
  keywords: [
    "test automation",
    "playwright",
    "e2e testing",
    "claude code",
    "quoth",
    "exolar",
  ],
  authors: [{ name: "Montinou" }],
  openGraph: {
    title: "Triqual | Intelligent Test Automation",
    description:
      "Unified test automation plugin combining Playwright execution, Quoth pattern documentation, and Exolar analytics into one self-learning system.",
    type: "website",
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
