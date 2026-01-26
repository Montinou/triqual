"use client"

import { motion, useReducedMotion, useInView } from "framer-motion"
import { useRef, type ReactNode } from "react"
import { Zap, Globe, BookOpen, BarChart3 } from "lucide-react"

const nodeVariants = {
  hidden: { opacity: 0, scale: 0.8 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.6,
      ease: [0.34, 1.56, 0.64, 1] as const,
    },
  },
}

const pathVariants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: {
      pathLength: { duration: 1.5, ease: "easeInOut" as const },
      opacity: { duration: 0.3 },
    },
  },
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
      delayChildren: 0.3,
    },
  },
}

interface TrinityNodeProps {
  title: string
  description: string
  icon: ReactNode
  position: "top" | "bottom-left" | "bottom-right"
  glowClass: string
  borderColor: string
  href?: string
}

function TrinityNode({ title, description, icon, position, glowClass, borderColor, href }: TrinityNodeProps) {
  const positionClasses = {
    top: "top-[5%] left-1/2 -translate-x-1/2",
    "bottom-left": "bottom-[10%] left-[10%]",
    "bottom-right": "bottom-[10%] right-[10%]",
  }

  const content = (
    <>
      <div className="flex justify-center mb-3">{icon}</div>
      <h3 className="font-bold text-base sm:text-lg mb-1">{title}</h3>
      <p className="text-xs sm:text-sm text-foreground-secondary">{description}</p>
    </>
  )

  const motionProps = {
    className: `absolute w-40 sm:w-44 p-4 sm:p-6 bg-background-surface rounded-2xl border text-center transition-all duration-400 ${positionClasses[position]} ${borderColor} ${href ? "cursor-pointer" : ""}`,
    variants: nodeVariants,
    whileHover: {
      scale: 1.05,
      boxShadow: glowClass === "glow-green"
        ? "0 0 30px rgba(0, 255, 136, 0.5), 0 0 60px rgba(0, 255, 136, 0.2)"
        : glowClass === "glow-purple"
        ? "0 0 30px rgba(168, 85, 247, 0.5), 0 0 60px rgba(168, 85, 247, 0.2)"
        : "0 0 30px rgba(0, 240, 255, 0.5), 0 0 60px rgba(0, 240, 255, 0.2)",
    },
  }

  if (href) {
    return (
      <motion.a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        {...motionProps}
      >
        {content}
      </motion.a>
    )
  }

  return (
    <motion.div {...motionProps}>
      {content}
    </motion.div>
  )
}

// Custom icon components with gradients
function PlaywrightIcon() {
  return (
    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-secondary/20 to-secondary/5 border border-secondary/30 flex items-center justify-center">
      <Globe className="w-6 h-6 sm:w-7 sm:h-7 text-secondary" />
    </div>
  )
}

function QuothIcon() {
  return (
    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/30 flex items-center justify-center">
      <BookOpen className="w-6 h-6 sm:w-7 sm:h-7 text-accent" />
    </div>
  )
}

function ExolarIcon() {
  return (
    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/30 flex items-center justify-center">
      <BarChart3 className="w-6 h-6 sm:w-7 sm:h-7 text-primary" />
    </div>
  )
}

