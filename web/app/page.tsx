import dynamic from "next/dynamic"
import { AnimatedGrid } from "@/components/animations/animated-grid"
import { GlowBackground } from "@/components/animations/glow-background"
import { Navbar } from "@/components/layout/navbar"
import { Footer } from "@/components/layout/footer"
import { HeroRefined } from "@/components/landing/hero-refined"
import { FeaturePanels } from "@/components/landing/feature-panels"
import { TerminalDemo } from "@/components/landing/terminal-demo"
import { FinalCTA } from "@/components/landing/final-cta"

// Dynamic import for heavy animated component
const TrinityDiagram = dynamic(
  () => import("@/components/landing/trinity-diagram").then((m) => m.TrinityDiagram),
  { ssr: true }
)

export default function Home() {
  return (
    <>
      {/* Animated background elements */}
      <AnimatedGrid />
      <GlowBackground />

      {/* Navigation */}
      <Navbar />

      {/* Main content */}
      <main>
        <HeroRefined />
        <TrinityDiagram />
        <FeaturePanels />
        <TerminalDemo />
        <FinalCTA />
      </main>

      {/* Footer */}
      <Footer />
    </>
  )
}
