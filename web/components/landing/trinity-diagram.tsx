"use client"

import { motion, useReducedMotion, useInView } from "framer-motion"
import { useRef, type ReactNode } from "react"
import Image from "next/image"
import { Zap } from "lucide-react"

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
      pathLength: { duration: 1.2, ease: "easeInOut" as const },
      opacity: { duration: 0.3 },
    },
  },
}

// Flowing animation for energy particles moving toward center
const flowVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    strokeDashoffset: [8, 0],
    transition: {
      opacity: { duration: 0.5, delay: 1.2 },
      strokeDashoffset: {
        duration: 0.8,
        ease: "linear" as const,
        repeat: Infinity,
        delay: 1.2,
      },
    },
  },
}

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
  // Position nodes to form a balanced triangle - more spacing for mobile
  const positionClasses = {
    top: "top-[1%] left-1/2 -translate-x-1/2",
    "bottom-left": "bottom-[5%] left-[10%]",
    "bottom-right": "bottom-[5%] right-[10%]",
  }

  const content = (
    <>
      <div className="flex justify-center mb-3">{icon}</div>
      <h3 className="font-bold text-lg mb-1">{title}</h3>
      <p className="text-sm text-foreground-secondary">{description}</p>
    </>
  )

  const motionProps = {
    className: `absolute w-52 min-h-[170px] p-5 bg-background-surface rounded-2xl border text-center transition-all duration-400 ${positionClasses[position]} ${borderColor} ${href ? "cursor-pointer" : ""}`,
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
    <Image
      src="/playwright-logo.svg"
      alt="Playwright"
      width={64}
      height={64}
      className="w-16 h-16"
      style={{
        filter: 'brightness(1.2) drop-shadow(0 0 6px rgba(0, 255, 136, 0.9))',
      }}
    />
  )
}

function QuothIcon() {
  return (
    <Image
      src="/pluma-ciber.png"
      alt="Quoth"
      width={64}
      height={64}
      className="w-16 h-16"
      style={{
        filter: 'brightness(1.8) contrast(1.2) drop-shadow(0 0 6px rgba(168, 85, 247, 0.9))',
      }}
    />
  )
}

function ExolarIcon() {
  // Exolar eclipse logo - circular with cyan/orange gradient border and glows
  return (
    <div className="relative w-11 h-11 flex items-center justify-center">
      {/* Cyan glow - top left */}
      <div
        className="absolute w-10 h-10 rounded-full bg-cyan-500/30 blur-md"
        style={{ top: '-4px', left: '-4px' }}
      />
      {/* Orange glow - bottom right */}
      <div
        className="absolute w-10 h-10 rounded-full bg-orange-500/30 blur-md"
        style={{ bottom: '-4px', right: '-4px' }}
      />
      {/* Main eclipse circle */}
      <div
        className="relative w-11 h-11 rounded-full bg-black z-10"
        style={{
          boxShadow: 'inset 0 0 10px rgba(0,0,0,0.8)',
        }}
      >
        {/* Gradient border */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            border: '2px solid transparent',
            background: 'linear-gradient(135deg, #06b6d4, #000000 40%, #000000 60%, #f97316) border-box',
            WebkitMask: 'linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
          }}
        />
        {/* Inner depth gradient */}
        <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,transparent_20%,black_100%)]" />
      </div>
    </div>
  )
}

