"use client"

import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ScrollSection } from "@/components/shared/scroll-section"
import { DiagramViewer } from "@/components/diagrams/diagram-viewer"
import { Check, ChevronRight, Copy } from "lucide-react"
import { staggerFast, buttonPress } from "@/lib/spatial-animations"

const steps = [
  {
    number: 1,
    title: "Install Plugin",
    code: "/plugin marketplace add Montinou/triqual\n/plugin install triqual-plugin@triqual",
    explanation: "Installs Triqual from the Claude Code marketplace. Automatically installs MCP servers (Quoth, Exolar) and all 5 agents.",
    link: { label: "Getting Started Guide", href: "/docs/bootstrap-workflow" },
  },
  {
    number: 2,
    title: "Initialize Project",
    code: "/init",
    explanation: "Creates .triqual/ directory with run logs and knowledge.md. Generates triqual.config.ts with detected settings.",
    link: { label: "Getting Started Guide", href: "/docs/bootstrap-workflow" },
  },
  {
    number: 3,
    title: "Authenticate MCP Servers",
    code: "# Follow OAuth prompts for:\n# - Quoth (pattern documentation)\n# - Exolar (test analytics)",
    explanation: "One-time OAuth authentication for MCP servers. Required for pattern search and failure analysis.",
    link: { label: "Quoth Integration", href: "/docs/quoth-integration" },
  },
  {
    number: 4,
    title: "Generate Your First Test",
    code: "/test login\n# or\n/test --ticket ENG-123\n# or\n/test --describe \"User can login with email\"",
    explanation: "Autonomous test generation from feature name, Linear ticket, or description. Full ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN cycle.",
    link: { label: "Standard Patterns", href: "/docs/standard-patterns" },
  },
]

export function GettingStartedTutorial() {
  const [activeStep, setActiveStep] = useState<number | null>(null)
  const [copiedStep, setCopiedStep] = useState<number | null>(null)

  const handleCopy = async (code: string, stepNumber: number) => {
    await navigator.clipboard.writeText(code)
    setCopiedStep(stepNumber)
    setTimeout(() => setCopiedStep(null), 2000)
  }

  return (
    <ScrollSection
      id="install"
      title="Get Started in 4 Steps"
      subtitle="From zero to autonomous test generation in minutes"
      className="bg-background-surface/30"
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        {/* Left: Diagram */}
        <div className="order-2 lg:order-1 lg:sticky lg:top-24">
          <DiagramViewer
            src="/flow-images/09-getting_started.png"
            alt="Getting Started - 4 Step Flow"
            size="large"
            animateEntry={true}
            use3D={false}
          />
        </div>

        {/* Right: Steps */}
        <motion.div
          className="order-1 lg:order-2 space-y-4"
          variants={staggerFast}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
        >
          {steps.map((step) => (
            <StepCard
              key={step.number}
              step={step}
              isActive={activeStep === step.number}
              isCopied={copiedStep === step.number}
              onToggle={() => setActiveStep(activeStep === step.number ? null : step.number)}
              onCopy={() => handleCopy(step.code, step.number)}
            />
          ))}
        </motion.div>
      </div>

      {/* Progress indicator */}
      <motion.div
        className="mt-16 flex items-center justify-center gap-2"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ delay: 0.6 }}
      >
        {steps.map((step, index) => (
          <div key={step.number} className="flex items-center">
            <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-colors ${
              activeStep === step.number || copiedStep === step.number
                ? "border-primary bg-primary/20 text-primary"
                : "border-border bg-background-card text-foreground-muted"
            }`}>
              {step.number}
            </div>
            {index < steps.length - 1 && (
              <div className="w-12 h-0.5 bg-border mx-1" />
            )}
          </div>
        ))}
      </motion.div>
    </ScrollSection>
  )
}

// ============================================================================
// Step Card Component
// ============================================================================

interface StepCardProps {
  step: typeof steps[0]
  isActive: boolean
  isCopied: boolean
  onToggle: () => void
  onCopy: () => void
}

function StepCard({ step, isActive, isCopied, onToggle, onCopy }: StepCardProps) {
  return (
    <motion.div
      className="border border-border rounded-xl overflow-hidden bg-background-card"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: (step.number - 1) * 0.1 }}
    >
      {/* Step header (always visible) */}
      <button
        className="w-full p-4 flex items-center justify-between hover:bg-background-surface/50 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-primary/20 border border-primary flex items-center justify-center font-bold text-sm text-primary">
            {step.number}
          </div>
          <h3 className="text-base font-bold text-foreground">
            {step.title}
          </h3>
        </div>
        <motion.div
          animate={{ rotate: isActive ? 90 : 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
        >
          <ChevronRight className="w-4 h-4 text-foreground-muted" />
        </motion.div>
      </button>

      {/* Expandable content */}
      <AnimatePresence>
        {isActive && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
              {/* Code block */}
              <div className="relative">
                <pre className="bg-background p-4 rounded-lg border border-border overflow-x-auto text-sm font-mono">
                  <code className="text-foreground-secondary">{step.code}</code>
                </pre>
                <motion.button
                  className="absolute top-2 right-2 p-2 rounded-lg border border-border bg-background-card hover:bg-background-surface transition-colors"
                  onClick={onCopy}
                  {...buttonPress}
                >
                  {isCopied ? (
                    <Check className="w-4 h-4 text-secondary" />
                  ) : (
                    <Copy className="w-4 h-4 text-foreground-muted" />
                  )}
                </motion.button>
              </div>

              {/* Explanation */}
              <p className="text-sm text-foreground-secondary leading-relaxed">
                {step.explanation}
              </p>

              {/* Link to docs */}
              <a
                href={step.link.href}
                className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
              >
                {step.link.label} →
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
