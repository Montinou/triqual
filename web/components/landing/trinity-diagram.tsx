"use client"

import { motion, useReducedMotion, useInView } from "framer-motion"
import { useRef, type ReactNode } from "react"
import { Zap, Globe } from "lucide-react"

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
  // Position nodes to form a balanced triangle - equal visual distance from center
  // Bottom nodes moved closer to center for balanced distances
  const positionClasses = {
    top: "top-[3%] left-1/2 -translate-x-1/2",
    "bottom-left": "bottom-[8%] left-[15%]",
    "bottom-right": "bottom-[8%] right-[15%]",
  }

  const content = (
    <>
      <div className="flex justify-center mb-3">{icon}</div>
      <h3 className="font-bold text-base sm:text-lg mb-1">{title}</h3>
      <p className="text-xs sm:text-sm text-foreground-secondary">{description}</p>
    </>
  )

  const motionProps = {
    className: `absolute w-44 sm:w-52 min-h-[150px] sm:min-h-[170px] p-4 sm:p-5 bg-background-surface rounded-2xl border text-center transition-all duration-400 ${positionClasses[position]} ${borderColor} ${href ? "cursor-pointer" : ""}`,
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
    <div className="w-11 h-11 sm:w-13 sm:h-13 rounded-xl bg-gradient-to-br from-secondary/20 to-secondary/5 border border-secondary/30 flex items-center justify-center">
      <Globe className="w-5 h-5 sm:w-6 sm:h-6 text-secondary" />
    </div>
  )
}

function QuothIcon() {
  return (
    <div className="w-11 h-11 sm:w-13 sm:h-13 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/30 flex items-center justify-center">
      <img src="/pluma-ciber.png" alt="Quoth" className="w-5 h-5 sm:w-6 sm:h-6" />
    </div>
  )
}

function ExolarIcon() {
  // Exolar eclipse logo - circular with cyan/orange gradient border and glows
  return (
    <div className="relative w-11 h-11 sm:w-13 sm:h-13 flex items-center justify-center">
      {/* Cyan glow - top left */}
      <div
        className="absolute w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-cyan-500/30 blur-md"
        style={{ top: '-4px', left: '-4px' }}
      />
      {/* Orange glow - bottom right */}
      <div
        className="absolute w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-orange-500/30 blur-md"
        style={{ bottom: '-4px', right: '-4px' }}
      />
      {/* Main eclipse circle */}
      <div
        className="relative w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-black z-10"
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

// Connection line component with CSS-based positioning
function ConnectionLine({
  from,
  to,
  color,
  delay = 0
}: {
  from: { x: string; y: string }
  to: { x: string; y: string }
  color: string
  delay?: number
}) {
  return (
    <motion.div
      className="absolute pointer-events-none"
      style={{
        left: from.x,
        top: from.y,
        width: '2px',
        height: '1px',
        transformOrigin: 'top left',
        background: `linear-gradient(to bottom, ${color}cc, ${color}40)`,
      }}
      initial={{ scaleY: 0, opacity: 0 }}
      animate={{
        scaleY: 1,
        opacity: 1,
      }}
      transition={{
        scaleY: { duration: 0.8, delay, ease: "easeOut" },
        opacity: { duration: 0.3, delay },
      }}
    />
  )
}

export function TrinityDiagram() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-50px" })

  // SVG uses percentage-based viewBox matching CSS positions exactly
  // Container: aspect-[4/3] so viewBox is 100x75
  // CSS positions translate to SVG coordinates:
  // - Center: (50, 50) of container = (50, 37.5) in viewBox
  // - Playwright: top-[3%] left-1/2 = (50, ~20) bottom of card
  // - Quoth: bottom-[8%] left-[15%] = (~25, ~52) top-right of card
  // - Exolar: bottom-[8%] right-[15%] = (~75, ~52) top-left of card

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

  if (shouldReduceMotion) {
    return (
      <section className="py-12 sm:py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto relative aspect-[4/3]">
          {svgContent(false)}

          {/* Nodes */}
          <div className="absolute top-[3%] left-1/2 -translate-x-1/2 w-44 sm:w-52 min-h-[150px] sm:min-h-[170px] p-4 sm:p-5 bg-background-surface rounded-2xl border border-secondary/30 text-center">
            <div className="flex justify-center mb-3">
              <PlaywrightIcon />
            </div>
            <h3 className="font-bold text-base sm:text-lg mb-1">Playwright</h3>
            <p className="text-xs sm:text-sm text-foreground-secondary">Browser Automation</p>
          </div>

          <a
            href="https://quoth.ai-innovation.site/"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-[8%] left-[15%] w-44 sm:w-52 min-h-[150px] sm:min-h-[170px] p-4 sm:p-5 bg-background-surface rounded-2xl border border-accent/30 text-center cursor-pointer hover:scale-105 transition-transform"
          >
            <div className="flex justify-center mb-3">
              <QuothIcon />
            </div>
            <h3 className="font-bold text-base sm:text-lg mb-1">Quoth</h3>
            <p className="text-xs sm:text-sm text-foreground-secondary">Pattern Documentation</p>
          </a>

          <a
            href="https://exolar.ai-innovation.site/"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-[8%] right-[15%] w-44 sm:w-52 min-h-[150px] sm:min-h-[170px] p-4 sm:p-5 bg-background-surface rounded-2xl border border-primary/30 text-center cursor-pointer hover:scale-105 transition-transform"
          >
            <div className="flex justify-center mb-3">
              <ExolarIcon />
            </div>
            <h3 className="font-bold text-base sm:text-lg mb-1">Exolar</h3>
            <p className="text-xs sm:text-sm text-foreground-secondary">Test Analytics</p>
          </a>

          {/* Center node */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-28 sm:h-28 bg-background-card border-2 border-primary/60 rounded-full flex flex-col items-center justify-center z-10"
            style={{
              boxShadow: "0 0 40px rgba(0, 240, 255, 0.3), 0 0 80px rgba(0, 240, 255, 0.1), inset 0 0 20px rgba(0, 240, 255, 0.05)"
            }}
          >
            <Zap className="w-6 h-6 sm:w-7 sm:h-7 text-primary mb-1" />
            <span className="font-mono text-[9px] sm:text-[10px] text-primary uppercase tracking-[0.15em]">Unified</span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <motion.section
      ref={ref}
      className="py-12 sm:py-20 px-4 sm:px-6 lg:px-8"
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
    >
      <div className="max-w-3xl mx-auto relative aspect-[4/3]">
        {svgContent(true)}

        {/* Nodes */}
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
          description="Pattern Documentation"
          icon={<QuothIcon />}
          position="bottom-left"
          glowClass="glow-purple"
          borderColor="border-accent/30"
          href="https://quoth.ai-innovation.site/"
        />

        <TrinityNode
          title="Exolar"
          description="Test Analytics"
          icon={<ExolarIcon />}
          position="bottom-right"
          glowClass="glow-cyan"
          borderColor="border-primary/30"
          href="https://exolar.ai-innovation.site/"
        />

        {/* Center node - "UNIFIED" hub */}
        <motion.div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-28 sm:h-28 bg-background-card border-2 border-primary/60 rounded-full flex flex-col items-center justify-center z-10"
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
          <Zap className="w-6 h-6 sm:w-7 sm:h-7 text-primary mb-1" />
          <span className="font-mono text-[9px] sm:text-[10px] text-primary uppercase tracking-[0.15em]">Unified</span>
        </motion.div>
      </div>
    </motion.section>
  )
}