export function TrinityDiagram() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  if (shouldReduceMotion) {
    return (
      <section className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto relative aspect-[16/10]">
          {/* SVG Lines */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 900 560">
            <defs>
              <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.6" />
                <stop offset="50%" stopColor="#00ff88" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#a855f7" stopOpacity="0.6" />
              </linearGradient>
            </defs>
            <path
              d="M450,280 Q450,150 450,80"
              stroke="url(#lineGradient)"
              strokeWidth="2"
              fill="none"
              strokeDasharray="8 4"
              className="animate-dash"
            />
            <path
              d="M450,280 Q300,350 170,420"
              stroke="url(#lineGradient)"
              strokeWidth="2"
              fill="none"
              strokeDasharray="8 4"
              className="animate-dash"
            />
            <path
              d="M450,280 Q600,350 730,420"
              stroke="url(#lineGradient)"
              strokeWidth="2"
              fill="none"
              strokeDasharray="8 4"
              className="animate-dash"
            />
            <ellipse
              cx="450"
              cy="300"
              rx="280"
              ry="180"
              fill="none"
              stroke="rgba(0,240,255,0.1)"
              strokeWidth="1"
            />
          </svg>

          {/* Nodes */}
          <div className="absolute top-[5%] left-1/2 -translate-x-1/2 w-44 p-6 bg-background-surface rounded-2xl border border-secondary/25 text-center">
            <div className="flex justify-center mb-3">
              <PlaywrightIcon />
            </div>
            <h3 className="font-bold text-lg mb-1">Playwright</h3>
            <p className="text-sm text-foreground-secondary">Browser Automation</p>
          </div>

          <a
            href="https://github.com/Montinou/quoth-mcp"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-[10%] left-[10%] w-44 p-6 bg-background-surface rounded-2xl border border-accent/25 text-center cursor-pointer hover:scale-105 transition-transform"
          >
            <div className="flex justify-center mb-3">
              <QuothIcon />
            </div>
            <h3 className="font-bold text-lg mb-1">Quoth</h3>
            <p className="text-sm text-foreground-secondary">Pattern Documentation</p>
          </a>

          <a
            href="https://github.com/Montinou/exolar"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-[10%] right-[10%] w-44 p-6 bg-background-surface rounded-2xl border border-primary/25 text-center cursor-pointer hover:scale-105 transition-transform"
          >
            <div className="flex justify-center mb-3">
              <ExolarIcon />
            </div>
            <h3 className="font-bold text-lg mb-1">Exolar</h3>
            <p className="text-sm text-foreground-secondary">Test Analytics</p>
          </a>

          {/* Center node */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-background-card border-2 border-primary rounded-full flex flex-col items-center justify-center glow-cyan z-10">
            <Zap className="w-8 h-8 text-primary mb-1" />
            <span className="font-mono text-xs text-primary uppercase tracking-widest">Unified</span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <motion.section
      ref={ref}
      className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8"
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
    >
      <div className="max-w-4xl mx-auto relative aspect-[16/10]">
        {/* SVG Lines */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 900 560">
          <defs>
            <linearGradient id="lineGradientAnimated" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.6" />
              <stop offset="50%" stopColor="#00ff88" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#a855f7" stopOpacity="0.6" />
            </linearGradient>
          </defs>

          {/* Orbital ellipse */}
          <motion.ellipse
            cx="450"
            cy="300"
            rx="280"
            ry="180"
            fill="none"
            stroke="rgba(0,240,255,0.1)"
            strokeWidth="1"
            variants={{
              hidden: { opacity: 0 },
              visible: { opacity: 1, transition: { duration: 1 } },
            }}
          />

          {/* Connection lines */}
          <motion.path
            d="M450,280 Q450,150 450,80"
            stroke="url(#lineGradientAnimated)"
            strokeWidth="2"
            fill="none"
            strokeDasharray="8 4"
            variants={pathVariants}
            style={{ strokeDashoffset: 0 }}
          />
          <motion.path
            d="M450,280 Q300,350 170,420"
            stroke="url(#lineGradientAnimated)"
            strokeWidth="2"
            fill="none"
            strokeDasharray="8 4"
            variants={pathVariants}
          />
          <motion.path
            d="M450,280 Q600,350 730,420"
            stroke="url(#lineGradientAnimated)"
            strokeWidth="2"
            fill="none"
            strokeDasharray="8 4"
            variants={pathVariants}
          />
        </svg>

        {/* Animated dashes overlay (loops after initial draw) */}
        {isInView && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 900 560">
            <path
              d="M450,280 Q450,150 450,80"
              stroke="url(#lineGradientAnimated)"
              strokeWidth="2"
              fill="none"
              strokeDasharray="8 4"
              className="animate-dash"
            />
            <path
              d="M450,280 Q300,350 170,420"
              stroke="url(#lineGradientAnimated)"
              strokeWidth="2"
              fill="none"
              strokeDasharray="8 4"
              className="animate-dash"
            />
            <path
              d="M450,280 Q600,350 730,420"
              stroke="url(#lineGradientAnimated)"
              strokeWidth="2"
              fill="none"
              strokeDasharray="8 4"
              className="animate-dash"
            />
          </svg>
        )}

        {/* Nodes */}
        <TrinityNode
          title="Playwright"
          description="Browser Automation"
          icon={<PlaywrightIcon />}
          position="top"
          glowClass="glow-green"
          borderColor="border-secondary/25"
        />

        <TrinityNode
          title="Quoth"
          description="Pattern Documentation"
          icon={<QuothIcon />}
          position="bottom-left"
          glowClass="glow-purple"
          borderColor="border-accent/25"
          href="https://github.com/Montinou/quoth-mcp"
        />

        <TrinityNode
          title="Exolar"
          description="Test Analytics"
          icon={<ExolarIcon />}
          position="bottom-right"
          glowClass="glow-cyan"
          borderColor="border-primary/25"
          href="https://github.com/Montinou/exolar"
        />

        {/* Center node */}
        <motion.div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-28 h-28 sm:w-36 sm:h-36 bg-background-card border-2 border-primary rounded-full flex flex-col items-center justify-center glow-cyan z-10"
          variants={{
            hidden: { opacity: 0, scale: 0 },
            visible: {
              opacity: 1,
              scale: 1,
              transition: {
                delay: 0.8,
                duration: 0.6,
                ease: [0.34, 1.56, 0.64, 1] as const,
              },
            },
          }}
          whileHover={{ scale: 1.1 }}
        >
          <Zap className="w-6 h-6 sm:w-10 sm:h-10 text-primary mb-1" />
          <span className="font-mono text-[10px] sm:text-xs text-primary uppercase tracking-widest">Unified</span>
        </motion.div>
      </div>
    </motion.section>
  )
}
