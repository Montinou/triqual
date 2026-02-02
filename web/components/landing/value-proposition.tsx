"use client"

import { motion, useReducedMotion } from "framer-motion"
import { Brain, FolderGit2, Plug } from "lucide-react"
import { staggerCards, cardSlideIn, viewportDefault } from "@/lib/spatial-animations"

const benefits = [
  {
    icon: Brain,
    title: "Self-Learning",
    subtitle: "Gets smarter with every failure",
    description: "Each test failure becomes a learning opportunity. Patterns are extracted and stored in Quoth, making future tests more resilient.",
    color: "cyan" as const,
    borderColor: "border-l-primary",
    glowColor: "group-hover:shadow-[0_0_30px_rgba(0,240,255,0.3)]",
    iconBg: "bg-primary/10",
    iconColor: "text-primary",
  },
  {
    icon: FolderGit2,
    title: "Draft-First",
    subtitle: "Tests live in .draft/ until passing",
    description: "No more broken commits. Tests are developed in isolation and only promoted to your test suite when they're stable.",
    color: "green" as const,
    borderColor: "border-l-secondary",
    glowColor: "group-hover:shadow-[0_0_30px_rgba(0,255,136,0.3)]",
    iconBg: "bg-secondary/10",
    iconColor: "text-secondary",
  },
  {
    icon: Plug,
    title: "MCP Integration",
    subtitle: "Quoth + Exolar + Playwright unified",
    description: "Three powerful tools working together: knowledge persistence, failure analytics, and browser automation in one workflow.",
    color: "purple" as const,
    borderColor: "border-l-accent",
    glowColor: "group-hover:shadow-[0_0_30px_rgba(168,85,247,0.3)]",
    iconBg: "bg-accent/10",
    iconColor: "text-accent",
  },
]

export function ValueProposition() {
  const shouldReduceMotion = useReducedMotion()

  if (shouldReduceMotion) {
    return (
      <section className="py-20 md:py-32 px-4 sm:px-6 lg:px-8">
        <div className="container mx-auto max-w-6xl">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
            {benefits.map((benefit, index) => (
              <ValueCard key={index} benefit={benefit} />
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="py-20 md:py-32 px-4 sm:px-6 lg:px-8 section-reveal">
      <div className="container mx-auto max-w-6xl">
        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 stagger-children"
          variants={staggerCards}
          initial="hidden"
          whileInView="visible"
          viewport={viewportDefault}
        >
          {benefits.map((benefit, index) => (
            <motion.div key={index} variants={cardSlideIn}>
              <ValueCard benefit={benefit} />
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

interface ValueCardProps {
  benefit: typeof benefits[0]
}

function ValueCard({ benefit }: ValueCardProps) {
  const Icon = benefit.icon

  return (
    <div
      className={`group relative h-full p-6 rounded-xl border border-border bg-background-card/50 backdrop-blur-sm overflow-hidden transition-all duration-300 hover:border-border/80 value-card border-l-4 ${benefit.borderColor} ${benefit.glowColor}`}
    >
      {/* Background gradient on hover */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
        <div className={`absolute inset-0 bg-gradient-to-br from-${benefit.color === 'cyan' ? 'primary' : benefit.color === 'green' ? 'secondary' : 'accent'}/5 via-transparent to-transparent`} />
      </div>

      <div className="relative z-10">
        {/* Icon */}
        <div className={`w-12 h-12 rounded-lg ${benefit.iconBg} flex items-center justify-center mb-4`}>
          <Icon className={`w-6 h-6 ${benefit.iconColor}`} />
        </div>

        {/* Title */}
        <h3 className="text-xl font-bold mb-1 text-foreground">
          {benefit.title}
        </h3>

        {/* Subtitle */}
        <p className={`text-sm font-medium mb-3 ${benefit.iconColor}`}>
          {benefit.subtitle}
        </p>

        {/* Description */}
        <p className="text-foreground-secondary text-sm leading-relaxed">
          {benefit.description}
        </p>
      </div>

      {/* Decorative corner accent */}
      <div className={`absolute top-0 right-0 w-20 h-20 bg-gradient-to-bl from-${benefit.color === 'cyan' ? 'primary' : benefit.color === 'green' ? 'secondary' : 'accent'}/10 to-transparent rounded-bl-full opacity-0 group-hover:opacity-100 transition-opacity duration-300`} />
    </div>
  )
}
