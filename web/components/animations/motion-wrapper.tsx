"use client"

import { motion, type Variants, useReducedMotion } from "framer-motion"
import type { ReactNode } from "react"
import { fadeInUp, viewportOnce } from "@/lib/animations"

interface MotionWrapperProps {
  children: ReactNode
  className?: string
  variants?: Variants
  delay?: number
}

export function MotionWrapper({
  children,
  className,
  variants = fadeInUp,
  delay = 0,
}: MotionWrapperProps) {
  const shouldReduceMotion = useReducedMotion()

  if (shouldReduceMotion) {
    return <div className={className}>{children}</div>
  }

  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={viewportOnce}
      variants={variants}
      transition={{ delay }}
    >
      {children}
    </motion.div>
  )
}

export function MotionSection({
  children,
  className,
  delay = 0,
}: MotionWrapperProps) {
  const shouldReduceMotion = useReducedMotion()

  if (shouldReduceMotion) {
    return <section className={className}>{children}</section>
  }

  return (
    <motion.section
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={viewportOnce}
      variants={fadeInUp}
      transition={{ delay }}
    >
      {children}
    </motion.section>
  )
}
