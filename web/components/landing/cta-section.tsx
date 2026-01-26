"use client"

import { motion, useReducedMotion, useInView } from "framer-motion"
import { useRef } from "react"
import { Github } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"

export function CTASection() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  const content = (
    <div className="max-w-3xl mx-auto">
      <div className="relative p-8 sm:p-12 md:p-16 bg-background-surface border border-primary/25 rounded-3xl overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.15)_0%,transparent_70%)] pointer-events-none" />

        <div className="relative z-10 text-center">
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-extrabold mb-4">
            Ready to Automate Smarter?
          </h2>
          <p className="text-lg text-foreground-secondary mb-8">
            Join the intelligent test automation revolution.
            Works with any Playwright project.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
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
                  className="border-white/20 hover:bg-background-card hover:border-primary/40"
                >
                  <Link href="#features">Explore Features</Link>
                </Button>
              </>
            ) : (
              <>
                <motion.div
                  whileHover={{ y: -2, scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
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
                <motion.div
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Button
                    asChild
                    variant="outline"
                    size="lg"
                    className="border-white/20 hover:bg-background-card hover:border-primary/40 transition-all"
                  >
                    <Link href="#features">Explore Features</Link>
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
      <section className="py-16 sm:py-24 md:py-32 px-4 sm:px-6 lg:px-8">
        {content}
      </section>
    )
  }

  return (
    <motion.section
      ref={ref}
      className="py-16 sm:py-24 md:py-32 px-4 sm:px-6 lg:px-8"
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] as const }}
    >
      {content}
    </motion.section>
  )
}
