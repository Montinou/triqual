"use client"

import { motion, useReducedMotion } from "framer-motion"
import { viewportDefault } from "@/lib/spatial-animations"

const integrations = [
  {
    name: "Playwright",
    description: "Browser automation",
    color: "bg-green-500/10 text-green-400 border-green-500/30",
    hoverGlow: "hover:shadow-[0_0_20px_rgba(34,197,94,0.3)]",
  },
  {
    name: "Quoth",
    description: "Pattern knowledge base",
    color: "bg-primary/10 text-primary border-primary/30",
    hoverGlow: "hover:shadow-[0_0_20px_rgba(0,240,255,0.3)]",
  },
  {
    name: "Exolar",
    description: "Test analytics",
    color: "bg-accent/10 text-accent border-accent/30",
    hoverGlow: "hover:shadow-[0_0_20px_rgba(168,85,247,0.3)]",
  },
]

export function TrustSignals() {
  const shouldReduceMotion = useReducedMotion()

  if (shouldReduceMotion) {
    return (
      <section className="py-16 md:py-24 px-4 sm:px-6 lg:px-8">
        <div className="container mx-auto max-w-4xl text-center">
          {/* Built for Claude Code badge */}
          <div className="mb-8">
            <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/30 bg-primary/5 text-sm font-medium text-primary">
              <span className="w-2 h-2 rounded-full bg-primary" />
              Built for Claude Code
            </span>
          </div>

          {/* Headline */}
          <h2 className="text-2xl md:text-3xl font-bold mb-4 text-foreground">
            Powered by Three Integrated Systems
          </h2>
          <p className="text-foreground-secondary mb-10 max-w-xl mx-auto">
            Each component brings unique capabilities that work together seamlessly
          </p>

          {/* Integration pills */}
          <div className="flex flex-wrap justify-center gap-4">
            {integrations.map((integration) => (
              <div
                key={integration.name}
                className={`flex items-center gap-3 px-5 py-3 rounded-xl border ${integration.color} transition-all duration-300`}
              >
                <div>
                  <div className="font-bold text-sm">{integration.name}</div>
                  <div className="text-xs opacity-80">{integration.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="py-16 md:py-24 px-4 sm:px-6 lg:px-8 section-reveal">
      <div className="container mx-auto max-w-4xl text-center">
        {/* Built for Claude Code badge */}
        <motion.div
          className="mb-8"
          initial={{ opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={viewportDefault}
          transition={{ duration: 0.5 }}
        >
          <motion.span
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/30 bg-primary/5 text-sm font-medium text-primary"
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
          >
            <motion.span
              className="w-2 h-2 rounded-full bg-primary"
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            />
            Built for Claude Code
          </motion.span>
        </motion.div>

        {/* Headline */}
        <motion.h2
          className="text-2xl md:text-3xl font-bold mb-4 text-foreground"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewportDefault}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          Powered by Three Integrated Systems
        </motion.h2>
        <motion.p
          className="text-foreground-secondary mb-10 max-w-xl mx-auto"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewportDefault}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          Each component brings unique capabilities that work together seamlessly
        </motion.p>

        {/* Integration pills */}
        <motion.div
          className="flex flex-wrap justify-center gap-4"
          initial="hidden"
          whileInView="visible"
          viewport={viewportDefault}
          variants={{
            hidden: { opacity: 0 },
            visible: {
              opacity: 1,
              transition: {
                staggerChildren: 0.1,
                delayChildren: 0.3,
              },
            },
          }}
        >
          {integrations.map((integration) => (
            <motion.div
              key={integration.name}
              className={`flex items-center gap-3 px-5 py-3 rounded-xl border ${integration.color} ${integration.hoverGlow} transition-all duration-300 cursor-default`}
              variants={{
                hidden: { opacity: 0, y: 20, scale: 0.95 },
                visible: {
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  transition: {
                    duration: 0.4,
                    ease: [0.16, 1, 0.3, 1],
                  },
                },
              }}
              whileHover={{
                scale: 1.02,
                y: -4,
                transition: { type: "spring", stiffness: 400, damping: 17 },
              }}
            >
              <div>
                <div className="font-bold text-sm">{integration.name}</div>
                <div className="text-xs opacity-80">{integration.description}</div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
