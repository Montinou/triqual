"use client"

import { motion, useReducedMotion } from "framer-motion"
import { Github, Code2, Cpu, User, Users, Star } from "lucide-react"

const badges = [
  {
    icon: Github,
    label: "Open Source",
    href: "https://github.com/Montinou/triqual",
    color: "border-white/10 text-foreground-secondary hover:border-primary/40 hover:text-primary",
  },
  {
    icon: Star,
    label: "Star on GitHub",
    href: "https://github.com/Montinou/triqual",
    color: "border-yellow-500/20 text-yellow-400/80 hover:border-yellow-500/40 hover:text-yellow-400",
  },
  {
    icon: Cpu,
    label: "5 Opus 4.5 Agents",
    color: "border-accent/20 text-accent",
  },
  {
    icon: User,
    label: "Built by a QA Engineer",
    color: "border-secondary/20 text-secondary",
  },
  {
    icon: Users,
    label: "Built for Claude Code Developers",
    color: "border-primary/20 text-primary",
  },
]

export function SocialProofBar() {
  const shouldReduceMotion = useReducedMotion()

  const content = (
    <div className="container mx-auto max-w-5xl px-4 sm:px-6 lg:px-12">
      <div className="flex flex-wrap items-center justify-center gap-3">
        {badges.map((badge) => {
          const Icon = badge.icon
          const inner = (
            <span
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border text-xs font-mono font-medium transition-all duration-300 glass-badge ${badge.color}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {badge.label}
            </span>
          )

          if (badge.href) {
            return (
              <a
                key={badge.label}
                href={badge.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {inner}
              </a>
            )
          }

          return <span key={badge.label}>{inner}</span>
        })}
      </div>
    </div>
  )

  if (shouldReduceMotion) {
    return (
      <section className="py-10 border-y border-white/5">
        {content}
      </section>
    )
  }

  return (
    <motion.section
      className="py-10 border-y border-white/5"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      {content}
    </motion.section>
  )
}
