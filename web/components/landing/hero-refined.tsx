"use client"

import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion"
import { ArrowRight, Terminal, Github } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useRef } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MagnifyImage } from "@/components/ui/magnify-image"

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.1,
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.7,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
}

const imageVariants = {
  hidden: { opacity: 0, x: 60, rotateY: -8 },
  visible: {
    opacity: 1,
    x: 0,
    rotateY: 0,
    transition: {
      duration: 1,
      ease: [0.16, 1, 0.3, 1] as const,
      delay: 0.3,
    },
  },
}

export function HeroRefined() {
  const shouldReduceMotion = useReducedMotion()
  const sectionRef = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  })

  const imageY = useTransform(scrollYProgress, [0, 1], [0, 60])
  const imageRotate = useTransform(scrollYProgress, [0, 1], [0, 3])

  if (shouldReduceMotion) {
    return (
      <section className="min-h-screen flex items-center px-4 sm:px-6 lg:px-12 pt-28 pb-16">
        <div className="container mx-auto max-w-7xl">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left: Copy */}
            <div>
              <div className="flex items-center gap-3 mb-6">
                <Image
                  src="/triqual_logo.png"
                  alt="Triqual"
                  width={48}
                  height={48}
                  priority
                  className="w-12 h-12"
                  style={{
                    filter: 'drop-shadow(0 0 10px rgba(0, 255, 136, 0.5)) drop-shadow(0 0 10px rgba(168, 85, 247, 0.5)) drop-shadow(0 0 10px rgba(0, 240, 255, 0.5))'
                  }}
                />
                <Badge
                  variant="outline"
                  className="border-primary/40 bg-background-card text-primary font-mono text-xs"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary mr-2" />
                  Claude Code Plugin
                </Badge>
              </div>

              <h1 className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-extrabold tracking-tight mb-6 leading-[0.95]">
                <span className="gradient-text-shimmer">Autonomous</span>
                <br />
                <span className="text-foreground">Test Automation</span>
                <br />
                <span className="text-foreground-secondary text-[0.6em] font-bold">That Learns From Failure</span>
              </h1>

              <p className="text-base text-primary/80 font-mono mb-4">
                Built for QA engineers using Claude Code
              </p>

              <p className="text-lg text-foreground-secondary max-w-lg mb-8 leading-relaxed">
                Triqual writes Playwright tests, runs them, heals failures autonomously,
                and captures every pattern into a persistent knowledge base.
                Up to 25 self-healing attempts per test.
              </p>

              {/* Install command inline */}
              <div className="flex items-center gap-3 mb-8 p-3 rounded-lg bg-background-card/80 border border-border/50 max-w-sm font-mono text-sm">
                <Terminal className="w-4 h-4 text-primary flex-shrink-0" />
                <code className="text-primary">/test login</code>
                <span className="text-foreground-muted">— that&apos;s it</span>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  asChild
                  size="lg"
                  className="bg-gradient-to-r from-primary to-secondary text-background font-semibold glow-cyan hover:opacity-90 transition-opacity"
                >
                  <Link href="/how-it-works">
                    Start Automating Tests
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="border-white/15 hover:bg-background-card hover:border-primary/40"
                >
                  <a href="https://github.com/Montinou/triqual" target="_blank" rel="noopener noreferrer">
                    <Github className="mr-2 h-5 w-5" />
                    View on GitHub
                  </a>
                </Button>
              </div>
            </div>

            {/* Right: Learning Loop diagram */}
            <div className="relative">
              <div className="relative rounded-2xl border border-primary/15 overflow-hidden bg-background-surface/30 p-2 hero-image-border">
                <MagnifyImage
                  src="/flow-images/06-learning_loop.png"
                  alt="Documented Learning Loop — ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN"
                  width={1920}
                  height={1440}
                  quality={90}
                  priority
                  glowColor="cyan"
                />
              </div>
              {/* Decorative glow behind image */}
              <div className="absolute -inset-4 bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.08)_0%,transparent_70%)] pointer-events-none -z-10" />
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section ref={sectionRef} className="min-h-screen flex items-center px-4 sm:px-6 lg:px-12 pt-28 pb-16">
      <div className="container mx-auto max-w-7xl">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left: Copy */}
          <motion.div
            initial="hidden"
            animate="visible"
            variants={containerVariants}
          >
            <motion.div
              className="flex items-center gap-3 mb-6"
              variants={itemVariants}
            >
              <motion.div
                animate={{
                  filter: [
                    'drop-shadow(0 0 10px rgba(0, 255, 136, 0.5)) drop-shadow(0 0 10px rgba(168, 85, 247, 0.5)) drop-shadow(0 0 10px rgba(0, 240, 255, 0.5))',
                    'drop-shadow(0 0 18px rgba(0, 255, 136, 0.7)) drop-shadow(0 0 18px rgba(168, 85, 247, 0.7)) drop-shadow(0 0 18px rgba(0, 240, 255, 0.7))',
                    'drop-shadow(0 0 10px rgba(0, 255, 136, 0.5)) drop-shadow(0 0 10px rgba(168, 85, 247, 0.5)) drop-shadow(0 0 10px rgba(0, 240, 255, 0.5))',
                  ]
                }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              >
                <Image
                  src="/triqual_logo.png"
                  alt="Triqual"
                  width={48}
                  height={48}
                  priority
                  className="w-12 h-12"
                />
              </motion.div>
              <Badge
                variant="outline"
                className="border-primary/40 bg-background-card text-primary font-mono text-xs"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-secondary mr-2 animate-pulse-glow" />
                Claude Code Plugin
              </Badge>
            </motion.div>

            <motion.h1
              className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-extrabold tracking-tight mb-6 leading-[0.95]"
              variants={itemVariants}
            >
              <span className="gradient-text-shimmer">Autonomous</span>
              <br />
              <span className="text-foreground">Test Automation</span>
              <br />
              <span className="text-foreground-secondary text-[0.6em] font-bold">That Learns From Failure</span>
            </motion.h1>

            <motion.p
              className="text-base text-primary/80 font-mono mb-4"
              variants={itemVariants}
            >
              Built for QA engineers using Claude Code
            </motion.p>

            <motion.p
              className="text-lg text-foreground-secondary max-w-lg mb-8 leading-relaxed"
              variants={itemVariants}
            >
              Triqual writes Playwright tests, runs them, heals failures autonomously,
              and captures every pattern into a persistent knowledge base.
              Up to 25 self-healing attempts per test.
            </motion.p>

            {/* Install command inline */}
            <motion.div
              className="flex items-center gap-3 mb-8 p-3 rounded-lg bg-background-card/80 border border-border/50 max-w-sm font-mono text-sm"
              variants={itemVariants}
            >
              <Terminal className="w-4 h-4 text-primary flex-shrink-0" />
              <code className="text-primary">/test login</code>
              <span className="text-foreground-muted">— that&apos;s it</span>
            </motion.div>

            <motion.div
              className="flex flex-col sm:flex-row gap-3"
              variants={itemVariants}
            >
              <motion.div whileHover={{ y: -2, scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                <Button
                  asChild
                  size="lg"
                  className="bg-gradient-to-r from-primary to-secondary text-background font-semibold glow-cyan hover:shadow-[0_0_40px_rgba(0,240,255,0.6),0_0_80px_rgba(0,240,255,0.3)] transition-shadow"
                >
                  <Link href="/how-it-works">
                    Start Automating Tests
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Link>
                </Button>
              </motion.div>
              <motion.div whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="border-white/15 hover:bg-background-card hover:border-primary/40 transition-all"
                >
                  <a href="https://github.com/Montinou/triqual" target="_blank" rel="noopener noreferrer">
                    <Github className="mr-2 h-5 w-5" />
                    View on GitHub
                  </a>
                </Button>
              </motion.div>
            </motion.div>
          </motion.div>

          {/* Right: Learning Loop diagram with parallax */}
          <motion.div
            className="relative"
            initial="hidden"
            animate="visible"
            variants={imageVariants}
            style={{
              perspective: 1200,
              transformStyle: "preserve-3d",
              y: imageY,
              rotateY: imageRotate,
            }}
          >
            <motion.div
              className="relative rounded-2xl border border-primary/15 overflow-hidden bg-background-surface/30 p-2 group hero-image-border"
              whileHover={{ scale: 1.02, rotateY: 2 }}
              transition={{ type: "spring", stiffness: 200, damping: 20 }}
            >
              <MagnifyImage
                src="/flow-images/06-learning_loop.png"
                alt="Documented Learning Loop — ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN"
                width={1920}
                height={1440}
                quality={90}
                priority
                glowColor="cyan"
              />
            </motion.div>
            {/* Decorative glow behind image — layered */}
            <div className="absolute -inset-4 bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.1)_0%,transparent_70%)] pointer-events-none -z-10" />
            <div className="absolute -inset-8 bg-[radial-gradient(ellipse_at_top_right,rgba(168,85,247,0.05)_0%,transparent_60%)] pointer-events-none -z-10" />
          </motion.div>
        </div>
      </div>
    </section>
  )
}
