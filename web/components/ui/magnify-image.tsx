"use client"

import { useState, useRef, useCallback } from "react"
import Image from "next/image"

interface MagnifyImageProps {
  src: string
  alt: string
  width: number
  height: number
  quality?: number
  priority?: boolean
  className?: string
  glowColor?: "cyan" | "green" | "purple"
  zoom?: number
  glassSize?: number
}

const glowColors = {
  cyan: "rgba(0, 240, 255, 0.4)",
  green: "rgba(0, 255, 136, 0.4)",
  purple: "rgba(168, 85, 247, 0.4)",
}

export function MagnifyImage({
  src,
  alt,
  width,
  height,
  quality = 90,
  priority = false,
  className = "",
  glowColor = "cyan",
  zoom = 2,
  glassSize = 150,
}: MagnifyImageProps) {
  const [isHovering, setIsHovering] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      setMousePos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      })
    },
    []
  )

  const handleMouseEnter = useCallback(() => setIsHovering(true), [])
  const handleMouseLeave = useCallback(() => setIsHovering(false), [])

  // Calculate background position for zoomed view
  const containerWidth = containerRef.current?.offsetWidth ?? 1
  const containerHeight = containerRef.current?.offsetHeight ?? 1
  const bgPosX = (mousePos.x / containerWidth) * 100
  const bgPosY = (mousePos.y / containerHeight) * 100

  const halfGlass = glassSize / 2
  const glow = glowColors[glowColor]

  return (
    <div
      ref={containerRef}
      className={`magnify-container relative overflow-hidden ${className}`}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ cursor: isHovering ? "none" : "default" }}
    >
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        quality={quality}
        priority={priority}
        loading={priority ? undefined : "lazy"}
        className="w-full h-auto object-contain"
      />

      {/* Magnifying glass overlay — CSS-only zoom via background-image */}
      {isHovering && (
        <div
          className="magnify-glass pointer-events-none absolute z-10"
          style={{
            width: glassSize,
            height: glassSize,
            left: mousePos.x - halfGlass,
            top: mousePos.y - halfGlass,
            borderRadius: "50%",
            border: `2px solid ${glow}`,
            boxShadow: `0 0 20px ${glow}, 0 0 40px ${glow.replace("0.4", "0.15")}, inset 0 0 30px rgba(0,0,0,0.3)`,
            backgroundImage: `url(${src})`,
            backgroundSize: `${containerWidth * zoom}px ${containerHeight * zoom}px`,
            backgroundPosition: `${-mousePos.x * zoom + halfGlass}px ${-mousePos.y * zoom + halfGlass}px`,
            backgroundRepeat: "no-repeat",
            backdropFilter: "blur(1px)",
          }}
        />
      )}
    </div>
  )
}
