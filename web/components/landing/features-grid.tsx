"use client"

import { motion, useReducedMotion, useInView } from "framer-motion"
import { useRef } from "react"
import { Card, CardContent } from "@/components/ui/card"
import {
  Rocket,
  RefreshCw,
  Brain,
  BarChart3,
  Ticket,
  Plug,
} from "lucide-react"

const features = [
  {
    icon: Rocket,
    title: "Quick Testing",
    description:
      "Just describe what you want to test. Claude launches a visible browser, executes your test, and reports results in real-time.",
  },
  {
    icon: RefreshCw,
    title: "Auto-Healing",
    description:
      "When tests fail, the system automatically attempts to fix locators, add waits, and update assertions with 3 retry attempts.",
  },
  {
    icon: Brain,
    title: "Pattern Learning",
    description:
      "Searches Quoth for documented patterns before writing tests. Failures become new patterns for future improvement.",
  },
  {
    icon: BarChart3,
    title: "Analytics Dashboard",
    description:
      "Results flow to Exolar for failure clustering, flake detection, and historical trend analysis.",
  },
  {
    icon: Ticket,
    title: "Ticket Integration",
    description:
      "Generate complete test suites from Linear tickets with automatic PR creation and CI integration.",
  },
  {
    icon: Plug,
    title: "Works Standalone",
    description:
      "Fully functional without MCP servers. Connect Quoth, Exolar, or Linear for enhanced capabilities.",
  },
]

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 40 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
}

export function FeaturesGrid() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  if (shouldReduceMotion) {
    return (
      <section id="features" className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12 sm:mb-16">
            <p className="font-mono text-sm text-primary uppercase tracking-widest mb-4">
              Capabilities
            </p>
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
              Everything You Need
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="bg-background-surface border-white/5 hover:border-primary/25 hover:bg-background-elevated transition-all duration-300 group overflow-hidden relative h-full shadow-[0_0_20px_rgba(0,240,255,0.08)] hover:shadow-[0_0_30px_rgba(0,240,255,0.25)] hover:scale-105"
              >
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-primary to-secondary opacity-0 group-hover:opacity-100 transition-opacity" />
                <CardContent className="p-6 sm:p-8">
                  <div className="w-14 h-14 rounded-xl bg-background-card border border-white/10 flex items-center justify-center mb-5">
                    <feature.icon className="w-6 h-6 text-foreground-secondary group-hover:text-primary transition-colors" />
                  </div>
                  <h3 className="text-xl font-bold mb-3">{feature.title}</h3>
                  <p className="text-foreground-secondary leading-relaxed">
                    {feature.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section
      id="features"
      ref={ref}
      className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8"
    >
      <div className="max-w-6xl mx-auto">
        <motion.div
          className="text-center mb-12 sm:mb-16"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] as const }}
        >
          <p className="font-mono text-sm text-primary uppercase tracking-widest mb-4">
            Capabilities
          </p>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
            Everything You Need
          </h2>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr"
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          variants={containerVariants}
        >
          {features.map((feature) => (
            <motion.div key={feature.title} variants={itemVariants} className="h-full">
              <motion.div
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 1.02 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] as const }}
                className="h-full cursor-pointer"
              >
                <Card className="bg-background-surface border-white/5 hover:border-primary/25 hover:bg-background-elevated transition-all group overflow-hidden relative h-full shadow-[0_0_20px_rgba(0,240,255,0.08)] hover:shadow-[0_0_30px_rgba(0,240,255,0.25)]">
                  <motion.div
                    className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-primary to-secondary"
                    initial={{ scaleX: 0 }}
                    whileHover={{ scaleX: 1 }}
                    transition={{ duration: 0.3 }}
                    style={{ originX: 0 }}
                  />
                  <CardContent className="p-6 sm:p-8">
                    <div className="w-14 h-14 rounded-xl bg-background-card border border-white/10 flex items-center justify-center mb-5">
                      <feature.icon className="w-6 h-6 text-foreground-secondary group-hover:text-primary transition-colors" />
                    </div>
                    <h3 className="text-xl font-bold mb-3">{feature.title}</h3>
                    <p className="text-foreground-secondary leading-relaxed">
                      {feature.description}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
