import { AnimatedGrid, GlowBackground } from "@/components/animations"
import { Navbar, Footer } from "@/components/layout"
import {
  Hero,
  TrinityDiagram,
  FeaturesGrid,
  CodePreview,
  WorkflowSteps,
  CTASection,
} from "@/components/landing"

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
