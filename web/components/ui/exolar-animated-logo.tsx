"use client";

import React, { useState, useEffect } from "react";
import { motion, Transition } from "framer-motion";

// Size presets
const SIZES = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
} as const;

type SizePreset = keyof typeof SIZES;

interface ExolarAnimatedLogoProps {
  size?: SizePreset | number;
  animated?: boolean;
  className?: string;
}

interface ZigZagBoltProps {
  color: string;
  delay: number;
  duration: number;
  strokeWidth?: number;
  animated?: boolean;
  pathData: string;
  rotation: number;
}

// Zig-Zag Lightning Bolt Component
function ZigZagBolt({
  color,
  delay,
  duration,
  strokeWidth = 2,
  animated = true,
  pathData,
  rotation,
}: ZigZagBoltProps) {
  if (!animated) {
    return (
      <div
        className="absolute inset-0 w-full h-full flex items-center justify-center pointer-events-none"
        style={{ transform: `rotate(${rotation}deg)` }}
      >
        <svg
          viewBox="0 0 100 100"
          className="w-[140%] h-[140%] overflow-visible opacity-60"
        >
          <path
            d={pathData}
            stroke={color}
            strokeWidth={strokeWidth}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="bevel"
            filter={`drop-shadow(0 0 4px ${color})`}
          />
        </svg>
      </div>
    );
  }

  return (
    <motion.div
      className="absolute inset-0 w-full h-full flex items-center justify-center pointer-events-none"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <motion.svg
        viewBox="0 0 100 100"
        className="w-[140%] h-[140%] overflow-visible"
        initial={{ opacity: 0 }}
        animate={{
          opacity: [0, 1, 0, 0, 0.8, 0], // Double flash effect
        }}
        transition={{
          duration: 0.4,
          times: [0, 0.1, 0.2, 0.3, 0.4, 1],
          repeat: Infinity,
          repeatDelay: duration,
          delay: delay,
          ease: "linear",
        }}
      >
        <path
          d={pathData}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="bevel"
          filter={`drop-shadow(0 0 4px ${color})`}
        />
      </motion.svg>
    </motion.div>
  );
}

// Generate random zig-zag path
function generatePathData(): string {
  let d = "M -10,50 ";
  const segments = 6;
  for (let i = 1; i <= segments; i++) {
    const x = (i / segments) * 120 - 10;
    const jitter = (Math.random() - 0.5) * 50;
    d += `L ${x},${50 + jitter} `;
  }
  return d;
}

interface BoltData {
  pathData: string;
  rotation: number;
}

// Eclipse Body with Lightning
function EclipseBody({
  size,
  animated,
  bolts,
}: {
  size: number;
  animated: boolean;
  bolts: BoltData[];
}) {
  return (
    <div
      className="relative rounded-full bg-black z-10 shadow-2xl overflow-hidden isolate"
      style={{ width: size, height: size }}
    >
      {/* Dual Metallic Border */}
      <div
        className="absolute inset-0 rounded-full opacity-100 pointer-events-none z-20"
        style={{
          border: "2px solid transparent",
          background:
            "linear-gradient(135deg, #06b6d4, #000000 40%, #000000 60%, #f97316) border-box",
          WebkitMask:
            "linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0)",
          WebkitMaskComposite: "xor",
          maskComposite: "exclude",
        }}
      />

      {/* Interior: Zig-Zag Lightning Bolts */}
      {bolts.length === 3 && (
        <div className="absolute inset-0 w-full h-full z-10">
          {/* Cyan Bolt - Slow */}
          <ZigZagBolt
            color="#22d3ee"
            delay={1}
            duration={6}
            animated={animated}
            pathData={bolts[0].pathData}
            rotation={bolts[0].rotation}
          />

          {/* Orange Bolt - Counter-timed */}
          <ZigZagBolt
            color="#f97316"
            delay={4.5}
            duration={7}
            animated={animated}
            pathData={bolts[1].pathData}
            rotation={bolts[1].rotation}
          />

          {/* White Central Bolt - Rare and fast */}
          <ZigZagBolt
            color="#ffffff"
            delay={2}
            duration={10}
            strokeWidth={1.5}
            animated={animated}
            pathData={bolts[2].pathData}
            rotation={bolts[2].rotation}
          />
        </div>
      )}

      {/* Internal darkening for depth */}
      <div className="absolute inset-0 bg-[radial-gradient(circle,transparent_20%,black_100%)] z-10 pointer-events-none" />
    </div>
  );
}

