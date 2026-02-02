"use client"

import { motion } from "framer-motion"
import { X } from "lucide-react"
import { ScrollSection } from "@/components/shared/scroll-section"
import { staggerCards, cardSlideIn, cardSlideInRight } from "@/lib/spatial-animations"

const problems = [
  {
    icon: "❌",
    title: "Brittle Locators",
    description: "Selectors break on every UI change",
    detail: "Hard-coded CSS selectors and XPath expressions become invalid whenever designers update layouts.",
    solution: "Triqual learns selector patterns from your codebase and adapts automatically.",
    animateFrom: "left",
  },
  {
    icon: "❌",
    title: "Manual Fixes",
    description: "Fixing same failures forever",
    detail: "Every test failure requires manual investigation, diagnosis, and fix - wasting hours daily.",
    solution: "Autonomous healing with up to 25 fix attempts and documented learning.",
    animateFrom: "center",
  },
  {
    icon: "❌",
    title: "Isolated Knowledge",
    description: "Every dev reinvents solutions",
    detail: "Fixes and patterns live in individual developer's heads, not shared across the team.",
    solution: "All learnings captured in Quoth knowledge base, benefiting your entire team.",
    animateFrom: "right",
  },
]

export function ProblemValidation() {
  return (
    <ScrollSection
      id="problem"
      title="Why Test Automation Fails"
      subtitle="Traditional approaches create more problems than they solve"
      className="bg-background-surface/30"
    >
      <motion.div
        className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8"
        variants={staggerCards}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
      >
        {problems.map((problem, index) => (
          <ProblemCard key={index} problem={problem} index={index} />
        ))}
      </motion.div>

      {/* Bridge statement */}
      <motion.div
        className="mt-16 text-center"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ delay: 0.6 }}
      >
        <p className="text-xl md:text-2xl font-semibold gradient-text-shimmer">
          Triqual eliminates all three
        </p>
      </motion.div>
    </ScrollSection>
  )
}

// ============================================================================
// Problem Card Component
// ============================================================================

interface ProblemCardProps {
  problem: typeof problems[0]
  index: number
}

function ProblemCard({ problem, index }: ProblemCardProps) {
  const variants = {
    left: cardSlideIn,
    center: cardSlideIn,
    right: cardSlideInRight,
  }

  return (
    <motion.div
      className="group relative"
      variants={variants[problem.animateFrom as keyof typeof variants]}
    >
      {/* Card */}
      <div className="relative h-full p-6 rounded-xl border border-border bg-background-card overflow-hidden transition-all duration-300 hover:border-destructive/50">
        {/* Red glow on hover */}
        <div className="absolute inset-0 bg-gradient-to-br from-destructive/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

        <div className="relative z-10">
          {/* Icon */}
          <div className="text-4xl mb-4 flex items-center gap-3">
            <span className="animate-pulse-glow">{problem.icon}</span>
            <X className="w-6 h-6 text-destructive" />
          </div>

          {/* Title */}
          <h3 className="text-xl font-bold mb-2 text-foreground">
            {problem.title}
          </h3>

          {/* Description */}
          <p className="text-foreground-secondary mb-4">
            {problem.description}
          </p>

          {/* Detail */}
          <p className="text-sm text-foreground-muted mb-6 leading-relaxed">
            {problem.detail}
          </p>

          {/* Solution hint (revealed on hover) */}
          <div className="pt-4 border-t border-border/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            <p className="text-sm font-medium text-primary">
              ✓ {problem.solution}
            </p>
          </div>
        </div>

        {/* Decorative corner accent */}
        <div className="absolute top-0 right-0 w-24 h-24 bg-destructive/5 rounded-bl-full opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>
    </motion.div>
  )
}
