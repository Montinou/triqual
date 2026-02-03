"use client"

import { motion, useReducedMotion } from "framer-motion"
import Image from "next/image"
import Link from "next/link"
import { ArrowRight, Bot, Shield, Brain } from "lucide-react"
import { viewportDefault } from "@/lib/spatial-animations"

const features = [
  {
    tag: "GENERATION",
    tagColor: "text-secondary bg-secondary/10 border-secondary/30",
    icon: Bot,
    iconColor: "text-secondary",
    title: "One Command, Full Test Suite",
    description:
      "Say /test login and Triqual takes over. It explores your app with Playwright MCP, searches Quoth for proven patterns, queries Exolar for failure history, then generates complete spec files with Page Objects.",
    detail: "Supports tickets (/test --ticket ENG-123), descriptions, or feature names. Each run is documented in a structured run log.",
    image: "/flow-images/02-test_generation_flow.png",
    imageAlt: "Test Generation Flow — from /test command through 6 stages to passing tests",
    imagePosition: "right" as const,
  },
  {
    tag: "HEALING",
    tagColor: "text-primary bg-primary/10 border-primary/30",
    icon: Shield,
    iconColor: "text-primary",
    title: "Self-Healing Agent Loop",
    description:
      "Tests live in .draft/ while the test-healer agent iterates: run, analyze failure, apply fix, run again. Up to 25 attempts with escalating analysis phases. Deep research kicks in at attempt 12.",
    detail: "The failure-classifier categorizes each failure as FLAKE, BUG, ENV, or TEST_ISSUE — no more guessing why tests break.",
    image: "/flow-images/08-draft_promotion.png",
    imageAlt: "Draft to Production — .draft/ heals until PASS then promotes to tests/",
    imagePosition: "left" as const,
  },
  {
    tag: "LEARNING",
    tagColor: "text-accent bg-accent/10 border-accent/30",
    icon: Brain,
    iconColor: "text-accent",
    title: "Every Fix Becomes Team Knowledge",
    description:
      "Five specialized Opus 4.5 agents orchestrate the entire workflow. When tests pass, the pattern-learner extracts what worked and proposes it to Quoth — making every future test generation smarter.",
    detail: "Context survives sessions via .triqual/knowledge.md and run logs. Your team benefits from every failure ever fixed.",
    image: "/flow-images/03-agent_orchestration.png",
    imageAlt: "Agent Orchestration — test-planner, test-generator, test-healer, failure-classifier, pattern-learner",
    imagePosition: "right" as const,
  },
]

export function FeaturePanels() {
  const shouldReduceMotion = useReducedMotion()

  return (
    <section className="py-24 md:py-32">
      {/* Section header */}
      <div className="text-center mb-20 px-4">
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4">
          <span className="gradient-text">What Happens When You Run</span>{" "}
          <code className="text-primary font-mono text-[0.85em]">/test</code>
        </h2>
        <p className="text-lg text-foreground-secondary max-w-2xl mx-auto">
          A documented pipeline from command to passing tests — with autonomous healing at every step
        </p>
      </div>

      {/* Feature panels */}
      <div className="space-y-24 md:space-y-32">
        {features.map((feature, index) => (
          <FeaturePanel
            key={index}
            feature={feature}
            index={index}
            shouldReduceMotion={shouldReduceMotion}
          />
        ))}
      </div>

      {/* Link to full workflow */}
      <div className="text-center mt-16 px-4">
        <Link
          href="/how-it-works"
          className="inline-flex items-center gap-2 text-primary hover:text-primary/80 font-medium group transition-colors"
        >
          See the complete workflow in detail
          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
        </Link>
      </div>
    </section>
  )
}

interface FeaturePanelProps {
  feature: typeof features[0]
  index: number
  shouldReduceMotion: boolean | null
}

function FeaturePanel({ feature, index, shouldReduceMotion }: FeaturePanelProps) {
  const Icon = feature.icon
  const isImageRight = feature.imagePosition === "right"

  const content = (
    <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-12">
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center`}>
        {/* Text */}
        <div className={isImageRight ? "lg:order-1" : "lg:order-2"}>
          {/* Tag */}
          <div className="mb-4">
            <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-mono font-bold tracking-wider ${feature.tagColor}`}>
              <Icon className={`w-3.5 h-3.5 ${feature.iconColor}`} />
              {feature.tag}
            </span>
          </div>

          <h3 className="text-2xl md:text-3xl lg:text-4xl font-bold mb-4 text-foreground leading-tight">
            {feature.title}
          </h3>

          <p className="text-foreground-secondary mb-4 leading-relaxed">
            {feature.description}
          </p>

          <p className="text-sm text-foreground-muted leading-relaxed border-l-2 border-primary/30 pl-4">
            {feature.detail}
          </p>
        </div>

        {/* Image */}
        <div className={isImageRight ? "lg:order-2" : "lg:order-1"}>
          <motion.div
            className="relative rounded-2xl border border-border/20 overflow-hidden bg-background-surface/20 p-1.5 group"
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
          >
            <Image
              src={feature.image}
              alt={feature.imageAlt}
              width={1920}
              height={1440}
              quality={90}
              loading="lazy"
              className="w-full h-auto object-contain rounded-xl opacity-90 group-hover:opacity-100 transition-opacity duration-300"
            />
            {/* Subtle bottom fade */}
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background-surface/40 to-transparent pointer-events-none rounded-b-xl" />
          </motion.div>
        </div>
      </div>
    </div>
  )

  if (shouldReduceMotion) {
    return <div>{content}</div>
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{
        duration: 0.7,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      {content}
    </motion.div>
  )
}