export function TrinityDiagram() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-50px" })

  const svgContent = (animated: boolean) => (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 100 75"
      preserveAspectRatio="none"
    >
      <defs>
        {/* Gradient for green line - flows from Playwright DOWN to center */}
        <linearGradient id="greenFlowGrad" x1="50" y1="20" x2="50" y2="37.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00ff88" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#00ff88" stopOpacity="0.2" />
        </linearGradient>
        {/* Gradient for purple line - flows from Quoth UP to center */}
        <linearGradient id="purpleFlowGrad" x1="27" y1="52" x2="50" y2="37.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a855f7" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#a855f7" stopOpacity="0.2" />
        </linearGradient>
        {/* Gradient for cyan line - flows from Exolar UP to center */}
        <linearGradient id="cyanFlowGrad" x1="73" y1="52" x2="50" y2="37.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#00f0ff" stopOpacity="0.2" />
        </linearGradient>
      </defs>

      {/* Orbital ellipse - centered at 50%, 50% of container */}
      {animated ? (
        <motion.ellipse
          cx="50"
          cy="37.5"
          rx="42"
          ry="30"
          fill="none"
          stroke="rgba(0,240,255,0.06)"
          strokeWidth="0.15"
          variants={{
            hidden: { opacity: 0 },
            visible: { opacity: 1, transition: { duration: 1.5 } },
          }}
        />
      ) : (
        <ellipse
          cx="50"
          cy="37.5"
          rx="42"
          ry="30"
          fill="none"
          stroke="rgba(0,240,255,0.06)"
          strokeWidth="0.15"
        />
      )}

      {/* Connection line: Center to Playwright (top) */}
      {animated ? (
        <>
          <motion.path
            d="M 50 37.5 L 50 20"
            stroke="url(#greenFlowGrad)"
            strokeWidth="0.5"
            fill="none"
            strokeLinecap="round"
            variants={pathVariants}
          />
          {/* Flowing particles - path goes FROM node TO center */}
          <motion.path
            d="M 50 20 L 50 37.5"
            stroke="#00ff88"
            strokeWidth="0.3"
            fill="none"
            strokeLinecap="round"
            strokeDasharray="2 6"
            variants={flowVariants}
          />
        </>
      ) : (
        <path
          d="M 50 37.5 L 50 20"
          stroke="url(#greenFlowGrad)"
          strokeWidth="0.5"
          fill="none"
          strokeLinecap="round"
        />
      )}

      {/* Connection line: Center to Quoth (bottom-left) */}
      {animated ? (
        <>
          <motion.path
            d="M 50 37.5 L 27 52"
            stroke="url(#purpleFlowGrad)"
            strokeWidth="0.5"
            fill="none"
            strokeLinecap="round"
            variants={pathVariants}
          />
          {/* Flowing particles - path goes FROM node TO center */}
          <motion.path
            d="M 27 52 L 50 37.5"
            stroke="#a855f7"
            strokeWidth="0.3"
            fill="none"
            strokeLinecap="round"
            strokeDasharray="2 6"
            variants={flowVariants}
          />
        </>
      ) : (
        <path
          d="M 50 37.5 L 27 52"
          stroke="url(#purpleFlowGrad)"
          strokeWidth="0.5"
          fill="none"
          strokeLinecap="round"
        />
      )}

      {/* Connection line: Center to Exolar (bottom-right) */}
      {animated ? (
        <>
          <motion.path
            d="M 50 37.5 L 73 52"
            stroke="url(#cyanFlowGrad)"
            strokeWidth="0.5"
            fill="none"
            strokeLinecap="round"
            variants={pathVariants}
          />
          {/* Flowing particles - path goes FROM node TO center */}
          <motion.path
            d="M 73 52 L 50 37.5"
            stroke="#00f0ff"
            strokeWidth="0.3"
            fill="none"
            strokeLinecap="round"
            strokeDasharray="2 6"
            variants={flowVariants}
          />
        </>
      ) : (
        <path
          d="M 50 37.5 L 73 52"
          stroke="url(#cyanFlowGrad)"
          strokeWidth="0.5"
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  )

  // Inner diagram content - fixed 768px width, scaled via transform
  const diagramContent = (animated: boolean) => (
    <div className="relative aspect-[4/3] w-[768px] origin-top-left">
      {svgContent(animated)}

      {animated ? (
        <>
          <TrinityNode
            title="Playwright"
            description="Browser Automation"
            icon={<PlaywrightIcon />}
            position="top"
            glowClass="glow-green"
            borderColor="border-secondary/30"
          />

          <TrinityNode
            title="Quoth"
            description="Live Pattern Docs"
            icon={<QuothIcon />}
            position="bottom-left"
            glowClass="glow-purple"
            borderColor="border-accent/30"
            href="https://quoth.ai-innovation.site/"
          />

          <TrinityNode
            title="Exolar"
            description="CI Analytics"
            icon={<ExolarIcon />}
            position="bottom-right"
            glowClass="glow-cyan"
            borderColor="border-primary/30"
            href="https://exolar.ai-innovation.site/"
          />

          <motion.div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-28 h-28 bg-background-card border-2 border-primary/60 rounded-full flex flex-col items-center justify-center z-10"
            style={{
              boxShadow: "0 0 40px rgba(0, 240, 255, 0.3), 0 0 80px rgba(0, 240, 255, 0.1), inset 0 0 20px rgba(0, 240, 255, 0.05)"
            }}
            variants={{
              hidden: { opacity: 0, scale: 0 },
              visible: {
                opacity: 1,
                scale: 1,
                transition: {
                  delay: 0.6,
                  duration: 0.5,
                  ease: [0.34, 1.56, 0.64, 1] as const,
                },
              },
            }}
            whileHover={{ scale: 1.1 }}
          >
            <Zap className="w-7 h-7 text-primary mb-1" />
            <span className="font-mono text-[10px] text-primary uppercase tracking-[0.15em]">Unified</span>
          </motion.div>
        </>
      ) : (
        <>
          <div className="absolute top-[1%] left-1/2 -translate-x-1/2 w-52 min-h-[170px] p-5 bg-background-surface rounded-2xl border border-secondary/30 text-center">
            <div className="flex justify-center mb-3">
              <PlaywrightIcon />
            </div>
            <h3 className="font-bold text-lg mb-1">Playwright</h3>
            <p className="text-sm text-foreground-secondary">Browser Automation</p>
          </div>

          <a
            href="https://quoth.ai-innovation.site/"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-[5%] left-[10%] w-52 min-h-[170px] p-5 bg-background-surface rounded-2xl border border-accent/30 text-center cursor-pointer hover:scale-105 transition-transform"
          >
            <div className="flex justify-center mb-3">
              <QuothIcon />
            </div>
            <h3 className="font-bold text-lg mb-1">Quoth</h3>
            <p className="text-sm text-foreground-secondary">Live Pattern Docs</p>
          </a>

          <a
            href="https://exolar.ai-innovation.site/"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-[5%] right-[10%] w-52 min-h-[170px] p-5 bg-background-surface rounded-2xl border border-primary/30 text-center cursor-pointer hover:scale-105 transition-transform"
          >
            <div className="flex justify-center mb-3">
              <ExolarIcon />
            </div>
            <h3 className="font-bold text-lg mb-1">Exolar</h3>
            <p className="text-sm text-foreground-secondary">CI Analytics</p>
          </a>

          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-28 h-28 bg-background-card border-2 border-primary/60 rounded-full flex flex-col items-center justify-center z-10"
            style={{
              boxShadow: "0 0 40px rgba(0, 240, 255, 0.3), 0 0 80px rgba(0, 240, 255, 0.1), inset 0 0 20px rgba(0, 240, 255, 0.05)"
            }}
          >
            <Zap className="w-7 h-7 text-primary mb-1" />
            <span className="font-mono text-[10px] text-primary uppercase tracking-[0.15em]">Unified</span>
          </div>
        </>
      )}
    </div>
  )

  if (shouldReduceMotion) {
    return (
      <section className="py-12 sm:py-20 px-4 sm:px-6 lg:px-8 overflow-hidden">
        {/*
          Scale approach:
          - Mobile (<640px): scale(0.42) → ~320px effective width
          - Tablet (640-768px): scale(0.8) → ~614px effective width
          - Desktop (768px+): scale(1) → 768px full width
        */}
        <div className="mx-auto w-full max-w-3xl">
          <div
            className="origin-top-center scale-[0.58] sm:scale-[0.85] md:scale-100"
            style={{
              marginLeft: 'auto',
              marginRight: 'auto',
              width: '768px',
              height: '576px', // 768 * 0.75 for 4:3 aspect
            }}
          >
            {diagramContent(false)}
          </div>
        </div>
        {/* Spacer to account for scaled height */}
        <div className="mt-[-242px] sm:mt-[-86px] md:mt-0" />
      </section>
    )
  }

  return (
    <motion.section
      ref={ref}
      className="py-12 sm:py-20 px-4 sm:px-6 lg:px-8 overflow-hidden"
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
    >
      {/*
        Scale approach:
        - Mobile (<640px): scale(0.42) → ~320px effective width
        - Tablet (640-768px): scale(0.8) → ~614px effective width
        - Desktop (768px+): scale(1) → 768px full width
      */}
      <div className="mx-auto flex justify-center">
        <div
          className="origin-top scale-[0.58] sm:scale-[0.85] md:scale-100 transition-transform duration-300"
        >
          <div style={{ width: '768px', height: '576px' }}>
            {diagramContent(true)}
          </div>
        </div>
      </div>
      {/* Negative margin to compensate for scaled height difference */}
      <div className="mt-[-242px] sm:mt-[-86px] md:mt-0" />
    </motion.section>
  )
}
