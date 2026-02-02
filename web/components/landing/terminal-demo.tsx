"use client"

import { motion, useReducedMotion, useInView } from "framer-motion"
import { useRef, useState, useEffect, useCallback } from "react"

const terminalLines = [
  { text: "$ /test login", type: "command" as const, delay: 0 },
  { text: "", type: "blank" as const, delay: 400 },
  { text: "triqual_load_context({ feature: \"login\" })", type: "mcp" as const, delay: 600 },
  { text: "  ├── patterns.md        (12 Quoth patterns found)", type: "output" as const, delay: 900 },
  { text: "  ├── anti-patterns.md   (3 known failures to avoid)", type: "output" as const, delay: 1100 },
  { text: "  ├── codebase.md        (LoginPage.ts, auth helpers)", type: "output" as const, delay: 1300 },
  { text: "  └── failures.md        (2 Exolar failure clusters)", type: "output" as const, delay: 1500 },
  { text: "", type: "blank" as const, delay: 1700 },
  { text: "▸ test-planner  ANALYZE → RESEARCH → PLAN", type: "agent" as const, delay: 1900 },
  { text: "  Run log created: .triqual/runs/login.md", type: "success" as const, delay: 2300 },
  { text: "", type: "blank" as const, delay: 2500 },
  { text: "▸ test-generator  Writing .draft/tests/login.spec.ts", type: "agent" as const, delay: 2700 },
  { text: "  Generated 4 test cases with LoginPage object", type: "success" as const, delay: 3100 },
  { text: "", type: "blank" as const, delay: 3300 },
  { text: "▸ test-healer  RUN → FIX → RUN (autonomous loop)", type: "agent" as const, delay: 3500 },
  { text: "  Attempt 1: FAILED — WAIT category", type: "fail" as const, delay: 3900 },
  { text: "  Fix: Added networkidle wait after auth redirect", type: "output" as const, delay: 4200 },
  { text: "  Attempt 2: PASSED ✓", type: "pass" as const, delay: 4600 },
  { text: "", type: "blank" as const, delay: 4800 },
  { text: "▸ pattern-learner  Capturing to knowledge.md", type: "agent" as const, delay: 5000 },
  { text: "  Pattern: \"Auth redirect requires networkidle\"", type: "success" as const, delay: 5300 },
  { text: "", type: "blank" as const, delay: 5500 },
  { text: "✓ Tests passing in .draft/ — awaiting promotion approval", type: "final" as const, delay: 5700 },
]

const typeColors: Record<string, string> = {
  command: "text-foreground font-bold",
  blank: "",
  mcp: "text-accent",
  output: "text-foreground-muted",
  agent: "text-primary font-semibold",
  success: "text-secondary",
  fail: "text-destructive",
  pass: "text-secondary font-bold",
  final: "text-secondary font-bold",
}

export function TerminalDemo() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })
  const [visibleLines, setVisibleLines] = useState(0)
  const [hasStarted, setHasStarted] = useState(false)

  const startAnimation = useCallback(() => {
    if (hasStarted) return
    setHasStarted(true)

    terminalLines.forEach((line, index) => {
      setTimeout(() => {
        setVisibleLines(index + 1)
      }, line.delay)
    })
  }, [hasStarted])

  useEffect(() => {
    if (isInView && !hasStarted) {
      if (shouldReduceMotion) {
        setVisibleLines(terminalLines.length)
        setHasStarted(true)
      } else {
        startAnimation()
      }
    }
  }, [isInView, hasStarted, shouldReduceMotion, startAnimation])

  return (
    <section ref={ref} className="py-20 md:py-28 px-4 sm:px-6 lg:px-12">
      <div className="container mx-auto max-w-4xl">
        {/* Header */}
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 text-foreground">
            See It In Action
          </h2>
          <p className="text-foreground-secondary max-w-xl mx-auto">
            One command triggers the entire autonomous pipeline
          </p>
        </div>

        {/* Terminal window */}
        <div className="relative">
          {/* Terminal chrome */}
          <div className="rounded-2xl border border-border/40 overflow-hidden bg-background-card/80 backdrop-blur-sm shadow-2xl shadow-black/40">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 bg-background-surface/50">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-destructive/60" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                <div className="w-3 h-3 rounded-full bg-secondary/60" />
              </div>
              <span className="text-xs text-foreground-muted font-mono ml-2">claude — triqual</span>
            </div>

            {/* Terminal content */}
            <div className="p-5 sm:p-6 font-mono text-sm leading-relaxed min-h-[420px] overflow-hidden">
              {terminalLines.slice(0, visibleLines).map((line, index) => {
                if (line.type === "blank") {
                  return <div key={index} className="h-4" />
                }

                const colorClass = typeColors[line.type] || "text-foreground-secondary"

                if (shouldReduceMotion) {
                  return (
                    <div key={index} className={`${colorClass} whitespace-pre`}>
                      {line.text}
                    </div>
                  )
                }

                return (
                  <motion.div
                    key={index}
                    className={`${colorClass} whitespace-pre`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                  >
                    {line.text}
                  </motion.div>
                )
              })}

              {/* Blinking cursor */}
              {visibleLines >= terminalLines.length && (
                <motion.span
                  className="inline-block w-2 h-4 bg-primary ml-0.5 mt-2"
                  animate={{ opacity: [1, 0] }}
                  transition={{ duration: 0.8, repeat: Infinity, ease: "linear", times: [0, 0.5, 0.5, 1] }}
                />
              )}
            </div>
          </div>

          {/* Glow effect behind terminal */}
          <div className="absolute -inset-6 bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.06)_0%,transparent_70%)] pointer-events-none -z-10 rounded-3xl" />
        </div>
      </div>
    </section>
  )
}
