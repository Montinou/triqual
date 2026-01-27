"use client"

import { motion, useReducedMotion } from "framer-motion"
import { ArrowRight, BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.2,
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.8,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
}

export function Hero() {
  const shouldReduceMotion = useReducedMotion()

  const title1 = "Intelligent"
  const title2 = "Test Automation"

  if (shouldReduceMotion) {
    return (
      <section className="min-h-screen flex flex-col justify-center items-center px-4 sm:px-6 lg:px-8 pt-32 pb-16 text-center">
        <div className="mb-8 flex items-center justify-center">
          <img
            src="/triqual_logo.png"
            alt="Triqual Logo"
            className="w-20 h-20 sm:w-24 sm:h-24"
            style={{
              filter: 'drop-shadow(0 0 12px rgba(0, 255, 136, 0.6)) drop-shadow(0 0 12px rgba(168, 85, 247, 0.6)) drop-shadow(0 0 12px rgba(0, 240, 255, 0.6))'
            }}
          />
        </div>
        <Badge
          variant="outline"
          className="mb-8 border-primary/40 bg-background-card text-primary font-mono"
        >
          <span className="w-2 h-2 rounded-full bg-secondary mr-2" />
          Claude Code Plugin
        </Badge>

        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight mb-6">
          <span className="gradient-text">{title1}</span>
          <br />
          {title2}
        </h1>

        <p className="text-lg sm:text-xl text-foreground-secondary max-w-2xl mb-10 font-light">
          Unified plugin combining Playwright execution, Quoth knowledge base,
          and Exolar analytics into one self-learning test automation system.
        </p>

        <div className="flex flex-col sm:flex-row gap-4">
          <Button
            asChild
            size="lg"
            className="bg-gradient-to-r from-primary to-secondary text-background font-semibold glow-cyan hover:opacity-90 transition-opacity"
          >
            <Link href="#install">
              Get Started
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            size="lg"
            className="border-white/20 hover:bg-background-card hover:border-primary/40"
          >
            <Link href="#workflow">See How It Works</Link>
          </Button>
        </div>

        {/* Documentation link */}
        <div className="mt-6">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-foreground-secondary hover:text-primary transition-colors"
          >
            <Link href="/docs">
              <BookOpen className="mr-2 h-4 w-4" />
              Read the Documentation
            </Link>
          </Button>
        </div>
      </section>
    )
  }

  return (
    <motion.section
      className="min-h-screen flex flex-col justify-center items-center px-4 sm:px-6 lg:px-8 pt-32 pb-16 text-center"
      initial="hidden"
      animate="visible"
      variants={containerVariants}
    >
      <motion.div
        variants={itemVariants}
        className="mb-8 flex items-center justify-center"
      >
        <img
          src="/triqual_logo.png"
          alt="Triqual Logo"
          className="w-20 h-20 sm:w-24 sm:h-24"
          style={{
            filter: 'drop-shadow(0 0 12px rgba(0, 255, 136, 0.6)) drop-shadow(0 0 12px rgba(168, 85, 247, 0.6)) drop-shadow(0 0 12px rgba(0, 240, 255, 0.6))'
          }}
        />
      </motion.div>
      <motion.div variants={itemVariants}>
        <Badge
          variant="outline"
          className="mb-8 border-primary/40 bg-background-card text-primary font-mono"
        >
          <span className="w-2 h-2 rounded-full bg-secondary mr-2 animate-pulse-glow" />
          Claude Code Plugin
        </Badge>
      </motion.div>

      <motion.h1
        className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight mb-6"
        variants={itemVariants}
      >
        <span className="gradient-text-shimmer">{title1}</span>
        <br />
        <span>{title2}</span>
      </motion.h1>

      <motion.p
        className="text-lg sm:text-xl text-foreground-secondary max-w-2xl mb-10 font-light"
        variants={itemVariants}
      >
        Unified plugin combining Playwright execution, Quoth knowledge base,
        and Exolar analytics into one self-learning test automation system.
      </motion.p>

      <motion.div
        className="flex flex-col sm:flex-row gap-4"
        variants={itemVariants}
      >
        <motion.div
          whileHover={{ y: -2, scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <Button
            asChild
            size="lg"
            className="bg-gradient-to-r from-primary to-secondary text-background font-semibold glow-cyan hover:shadow-[0_0_40px_rgba(0,240,255,0.6),0_0_80px_rgba(0,240,255,0.3)] transition-shadow"
          >
            <Link href="#install">
              Get Started
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </Button>
        </motion.div>
        <motion.div
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.98 }}
        >
          <Button
            asChild
            variant="outline"
            size="lg"
            className="border-white/20 hover:bg-background-card hover:border-primary/40 transition-all"
          >
            <Link href="#workflow">See How It Works</Link>
          </Button>
        </motion.div>
      </motion.div>

      {/* Documentation link - visible on all devices */}
      <motion.div
        className="mt-6"
        variants={itemVariants}
      >
        <motion.div
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.98 }}
        >
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-foreground-secondary hover:text-primary transition-colors"
          >
            <Link href="/docs">
              <BookOpen className="mr-2 h-4 w-4" />
              Read the Documentation
            </Link>
          </Button>
        </motion.div>
      </motion.div>
    </motion.section>
  )
}
