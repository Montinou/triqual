import { AnimatedGrid } from "@/components/animations/animated-grid"
import { GlowBackground } from "@/components/animations/glow-background"
import { Navbar } from "@/components/layout/navbar"
import { Footer } from "@/components/layout/footer"
import { ProblemValidation } from "@/components/landing/problem-validation"
import { WorkflowDiagramJourney } from "@/components/landing/workflow-diagram-journey"
import { LearningLoopShowcase } from "@/components/landing/learning-loop-showcase"
import { DraftPromotionGuarantee } from "@/components/landing/draft-promotion-guarantee"
import { GettingStartedTutorial } from "@/components/landing/getting-started-tutorial"
import { CTASection } from "@/components/landing/cta-section"

export const metadata = {
  title: "How It Works | Triqual",
  description: "Learn how Triqual's intelligent test automation works - from the learning loop to draft-first development.",
}

export default function HowItWorksPage() {
  return (
    <>
      {/* Animated background elements */}
      <AnimatedGrid />
      <GlowBackground />

      {/* Navigation */}
      <Navbar />

      {/* Main content */}
      <main className="pt-24">
        {/* Hero section for this page */}
        <section className="py-16 md:py-24 px-4 sm:px-6 lg:px-8 text-center">
          <div className="container mx-auto max-w-4xl">
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight mb-6">
              <span className="gradient-text">How Triqual Works</span>
            </h1>
            <p className="text-lg sm:text-xl text-foreground-secondary max-w-2xl mx-auto">
              A deep dive into the autonomous test automation system that learns from every failure.
            </p>
          </div>
        </section>

        {/* Detailed content sections */}
        <ProblemValidation />
        <WorkflowDiagramJourney />
        <LearningLoopShowcase />
        <DraftPromotionGuarantee />
        <GettingStartedTutorial />
        <CTASection />
      </main>

      {/* Footer */}
      <Footer />
    </>
  )
}
