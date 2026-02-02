import type { Variants, Transition } from "framer-motion"

// ============================================================================
// DESIGN TOKENS - Duration, Easing, Springs
// ============================================================================

export const duration = {
  instant: "50ms",
  fast: "100ms",
  normal: "200ms",
  moderate: "300ms",
  slow: "400ms",
} as const

export const easing = {
  easeOut: [0, 0, 0.2, 1] as const,
  emphasized: [0.2, 0, 0, 1] as const,
  overshoot: [0.34, 1.56, 0.64, 1] as const,
}

export const springs = {
  button: { type: "spring" as const, stiffness: 400, damping: 17 },
  default: { type: "spring" as const, stiffness: 300, damping: 30 },
  gentle: { type: "spring" as const, stiffness: 120, damping: 14 },
  bouncy: { type: "spring" as const, stiffness: 600, damping: 15 },
}

// ============================================================================
// 3D DEPTH SYSTEM
// ============================================================================

export const depth = {
  foreground: 100, // Interactive elements float toward user
  midground: 0, // Reference plane
  background: -200, // Ambient elements recede
} as const

export const perspective = {
  container: 1200,
  origin: "50% 50%",
} as const

// ============================================================================
// BASIC ANIMATIONS (Compatible with existing code)
// ============================================================================

export const fadeInUp: Variants = {
  hidden: {
    opacity: 0,
    y: 30,
  },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.8,
      ease: easing.easeOut,
    },
  },
}

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      duration: 0.6,
      ease: easing.easeOut,
    },
  },
}

// ============================================================================
// DIAGRAM REVEAL ANIMATIONS (Scroll-Driven)
// ============================================================================

export const diagramReveal: Variants = {
  hidden: {
    opacity: 0,
    rotateX: 15,
    y: 80,
  },
  visible: {
    opacity: 1,
    rotateX: 0,
    y: 0,
    transition: {
      duration: 0.8,
      ease: easing.easeOut,
    },
  },
}

export const diagramReveal3D: Variants = {
  hidden: {
    opacity: 0,
    rotateX: 15,
    rotateY: -5,
    y: 80,
    z: -100,
  },
  visible: {
    opacity: 1,
    rotateX: 0,
    rotateY: 0,
    y: 0,
    z: 0,
    transition: {
      duration: 1,
      ease: easing.emphasized,
    },
  },
}

// ============================================================================
// CARD ANIMATIONS (Enhanced with Depth)
// ============================================================================

export const cardHover3D: Variants = {
  rest: {
    y: 0,
    scale: 1,
    rotateY: 0,
    z: depth.midground,
  },
  hover: {
    y: -4,
    scale: 1.02,
    rotateY: 2,
    z: depth.foreground,
    transition: springs.button,
  },
}

export const cardSlideIn: Variants = {
  hidden: {
    opacity: 0,
    x: -60,
    rotateY: -15,
  },
  visible: {
    opacity: 1,
    x: 0,
    rotateY: 0,
    transition: {
      duration: 0.6,
      ease: easing.emphasized,
    },
  },
}

export const cardSlideInRight: Variants = {
  hidden: {
    opacity: 0,
    x: 60,
    rotateY: 15,
  },
  visible: {
    opacity: 1,
    x: 0,
    rotateY: 0,
    transition: {
      duration: 0.6,
      ease: easing.emphasized,
    },
  },
}

// ============================================================================
// STAGGER CONTAINERS
// ============================================================================

export const staggerCards: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.1,
    },
  },
}

export const staggerFast: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.05,
    },
  },
}

// ============================================================================
// HOTSPOT ANIMATIONS
// ============================================================================

export const hotspotPulse: Variants = {
  rest: {
    scale: 1,
    boxShadow: "0 0 0px rgba(0, 240, 255, 0)",
  },
  hover: {
    scale: 1.1,
    boxShadow: "0 0 30px rgba(0, 240, 255, 0.6), 0 0 60px rgba(0, 240, 255, 0.3)",
    transition: springs.bouncy,
  },
}

