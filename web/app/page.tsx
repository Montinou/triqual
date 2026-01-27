import dynamic from "next/dynamic"
import { AnimatedGrid } from "@/components/animations/animated-grid"
import { GlowBackground } from "@/components/animations/glow-background"
import { Navbar } from "@/components/layout/navbar"
import { Footer } from "@/components/layout/footer"
import { Hero } from "@/components/landing/hero"
import { FeaturesGrid } from "@/components/landing/features-grid"
import { CodePreview } from "@/components/landing/code-preview"
import { WorkflowSteps } from "@/components/landing/workflow-steps"
import { CTASection } from "@/components/landing/cta-section"

// Dynamic import for heavy below-the-fold component
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
        <Hero />
        <TrinityDiagram />
        <FeaturesGrid />
        <CodePreview />
        <WorkflowSteps />
        <CTASection />
      </main>

      {/* Footer */}
      <Footer />
    </>
  )
}
