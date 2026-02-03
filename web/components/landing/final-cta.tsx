"use client"

import { useState } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { Copy, Check, ArrowRight, Github, BookOpen } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { viewportDefault } from "@/lib/spatial-animations"

const installCommand = "/plugin install triqual"

export function FinalCTA() {
  const shouldReduceMotion = useReducedMotion()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }

  const inner = (
    <div className="container mx-auto max-w-5xl px-4 sm:px-6 lg:px-12">
      <div className="relative p-8 sm:p-12 lg:p-16 rounded-3xl border border-primary/20 bg-background-surface overflow-hidden">
        {/* Layered background glows */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/8 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-accent/6 rounded-full blur-3xl" />
        </div>

        <div className="relative z-10">
          {/* Top row: version + built for */}
          <div className="flex flex-wrap items-center justify-center gap-3 mb-8">
            <span className="px-3 py-1 rounded-full border border-secondary/30 bg-secondary/10 text-secondary text-xs font-mono font-bold">
              v1.4.0
            </span>
            <span className="px-3 py-1 rounded-full border border-primary/30 bg-primary/5 text-primary text-xs font-mono">
              Built for Claude Code
            </span>
            <span className="px-3 py-1 rounded-full border border-accent/30 bg-accent/5 text-accent text-xs font-mono">
              Opus 4.5 Agents
            </span>
          </div>

          {/* Headline */}
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-center mb-4 leading-tight">
            Stop Fixing Tests Manually
          </h2>
          <p className="text-center text-lg text-foreground-secondary mb-10 max-w-xl mx-auto">
            Install Triqual. Run <code className="text-primary font-mono">/test</code>. Let
            the agents handle the rest.
          </p>

          {/* Install command - prominent */}
          <div id="install" className="max-w-lg mx-auto mb-10">
            <div className="flex items-center gap-2 p-4 rounded-xl bg-background-card border border-border/60 font-mono text-base group hover:border-primary/40 transition-colors">
              <span className="text-foreground-muted select-none">$</span>
              <code className="flex-1 text-primary font-semibold">{installCommand}</code>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 p-2 rounded-lg hover:bg-background-elevated transition-colors"
                aria-label={copied ? "Copied" : "Copy to clipboard"}
              >
                {copied ? (
                  <Check className="w-4 h-4 text-secondary" />
                ) : (
                  <Copy className="w-4 h-4 text-foreground-muted group-hover:text-foreground transition-colors" />
                )}
              </button>
            </div>
            {copied && (
              <p className="mt-2 text-center text-xs text-secondary font-mono">Copied to clipboard</p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {shouldReduceMotion ? (
              <>
                <Button
                  asChild
                  size="lg"
                  className="bg-gradient-to-r from-primary to-secondary text-background font-semibold glow-cyan"
                >
                  <a
                    href="https://github.com/Montinou/triqual"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github className="w-5 h-5 mr-2" />
                    View on GitHub
                  </a>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="border-white/15 hover:bg-background-card hover:border-primary/40"
                >
                  <Link href="/docs">
                    <BookOpen className="mr-2 h-5 w-5" />
                    Documentation
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="border-white/15 hover:bg-background-card hover:border-primary/40"
                >
                  <Link href="/how-it-works">
                    How It Works
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Link>
                </Button>
              </>
            ) : (
              <>
                <motion.div whileHover={{ y: -2, scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                  <Button
                    asChild
                    size="lg"
                    className="bg-gradient-to-r from-primary to-secondary text-background font-semibold glow-cyan hover:shadow-[0_0_40px_rgba(0,240,255,0.6),0_0_80px_rgba(0,240,255,0.3)] transition-shadow"
                  >
                    <a
                      href="https://github.com/Montinou/triqual"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Github className="w-5 h-5 mr-2" />
                      View on GitHub
                    </a>
                  </Button>
                </motion.div>
                <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
                  <Button
                    asChild
                    variant="outline"
                    size="lg"
                    className="border-white/15 hover:bg-background-card hover:border-primary/40 transition-all"
                  >
                    <Link href="/docs">
                      <BookOpen className="mr-2 h-5 w-5" />
                      Documentation
                    </Link>
                  </Button>
                </motion.div>
                <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
                  <Button
                    asChild
                    variant="outline"
                    size="lg"
                    className="border-white/15 hover:bg-background-card hover:border-primary/40 transition-all"
                  >
                    <Link href="/how-it-works">
                      How It Works
                      <ArrowRight className="ml-2 h-5 w-5" />
                    </Link>
                  </Button>
                </motion.div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  if (shouldReduceMotion) {
    return (
      <section className="py-20 sm:py-28 md:py-36">
        {inner}
      </section>
    )
  }

  return (
    <motion.section
      className="py-20 sm:py-28 md:py-36"
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewportDefault}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      {inner}
    </motion.section>
  )
}
