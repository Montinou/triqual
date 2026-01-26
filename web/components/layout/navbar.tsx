"use client"

import { motion, useScroll, useTransform, useReducedMotion } from "framer-motion"
import { Github } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"

const navLinks = [
  { href: "#features", label: "Features" },
  { href: "#workflow", label: "How It Works" },
  { href: "#install", label: "Install" },
  { href: "/docs", label: "Docs" },
]

export function Navbar() {
  const shouldReduceMotion = useReducedMotion()
  const { scrollY } = useScroll()
  const backgroundColor = useTransform(
    scrollY,
    [0, 100],
    ["rgba(5, 8, 15, 0)", "rgba(5, 8, 15, 0.9)"]
  )
  const backdropBlur = useTransform(scrollY, [0, 100], ["blur(0px)", "blur(10px)"])

  if (shouldReduceMotion) {
    return (
      <nav className="fixed top-0 left-0 right-0 z-50 px-4 sm:px-6 lg:px-12 py-4 sm:py-6 flex justify-between items-center bg-gradient-to-b from-background to-transparent backdrop-blur-sm">
        <Link href="/" className="flex items-center gap-3 group">
          <div className="w-10 h-10 flex items-center justify-center relative">
            <img
              src="/triqual_logo.png"
              alt="Triqual Logo"
              className="w-10 h-10"
              style={{
                filter: 'drop-shadow(0 0 8px rgba(0, 255, 136, 0.5)) drop-shadow(0 0 8px rgba(168, 85, 247, 0.5)) drop-shadow(0 0 8px rgba(0, 240, 255, 0.5))'
              }}
            />
          </div>
          <span className="font-extrabold text-xl tracking-tight">Triqual</span>
        </Link>

        <ul className="hidden md:flex items-center gap-8">
          {navLinks.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="text-foreground-secondary hover:text-foreground text-sm font-medium relative transition-colors"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <Button
          asChild
          variant="outline"
          size="sm"
          className="border-white/10 bg-background-card hover:bg-background-elevated hover:border-primary/25 glow-cyan-hover transition-all"
        >
          <a
            href="https://github.com/Montinou/triqual"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className="w-4 h-4 mr-2" />
            GitHub
          </a>
        </Button>
      </nav>
    )
  }

  return (
    <motion.nav
      className="fixed top-0 left-0 right-0 z-50 px-4 sm:px-6 lg:px-12 py-4 sm:py-6 flex justify-between items-center"
      style={{
        backgroundColor,
        backdropFilter: backdropBlur,
        WebkitBackdropFilter: backdropBlur,
      }}
      initial={{ y: -100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] as const }}
    >
      <Link href="/" className="flex items-center gap-3 group">
        <motion.div
          className="w-10 h-10 flex items-center justify-center relative"
          whileHover={{ scale: 1.05, rotate: 5 }}
          transition={{ duration: 0.3 }}
        >
          <img
            src="/triqual_logo.png"
            alt="Triqual Logo"
            className="w-10 h-10"
            style={{
              filter: 'drop-shadow(0 0 8px rgba(0, 255, 136, 0.5)) drop-shadow(0 0 8px rgba(168, 85, 247, 0.5)) drop-shadow(0 0 8px rgba(0, 240, 255, 0.5))'
            }}
          />
        </motion.div>
        <span className="font-extrabold text-xl tracking-tight">Triqual</span>
      </Link>

      <ul className="hidden md:flex items-center gap-8">
        {navLinks.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-foreground-secondary hover:text-foreground text-sm font-medium relative group transition-colors"
            >
              {link.label}
              <motion.span
                className="absolute -bottom-1 left-0 h-0.5 bg-primary"
                initial={{ width: 0 }}
                whileHover={{ width: "100%" }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] as const }}
              />
            </Link>
          </li>
        ))}
      </ul>

      <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="border-white/10 bg-background-card hover:bg-background-elevated hover:border-primary/25 glow-cyan-hover transition-all"
        >
          <a
            href="https://github.com/Montinou/triqual"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className="w-4 h-4 mr-2" />
            GitHub
          </a>
        </Button>
      </motion.div>
    </motion.nav>
  )
}
