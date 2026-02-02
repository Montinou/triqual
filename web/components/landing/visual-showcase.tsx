"use client"

import { motion, useReducedMotion } from "framer-motion"
import Image from "next/image"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { diagramReveal, viewportDefault } from "@/lib/spatial-animations"

const stages = [
  { name: "ANALYZE", description: "Review requirements", color: "bg-primary/20 text-primary border-primary/40" },
  { name: "RESEARCH", description: "Search patterns", color: "bg-cyan-500/20 text-cyan-400 border-cyan-400/40" },
  { name: "PLAN", description: "Design strategy", color: "bg-secondary/20 text-secondary border-secondary/40" },
  { name: "WRITE", description: "Generate tests", color: "bg-green-400/20 text-green-400 border-green-400/40" },
  { name: "RUN", description: "Execute & heal", color: "bg-accent/20 text-accent border-accent/40" },
  { name: "LEARN", description: "Capture patterns", color: "bg-purple-400/20 text-purple-400 border-purple-400/40" },
]

export function VisualShowcase() {
  const shouldReduceMotion = useReducedMotion()

  if (shouldReduceMotion) {
    return (
      <section className="py-20 md:py-32 px-4 sm:px-6 lg:px-8 bg-background-surface/30">
        <div className="container mx-auto max-w-7xl">
          {/* Section header */}
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 gradient-text">
              The Learning Loop
            </h2>
            <p className="text-lg text-foreground-secondary max-w-2xl mx-auto">
              A documented workflow that captures knowledge at every stage
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-8 lg:gap-12 items-center">
            {/* Left: Large Learning Loop diagram */}
            <div className="relative rounded-xl border border-border/30 overflow-hidden glass p-4">
              <Image
                src="/flow-images/06-learning_loop.png"
                alt="Learning Loop Diagram"
                width={1920}
                height={1440}
                quality={90}
                className="w-full h-auto object-contain rounded-lg"
              />
            </div>

            {/* Right: Stage pills */}
            <div className="space-y-6">
              <div className="space-y-3">
                {stages.map((stage, index) => (
                  <div
                    key={stage.name}
                    className={`flex items-center gap-4 p-3 rounded-lg border ${stage.color} stage-pill`}
                  >
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-background-card flex items-center justify-center text-sm font-bold">
                      {index + 1}
                    </div>
                    <div>
                      <div className="font-bold text-sm">{stage.name}</div>
                      <div className="text-xs opacity-80">{stage.description}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* CTA link */}
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-2 text-primary hover:text-primary/80 font-medium text-sm group transition-colors"
              >
                See the full workflow
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="py-20 md:py-32 px-4 sm:px-6 lg:px-8 bg-background-surface/30 section-reveal">
      <div className="container mx-auto max-w-7xl">
        {/* Section header */}
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewportDefault}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4 gradient-text">
            The Learning Loop
          </h2>
          <p className="text-lg text-foreground-secondary max-w-2xl mx-auto">
            A documented workflow that captures knowledge at every stage
          </p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-8 lg:gap-12 items-center">
          {/* Left: Large Learning Loop diagram with 3D reveal */}
          <motion.div
            className="relative rounded-xl border border-border/30 overflow-hidden glass p-4 group"
            variants={diagramReveal}
            initial="hidden"
            whileInView="visible"
            viewport={viewportDefault}
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
          >
            <Image
              src="/flow-images/06-learning_loop.png"
              alt="Learning Loop Diagram"
              width={1920}
              height={1440}
              quality={90}
              className="w-full h-auto object-contain rounded-lg transition-opacity duration-300 group-hover:opacity-100 opacity-90"
            />

            {/* Hover overlay */}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
              <div className="px-4 py-2 rounded-lg bg-background/90 backdrop-blur-sm border border-primary/50 text-sm text-primary font-medium">
                Click to view full size
              </div>
            </div>
          </motion.div>

          {/* Right: Stage pills with stagger animation */}
          <div className="space-y-6">
            <motion.div
              className="space-y-3"
              initial="hidden"
              whileInView="visible"
              viewport={viewportDefault}
              variants={{
                hidden: { opacity: 0 },
                visible: {
                  opacity: 1,
                  transition: {
                    staggerChildren: 0.08,
                    delayChildren: 0.2,
                  },
                },
              }}
            >
              {stages.map((stage, index) => (
                <motion.div
                  key={stage.name}
                  className={`flex items-center gap-4 p-3 rounded-lg border ${stage.color} stage-pill cursor-default`}
                  variants={{
                    hidden: { opacity: 0, x: 30 },
                    visible: {
                      opacity: 1,
                      x: 0,
                      transition: {
                        duration: 0.4,
                        ease: [0.16, 1, 0.3, 1],
                      },
                    },
                  }}
                  whileHover={{
                    scale: 1.02,
                    x: 8,
                    transition: { type: "spring", stiffness: 400, damping: 17 },
                  }}
                >
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-background-card flex items-center justify-center text-sm font-bold">
                    {index + 1}
                  </div>
                  <div>
                    <div className="font-bold text-sm">{stage.name}</div>
                    <div className="text-xs opacity-80">{stage.description}</div>
                  </div>
                </motion.div>
              ))}
            </motion.div>

            {/* CTA link */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewportDefault}
              transition={{ delay: 0.6 }}
            >
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-2 text-primary hover:text-primary/80 font-medium text-sm group transition-colors"
              >
                See the full workflow
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Link>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  )
}
