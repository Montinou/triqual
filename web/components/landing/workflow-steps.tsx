"use client"

import { motion, useReducedMotion, useInView } from "framer-motion"
import { useRef } from "react"

const steps = [
  {
    number: 1,
    title: "Search Patterns",
    description:
      "Before writing any test, Quolar searches Quoth for existing patterns, Page Objects, and anti-patterns to follow.",
  },
  {
    number: 2,
    title: "Execute Tests",
    description:
      "Playwright runs your tests with visible browser, retry logic, and intelligent waits for reliable execution.",
  },
  {
    number: 3,
    title: "Analyze Results",
    description:
      "Results flow to Exolar for failure clustering, flake detection, and pattern recognition across test runs.",
  },
  {
    number: 4,
    title: "Learn & Improve",
    description:
      "Repeated failures trigger pattern-learner to propose new documentation, making future tests smarter.",
  },
]

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.3,
    },
  },
}

const stepVariants = {
  hidden: { opacity: 0, x: -30 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
}

const lineVariants = {
  hidden: { scaleY: 0 },
  visible: {
    scaleY: 1,
    transition: {
      duration: 1.2,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
}

export function WorkflowSteps() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  if (shouldReduceMotion) {
    return (
      <section id="workflow" className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12 sm:mb-16">
            <p className="font-mono text-sm text-primary uppercase tracking-widest mb-4">
              The Learning Loop
            </p>
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
              How It Works
            </h2>
          </div>

          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-6 top-12 bottom-12 w-0.5 bg-gradient-to-b from-primary via-secondary to-accent" />

            <div className="space-y-0">
              {steps.map((step) => (
                <div key={step.number} className="flex gap-6 sm:gap-8 py-6">
                  <div className="relative z-10 flex-shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-background-card border-2 border-primary flex items-center justify-center font-mono font-bold text-lg text-primary">
                    {step.number}
                  </div>
                  <div className="pt-2">
                    <h3 className="text-xl sm:text-2xl font-bold mb-2">{step.title}</h3>
                    <p className="text-foreground-secondary">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section ref={ref} id="workflow" className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <motion.div
          className="text-center mb-12 sm:mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] as const }}
        >
          <p className="font-mono text-sm text-primary uppercase tracking-widest mb-4">
            The Learning Loop
          </p>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
            How It Works
          </h2>
        </motion.div>

        <div className="relative">
          {/* Animated timeline line */}
          <motion.div
            className="absolute left-6 top-12 bottom-12 w-0.5 origin-top overflow-hidden"
            initial="hidden"
            animate={isInView ? "visible" : "hidden"}
            variants={lineVariants}
          >
            <div className="absolute inset-0 w-full h-[200%] bg-gradient-to-b from-primary via-secondary via-accent via-primary to-secondary animate-flow-line" />
          </motion.div>

          <motion.div
            className="space-y-0"
            initial="hidden"
            animate={isInView ? "visible" : "hidden"}
            variants={containerVariants}
          >
            {steps.map((step) => (
              <motion.div
                key={step.number}
                className="flex gap-6 sm:gap-8 py-6"
                variants={stepVariants}
              >
                <motion.div
                  className="relative z-10 flex-shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-background-card border-2 border-primary flex items-center justify-center font-mono font-bold text-lg text-primary"
                  whileHover={{
                    scale: 1.1,
                    boxShadow: "0 0 30px rgba(0, 240, 255, 0.5), 0 0 60px rgba(0, 240, 255, 0.2)",
                  }}
                  transition={{ duration: 0.3 }}
                >
                  {step.number}
                </motion.div>
                <div className="pt-2">
                  <h3 className="text-xl sm:text-2xl font-bold mb-2">{step.title}</h3>
                  <p className="text-foreground-secondary">{step.description}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  )
}