export const hotspotGlow: Variants = {
  rest: {
    opacity: 0.7,
  },
  hover: {
    opacity: 1,
    transition: {
      duration: 0.2,
    },
  },
}

// ============================================================================
// PANEL EXPANSIONS (FLIP Technique)
// ============================================================================

export const panelSlideIn: Variants = {
  hidden: {
    x: "100%",
    opacity: 0,
  },
  visible: {
    x: 0,
    opacity: 1,
    transition: {
      duration: 0.4,
      ease: easing.emphasized,
    },
  },
  exit: {
    x: "100%",
    opacity: 0,
    transition: {
      duration: 0.3,
      ease: easing.easeOut,
    },
  },
}

export const modalScale: Variants = {
  hidden: {
    scale: 0.9,
    opacity: 0,
  },
  visible: {
    scale: 1,
    opacity: 1,
    transition: springs.gentle,
  },
  exit: {
    scale: 0.95,
    opacity: 0,
    transition: {
      duration: 0.2,
    },
  },
}

// ============================================================================
// BUTTON INTERACTIONS
// ============================================================================

export const buttonPress = {
  whileHover: {
    y: -2,
    boxShadow: "0 0 40px rgba(0, 240, 255, 0.6)",
    transition: springs.button,
  },
  whileTap: {
    scale: 0.98,
    y: 0,
    transition: springs.button,
  },
}

export const buttonPressGreen = {
  whileHover: {
    y: -2,
    boxShadow: "0 0 40px rgba(0, 255, 150, 0.6)",
    transition: springs.button,
  },
  whileTap: {
    scale: 0.98,
    y: 0,
    transition: springs.button,
  },
}

export const buttonPressPurple = {
  whileHover: {
    y: -2,
    boxShadow: "0 0 40px rgba(168, 85, 247, 0.6)",
    transition: springs.button,
  },
  whileTap: {
    scale: 0.98,
    y: 0,
    transition: springs.button,
  },
}

// ============================================================================
// PARALLAX LAYERS
// ============================================================================

export const parallaxBackground = {
  z: depth.background,
  scale: 1.2, // Compensate for perspective scaling
}

export const parallaxMidground = {
  z: depth.midground,
  scale: 1,
}

export const parallaxForeground = {
  z: depth.foreground,
  scale: 1,
}

// ============================================================================
// MAGNETIC HOVER (for cards/diagrams)
// ============================================================================

export interface MagneticHoverConfig {
  strength: number // 0-1, how much cursor affects rotation
  maxRotation: number // degrees
  transition?: Transition
}

export const magneticHoverDefault: MagneticHoverConfig = {
  strength: 0.15,
  maxRotation: 5,
  transition: springs.gentle,
}

export const magneticHoverStrong: MagneticHoverConfig = {
  strength: 0.25,
  maxRotation: 8,
  transition: springs.default,
}

// ============================================================================
// AMBIENT ROTATION (for 3D previews)
// ============================================================================

export const ambientRotation: Variants = {
  initial: {
    rotateY: -3,
  },
  animate: {
    rotateY: 3,
    transition: {
      duration: 4,
      ease: "easeInOut",
      repeat: Infinity,
      repeatType: "reverse",
    },
  },
}

// ============================================================================
// SCROLL SNAP SECTIONS
// ============================================================================

export const scrollSnapSection = {
  scrollSnapAlign: "start" as const,
  scrollSnapStop: "always" as const,
}

// ============================================================================
// VIEWPORT ANIMATION OPTIONS
// ============================================================================

export const viewportDefault = {
  once: true,
  margin: "-100px",
  amount: 0.3,
}

export const viewportImmediate = {
  once: true,
  margin: "0px",
  amount: 0.1,
}

// ============================================================================
// REDUCED MOTION SUPPORT
// ============================================================================

export const getReducedMotionVariants = (variants: Variants): Variants => ({
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.01 } },
})

// ============================================================================
// UTILITY: Will-Change Management
// ============================================================================

export const willChangeTransform = {
  willChange: "transform, opacity" as const,
}

export const willChangeAuto = {
  willChange: "auto" as const,
}