// Main Animated Logo Component
export function ExolarAnimatedLogo({
  size = "md",
  animated = true,
  className = "",
}: ExolarAnimatedLogoProps) {
  const [mounted, setMounted] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [bolts, setBolts] = useState<BoltData[]>([]);

  // Generate random data only on client side
  useEffect(() => {
    setMounted(true);
    setPrefersReducedMotion(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    // Generate 3 bolts with random paths and rotations
    setBolts([
      { pathData: generatePathData(), rotation: Math.random() * 360 },
      { pathData: generatePathData(), rotation: Math.random() * 360 },
      { pathData: generatePathData(), rotation: Math.random() * 360 },
    ]);
  }, []);

  const pixelSize = typeof size === "number" ? size : SIZES[size];

  // Scale factor based on size (base is 64px)
  const scale = pixelSize / 64;
  const containerSize = pixelSize * 1.5; // Container needs to be bigger for glow effects
  const eclipseSize = pixelSize;
  const glowSize = pixelSize * 1.25;
  const blurAmount = 35 * scale; // Stronger blur for more visible glow

  // Breathing animation transition
  const breathingTransition: Transition = {
    duration: 4,
    repeat: Infinity,
    repeatType: "mirror",
    ease: "easeInOut",
  };

  const shouldAnimate = animated && !prefersReducedMotion;

  // Static placeholder before mounting (same structure, no random elements)
  if (!mounted) {
    return (
      <div
        className={`relative flex items-center justify-center ${className}`}
        style={{
          width: containerSize,
          height: containerSize,
        }}
      >
        <div
          className="relative flex items-center justify-center"
          style={{ width: containerSize, height: containerSize }}
        >
          {/* Static Ice Glow */}
          <div
            className="absolute bg-cyan-500 rounded-full mix-blend-screen opacity-50"
            style={{
              width: glowSize,
              height: glowSize,
              top: -8 * scale,
              left: -8 * scale,
              filter: `blur(${blurAmount}px)`,
            }}
          />

          {/* Static Fire Glow */}
          <div
            className="absolute bg-orange-600 rounded-full mix-blend-screen opacity-50"
            style={{
              width: glowSize,
              height: glowSize,
              bottom: -8 * scale,
              right: -8 * scale,
              filter: `blur(${blurAmount}px)`,
            }}
          />

          {/* Eclipse Body without lightning */}
          <div
            className="relative rounded-full bg-black z-10 shadow-2xl overflow-hidden isolate"
            style={{ width: eclipseSize, height: eclipseSize }}
          >
            {/* Dual Metallic Border */}
            <div
              className="absolute inset-0 rounded-full opacity-100 pointer-events-none z-20"
              style={{
                border: "2px solid transparent",
                background:
                  "linear-gradient(135deg, #06b6d4, #000000 40%, #000000 60%, #f97316) border-box",
                WebkitMask:
                  "linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0)",
                WebkitMaskComposite: "xor",
                maskComposite: "exclude",
              }}
            />
            {/* Internal darkening for depth */}
            <div className="absolute inset-0 bg-[radial-gradient(circle,transparent_20%,black_100%)] z-10 pointer-events-none" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative flex items-center justify-center ${className}`}
      style={{
        width: containerSize,
        height: containerSize,
      }}
    >
      {shouldAnimate ? (
        <motion.div
          className="relative flex items-center justify-center"
          style={{ width: containerSize, height: containerSize }}
          animate={{ y: [-3 * scale, 3 * scale, -3 * scale] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        >
          {/* Ice Side Glow (Background) - Breathing animation */}
          <motion.div
            className="absolute bg-cyan-500 rounded-full mix-blend-screen"
            style={{
              width: glowSize,
              height: glowSize,
              top: -8 * scale,
              left: -8 * scale,
              filter: `blur(${blurAmount}px)`,
            }}
            animate={{ scale: [0.6, 1.3], opacity: [0.1, 0.8] }}
            transition={breathingTransition}
          />

          {/* Fire Side Glow (Background) - Breathing animation */}
          <motion.div
            className="absolute bg-orange-600 rounded-full mix-blend-screen"
            style={{
              width: glowSize,
              height: glowSize,
              bottom: -8 * scale,
              right: -8 * scale,
              filter: `blur(${blurAmount}px)`,
            }}
            animate={{ scale: [0.6, 1.3], opacity: [0.1, 0.9] }}
            transition={{ ...breathingTransition, delay: 2 }}
          />

          {/* Eclipse Body */}
          <EclipseBody size={eclipseSize} animated={shouldAnimate} bolts={bolts} />
        </motion.div>
      ) : (
        <div
          className="relative flex items-center justify-center"
          style={{ width: containerSize, height: containerSize }}
        >
          {/* Static Ice Glow */}
          <div
            className="absolute bg-cyan-500 rounded-full mix-blend-screen opacity-50"
            style={{
              width: glowSize,
              height: glowSize,
              top: -8 * scale,
              left: -8 * scale,
              filter: `blur(${blurAmount}px)`,
            }}
          />

          {/* Static Fire Glow */}
          <div
            className="absolute bg-orange-600 rounded-full mix-blend-screen opacity-50"
            style={{
              width: glowSize,
              height: glowSize,
              bottom: -8 * scale,
              right: -8 * scale,
              filter: `blur(${blurAmount}px)`,
            }}
          />

          {/* Eclipse Body */}
          <EclipseBody size={eclipseSize} animated={false} bolts={bolts} />
        </div>
      )}
    </div>
  );
}

export default ExolarAnimatedLogo;
