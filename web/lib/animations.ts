import type { Variants, Transition } from "framer-motion"

// Easing presets matching the original design
export const easeOutExpo = [0.16, 1, 0.3, 1] as const
export const easeOutBack = [0.34, 1.56, 0.64, 1] as const

// Base transition presets
export const springTransition: Transition = {
  type: "spring",
  stiffness: 100,
  damping: 15,
}

export const smoothTransition: Transition = {
  duration: 0.8,
  ease: easeOutExpo,
}

// Fade and slide variants
export const fadeInUp: Variants = {
  hidden: {
    opacity: 0,
    y: 30,
  },
  visible: {
    opacity: 1,
    y: 0,
    transition: smoothTransition,
  },
}

export const fadeInDown: Variants = {
  hidden: {
    opacity: 0,
    y: -30,
  },
  visible: {
    opacity: 1,
    y: 0,
    transition: smoothTransition,
  },
}

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.6, ease: easeOutExpo },
  },
}

export const scaleIn: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.8,
  },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.5,
      ease: easeOutBack,
    },
  },
}

// Stagger container for children
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.1,
    },
  },
}

export const staggerContainerFast: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.05,
    },
  },
}

// SVG path drawing
export const drawPath: Variants = {
  hidden: {
    pathLength: 0,
    opacity: 0,
  },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: {
      pathLength: { duration: 1.5, ease: "easeInOut" },
      opacity: { duration: 0.3 },
    },
  },
}

// Glow pulse animation for hover states
export const glowPulse: Variants = {
  rest: {
    boxShadow: "0 0 0px rgba(0, 240, 255, 0)",
  },
  hover: {
    boxShadow: "0 0 30px rgba(0, 240, 255, 0.5), 0 0 60px rgba(0, 240, 255, 0.2)",
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
}

// Card hover animations
export const cardHover: Variants = {
  rest: {
    y: 0,
    scale: 1,
  },
  hover: {
    y: -4,
    scale: 1.02,
    transition: {
      duration: 0.3,
      ease: easeOutExpo,
    },
  },
}

// Text reveal animation (word by word)
export const wordReveal: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.2,
    },
  },
}

export const wordRevealChild: Variants = {
  hidden: {
    opacity: 0,
    y: 20,
    rotateX: -90,
  },
  visible: {
    opacity: 1,
    y: 0,
    rotateX: 0,
    transition: {
      duration: 0.5,
      ease: easeOutExpo,
    },
  },
}

// Line draw animation (for timeline/workflow)
export const lineGrow: Variants = {
  hidden: {
    scaleY: 0,
    originY: 0,
  },
  visible: {
    scaleY: 1,
    transition: {
      duration: 1.2,
      ease: easeOutExpo,
    },
  },
}

// Viewport animation options
export const viewportOnce = {
  once: true,
  margin: "-100px" as const,
}

// Reduced motion check helper
export const getReducedMotionVariants = (variants: Variants): Variants => ({
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.01 } },
})
