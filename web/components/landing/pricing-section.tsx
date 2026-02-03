"use client"

import { motion, useReducedMotion } from "framer-motion"
import { Check, Github } from "lucide-react"
import { Button } from "@/components/ui/button"

const tiers = [
  {
    name: "Free",
    badge: "Open Source",
    price: "$0",
    period: "forever",
    description: "Everything you need to start automating tests locally.",
    features: [
      "Local Claude Code plugin",
      "5 healing attempts per test",
      "Playwright test generation",
      "Pattern learning via Quoth",
      "Community support",
    ],
    cta: "View on GitHub",
    ctaHref: "https://github.com/Montinou/triqual",
    ctaExternal: true,
    highlight: true,
    glowColor: "primary",
  },
  {
    name: "Pro",
    badge: "Coming Soon",
    price: "$19",
    period: "/mo",
    description: "Enhanced healing and cloud sync for individual developers.",
    features: [
      "25 healing attempts per test",
      "Cloud sync for knowledge base",
      "Advanced failure analytics",
      "Email support",
      "Priority pattern updates",
    ],
    cta: "Join Waitlist",
    ctaHref: "#",
    ctaExternal: false,
    highlight: false,
    glowColor: "secondary",
  },
  {
    name: "Team",
    badge: "Coming Soon",
    price: "$49",
    period: "/seat/mo",
    description: "Shared knowledge and analytics for engineering teams.",
    features: [
      "Everything in Pro",
      "Shared knowledge base",
      "Multi-tenant analytics",
      "Team pattern governance",
      "Priority support",
    ],
    cta: "Join Waitlist",
    ctaHref: "#",
    ctaExternal: false,
    highlight: false,
    glowColor: "accent",
  },
]

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.2,
    },
  },
}

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
}

export function PricingSection() {
  const shouldReduceMotion = useReducedMotion()

  const cards = tiers.map((tier) => (
    <div
      key={tier.name}
      className={`relative flex flex-col p-6 sm:p-8 rounded-2xl border transition-all duration-300 group ${
        tier.highlight
          ? "border-primary/40 bg-background-surface shadow-[0_0_30px_rgba(0,240,255,0.1)]"
          : "border-white/10 bg-background-surface/60 hover:border-white/20"
      }`}
    >
      {/* Badge */}
      <div className="mb-4">
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono font-bold ${
            tier.highlight
              ? "bg-primary/10 text-primary border border-primary/30"
              : "bg-white/5 text-foreground-muted border border-white/10"
          }`}
        >
          {tier.badge}
        </span>
      </div>

      {/* Name & Price */}
      <h3 className="text-xl font-bold text-foreground mb-1">{tier.name}</h3>
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-3xl font-extrabold text-foreground">{tier.price}</span>
        <span className="text-sm text-foreground-muted">{tier.period}</span>
      </div>
      <p className="text-sm text-foreground-secondary mb-6">{tier.description}</p>

      {/* Features */}
      <ul className="space-y-3 mb-8 flex-1">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-sm text-foreground-secondary">
            <Check className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
            {feature}
          </li>
        ))}
      </ul>

      {/* CTA */}
      {tier.ctaExternal ? (
        <Button
          asChild
          className={
            tier.highlight
              ? "bg-gradient-to-r from-primary to-secondary text-background font-semibold w-full"
              : "border-white/15 w-full"
          }
          variant={tier.highlight ? "default" : "outline"}
        >
          <a href={tier.ctaHref} target="_blank" rel="noopener noreferrer">
            {tier.highlight && <Github className="w-4 h-4 mr-2" />}
            {tier.cta}
          </a>
        </Button>
      ) : (
        <Button
          variant="outline"
          className="border-white/15 w-full cursor-not-allowed opacity-60"
          disabled
        >
          {tier.cta}
        </Button>
      )}

      {/* Hover glow */}
      <div
        className={`absolute -inset-[1px] rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none -z-10 ${
          tier.glowColor === "primary"
            ? "bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.08)_0%,transparent_70%)]"
            : tier.glowColor === "secondary"
            ? "bg-[radial-gradient(ellipse_at_center,rgba(0,255,136,0.06)_0%,transparent_70%)]"
            : "bg-[radial-gradient(ellipse_at_center,rgba(168,85,247,0.06)_0%,transparent_70%)]"
        }`}
      />
    </div>
  ))

  if (shouldReduceMotion) {
    return (
      <section className="py-24 md:py-32 px-4 sm:px-6 lg:px-12">
        <div className="container mx-auto max-w-6xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4">
              <span className="gradient-text">Simple Pricing</span>
            </h2>
            <p className="text-lg text-foreground-secondary max-w-xl mx-auto">
              Start free. Scale when you&apos;re ready.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
            {cards}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="py-24 md:py-32 px-4 sm:px-6 lg:px-12">
      <div className="container mx-auto max-w-6xl">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4">
            <span className="gradient-text">Simple Pricing</span>
          </h2>
          <p className="text-lg text-foreground-secondary max-w-xl mx-auto">
            Start free. Scale when you&apos;re ready.
          </p>
        </motion.div>
        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={containerVariants}
        >
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.name}
              variants={cardVariants}
              whileHover={{ scale: 1.01 }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
            >
              {cards[i]}
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
