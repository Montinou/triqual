"use client"

import { motion } from "framer-motion"
import { ScrollSection } from "@/components/shared/scroll-section"
import { DiagramViewer } from "@/components/diagrams/diagram-viewer"
import { Check } from "lucide-react"
import { staggerFast } from "@/lib/spatial-animations"

const benefits = [
  "Failures trigger pattern extraction automatically",
  "Patterns stored in Quoth knowledge base for team-wide access",
  "Future tests leverage past learnings from day one",
  "Your entire team benefits from every fix",
]

export function LearningLoopShowcase() {
  return (
    <ScrollSection
      id="learning-loop"
      title="Triqual Gets Smarter With Every Test"
      subtitle="The documented learning cycle that makes your test suite self-improving"
      className="bg-background-surface/30"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-8 items-start">
        {/* Left: Diagram - BIGGER */}
        <div className="order-2 lg:order-1">
          <DiagramViewer
            src="/flow-images/06-learning_loop.png"
            alt="Learning Loop - Hexagon Cycle"
            size="full"
            animateEntry={true}
            use3D={false}
            className="mx-auto"
          />
        </div>

        {/* Right: Benefits - MORE COMPACT */}
        <motion.div
          className="order-1 lg:order-2 space-y-4"
          variants={staggerFast}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
        >
          <div className="space-y-3">
            {benefits.map((benefit, index) => (
              <motion.div
                key={index}
                className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-background-card hover:border-secondary/50 transition-colors"
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <div className="flex-shrink-0 mt-0.5">
                  <div className="w-5 h-5 rounded-full bg-secondary/20 border border-secondary flex items-center justify-center">
                    <Check className="w-3 h-3 text-secondary" />
                  </div>
                </div>
                <p className="text-sm text-foreground-secondary leading-relaxed">
                  {benefit}
                </p>
              </motion.div>
            ))}
          </div>

          <motion.div
            className="pt-4 border-t border-border mt-4"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.5 }}
          >
            <p className="text-xs text-foreground-muted italic">
              "Every test failure becomes a learning opportunity. Every fix becomes team knowledge."
            </p>
          </motion.div>
        </motion.div>
      </div>

      {/* Cycle explanation */}
      <motion.div
        className="mt-12 max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ delay: 0.6 }}
      >
        {["ANALYZE", "RESEARCH", "PLAN", "WRITE", "RUN", "LEARN"].map((stage, index) => (
          <div
            key={stage}
            className="text-center p-3 rounded-lg border border-border/30 bg-background-card/50"
          >
            <div className="text-[10px] text-foreground-muted mb-1">Step {index + 1}</div>
            <div className="text-xs font-bold text-primary">{stage}</div>
          </div>
        ))}
      </motion.div>
    </ScrollSection>
  )
}
