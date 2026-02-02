"use client"

import { motion } from "framer-motion"
import { fadeInUp, viewportDefault } from "@/lib/spatial-animations"

export interface ScrollSectionProps {
  id: string
  title?: string
  subtitle?: string
  sticky?: boolean
  revealType?: "fade" | "slide" | "scale" | "none"
  className?: string
  children: React.ReactNode
}

export function ScrollSection({
  id,
  title,
  subtitle,
  sticky = false,
  revealType = "fade",
  className = "",
  children,
}: ScrollSectionProps) {
  const variants = {
    fade: fadeInUp,
    slide: fadeInUp,
    scale: fadeInUp,
    none: undefined,
  }

  return (
    <section
      id={id}
      className={`scroll-section relative py-20 md:py-32 ${
        sticky ? "scroll-snap-section" : ""
      } ${className}`}
    >
      <div className="container mx-auto px-4 md:px-6 lg:px-8">
        {/* Section header */}
        {(title || subtitle) && (
          <motion.div
            className="text-center mb-16 md:mb-20"
            variants={revealType !== "none" ? variants[revealType] : undefined}
            initial={revealType !== "none" ? "hidden" : undefined}
            whileInView={revealType !== "none" ? "visible" : undefined}
            viewport={viewportDefault}
          >
            {title && (
              <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4 gradient-text">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="text-lg md:text-xl text-foreground-secondary max-w-3xl mx-auto">
                {subtitle}
              </p>
            )}
          </motion.div>
        )}

        {/* Section content */}
        {children}
      </div>
    </section>
  )
}
