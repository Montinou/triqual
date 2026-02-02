"use client"

import { useState } from "react"
import Image from "next/image"
import { motion, AnimatePresence } from "framer-motion"
import { diagramReveal, diagramReveal3D, viewportDefault } from "@/lib/spatial-animations"

export interface DiagramHotspot {
  x: number // Position in percentage
  y: number
  label: string
  description?: string
  color?: "cyan" | "green" | "purple"
  onExpand?: () => void
}

export interface DiagramViewerProps {
  src: string
  alt: string
  width?: number
  height?: number
  hotspots?: DiagramHotspot[]
  size?: "full" | "large" | "medium" | "small"
  animateEntry?: boolean
  use3D?: boolean
  priority?: boolean
  className?: string
}

export function DiagramViewer({
  src,
  alt,
  width = 1920,
  height = 1440,
  hotspots = [],
  size = "large",
  animateEntry = true,
  use3D = false,
  priority = false,
  className = "",
}: DiagramViewerProps) {
  const [isZoomed, setIsZoomed] = useState(false)
  const [activeHotspot, setActiveHotspot] = useState<number | null>(null)

  const sizeClasses = {
    full: "w-full min-h-[70vh]",
    large: "w-full min-h-[55vh]",
    medium: "w-full min-h-[45vh]",
    small: "w-full min-h-[35vh]",
  }

  const variants = use3D ? diagramReveal3D : diagramReveal

  return (
    <motion.div
      className={`relative ${sizeClasses[size]} ${className}`}
      variants={animateEntry ? variants : undefined}
      initial={animateEntry ? "hidden" : undefined}
      whileInView={animateEntry ? "visible" : undefined}
      viewport={viewportDefault}
    >
      {/* Main diagram image with hover zoom */}
      <motion.div
        className="relative w-full h-full group cursor-pointer"
        onClick={() => setIsZoomed(!isZoomed)}
        whileHover={{ scale: 1.45 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
      >
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          quality={90}
          loading={priority ? undefined : "lazy"}
          priority={priority}
          placeholder="blur"
          blurDataURL="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iIzBhMGYxYSIvPjwvc3ZnPg=="
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 95vw, 90vw"
          className="w-full h-full object-contain rounded-xl border border-border/50 transition-all duration-300 group-hover:border-primary/30"
        />

        {/* Zoom hint overlay */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
          <div className="px-4 py-2 rounded-lg bg-background/90 backdrop-blur-sm border border-primary/50 text-sm text-primary font-medium">
            Click to view full size
          </div>
        </div>
      </motion.div>

      {/* Interactive hotspots */}
      <AnimatePresence>
        {hotspots.map((hotspot, index) => (
          <DiagramHotspotMarker
            key={index}
            hotspot={hotspot}
            index={index}
            isActive={activeHotspot === index}
            onHover={() => setActiveHotspot(index)}
            onLeave={() => setActiveHotspot(null)}
          />
        ))}
      </AnimatePresence>

      {/* Full-screen zoom modal */}
      <AnimatePresence>
        {isZoomed && (
          <motion.div
            className="fixed inset-0 bg-background/98 backdrop-blur-xl z-50 flex items-center justify-center cursor-zoom-out"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setIsZoomed(false)}
          >
            <motion.div
              className="relative max-w-[95vw] max-h-[95vh] w-full h-full flex items-center justify-center p-4"
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <Image
                src={src}
                alt={alt}
                width={width}
                height={height}
                quality={95}
                className="w-full h-full object-contain rounded-lg"
              />

              {/* Close hint */}
              <div className="absolute top-6 right-6 px-4 py-2 rounded-lg bg-background-card/90 backdrop-blur-sm border border-border text-sm text-foreground-secondary">
                Click anywhere to close
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ============================================================================
// Hotspot Marker Component
// ============================================================================

interface DiagramHotspotMarkerProps {
  hotspot: DiagramHotspot
  index: number
  isActive: boolean
  onHover: () => void
  onLeave: () => void
}

function DiagramHotspotMarker({
  hotspot,
  index,
  isActive,
  onHover,
  onLeave,
}: DiagramHotspotMarkerProps) {
  const colorClasses = {
    cyan: "bg-primary/20 border-primary text-primary",
    green: "bg-secondary/20 border-secondary text-secondary",
    purple: "bg-accent/20 border-accent text-accent",
  }

  const glowClasses = {
    cyan: "shadow-[0_0_30px_rgba(0,240,255,0.6)]",
    green: "shadow-[0_0_30px_rgba(0,255,136,0.6)]",
    purple: "shadow-[0_0_30px_rgba(168,85,247,0.6)]",
  }

  const color = hotspot.color || "cyan"

  return (
    <motion.button
      className={`absolute w-8 h-8 rounded-full border-2 flex items-center justify-center font-bold text-sm cursor-pointer z-20 ${colorClasses[color]} ${
        isActive ? glowClasses[color] : ""
      }`}
      style={{
        left: `${hotspot.x}%`,
        top: `${hotspot.y}%`,
        transform: "translate(-50%, -50%)",
      }}
      initial={{ scale: 0, opacity: 0 }}
      animate={{
        scale: 1,
        opacity: 1,
        transition: {
          delay: index * 0.1,
          type: "spring",
          stiffness: 400,
          damping: 17,
        },
      }}
      whileHover={{
        scale: 1.2,
        transition: { type: "spring", stiffness: 600, damping: 15 },
      }}
      whileTap={{ scale: 0.95 }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={hotspot.onExpand}
    >
      <span>+</span>

      {/* Pulsing ring */}
      <motion.div
        className={`absolute inset-0 rounded-full border-2 ${colorClasses[color]}`}
        animate={{
          scale: [1, 1.5, 1],
          opacity: [0.8, 0, 0.8],
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Tooltip */}
      <AnimatePresence>
        {isActive && (
          <motion.div
            className={`absolute top-full mt-2 left-1/2 -translate-x-1/2 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap glass ${colorClasses[color]}`}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            {hotspot.label}
            {hotspot.description && (
              <div className="text-foreground-muted text-[10px] mt-1">
                {hotspot.description}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
