"use client"

import { motion } from "framer-motion"
import { ScrollSection } from "@/components/shared/scroll-section"
import { DiagramViewer } from "@/components/diagrams/diagram-viewer"
import { Shield, CheckCircle, Lock } from "lucide-react"
import { staggerCards } from "@/lib/spatial-animations"

const guarantees = [
  {
    icon: Shield,
    title: "All work in .draft/ folder",
    description: "Tests are developed in isolation until they pass, preventing broken commits to your main test suite.",
    color: "cyan",
  },
  {
    icon: CheckCircle,
    title: "Tests run until passing (max 25)",
    description: "Autonomous healing loop fixes failures automatically. Only passing tests are eligible for promotion.",
    color: "green",
  },
  {
    icon: Lock,
    title: "Promotion requires user approval",
    description: "Hooks block automatic promotion. You explicitly approve moving tests from .draft/ to tests/.",
    color: "purple",
  },
]

export function DraftPromotionGuarantee() {
  return (
    <ScrollSection
      id="safety"
      title="Your Codebase Stays Clean"
      subtitle="Safety guarantees that prevent AI from breaking your test suite"
      className="bg-background"
    >
      {/* Diagram */}
      <div className="mb-16 flex justify-center">
        <DiagramViewer
          src="/flow-images/08-draft_promotion.png"
          alt="Draft Promotion Flow - Safety Guarantee"
          size="full"
          animateEntry={true}
          use3D={false}
          className="mx-auto max-w-5xl"
        />
      </div>

      {/* Guarantees */}
      <motion.div
        className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8"
        variants={staggerCards}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
      >
        {guarantees.map((guarantee, index) => {
          const Icon = guarantee.icon
          const colorClasses = {
            cyan: "text-primary border-primary/30 bg-primary/5",
            green: "text-secondary border-secondary/30 bg-secondary/5",
            purple: "text-accent border-accent/30 bg-accent/5",
          }

          return (
            <motion.div
              key={index}
              className="p-6 rounded-xl border border-border bg-background-card hover:border-border/80 transition-colors"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.15 }}
              whileHover={{ y: -4, transition: { type: "spring", stiffness: 400, damping: 25 } }}
            >
              <div className={`w-12 h-12 rounded-lg border flex items-center justify-center mb-4 ${colorClasses[guarantee.color as keyof typeof colorClasses]}`}>
                <Icon className="w-6 h-6" />
              </div>

              <h3 className="text-lg font-bold mb-2 text-foreground">
                {guarantee.title}
              </h3>

              <p className="text-sm text-foreground-secondary leading-relaxed">
                {guarantee.description}
              </p>
            </motion.div>
          )
        })}
      </motion.div>

      {/* Flow visualization */}
      <motion.div
        className="mt-16 max-w-3xl mx-auto"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ delay: 0.5 }}
      >
        <div className="flex items-center justify-center gap-4 text-sm">
          <div className="px-4 py-2 rounded-lg bg-background-card border border-border font-mono">
            .draft/
          </div>
          <div className="text-foreground-muted">→</div>
          <div className="px-4 py-2 rounded-lg bg-accent/10 border border-accent font-mono">
            Heal
          </div>
          <div className="text-foreground-muted">→</div>
          <div className="px-4 py-2 rounded-lg bg-secondary/10 border border-secondary font-mono">
            Success
          </div>
          <div className="text-foreground-muted">→</div>
          <div className="px-4 py-2 rounded-lg bg-background-card border border-primary font-mono">
            tests/
          </div>
        </div>
        <p className="text-center text-xs text-foreground-muted mt-4">
          Promotion only happens with your explicit approval
        </p>
      </motion.div>
    </ScrollSection>
  )
}
