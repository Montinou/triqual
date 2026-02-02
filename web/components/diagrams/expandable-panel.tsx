"use client"

import { motion, AnimatePresence } from "framer-motion"
import Image from "next/image"
import { X } from "lucide-react"
import { panelSlideIn, buttonPress } from "@/lib/spatial-animations"

export interface DocLink {
  label: string
  href: string
}

export interface ExpandablePanelProps {
  isOpen: boolean
  onClose: () => void
  title: string
  diagram?: string
  content: React.ReactNode
  relatedLinks?: DocLink[]
}

export function ExpandablePanel({
  isOpen,
  onClose,
  title,
  diagram,
  content,
  relatedLinks = [],
}: ExpandablePanelProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            className="fixed top-0 right-0 h-full w-full md:w-[500px] lg:w-[550px] bg-background-surface border-l border-border z-50 overflow-y-auto"
            variants={panelSlideIn}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {/* Header */}
            <div className="sticky top-0 bg-background-surface/95 backdrop-blur-xl border-b border-border p-4 flex items-center justify-between z-10">
              <h2 className="text-xl font-bold gradient-text">{title}</h2>
              <motion.button
                className="p-2 rounded-lg border border-border hover:border-primary/50 transition-colors"
                onClick={onClose}
                {...buttonPress}
              >
                <X className="w-4 h-4" />
              </motion.button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Diagram if provided */}
              {diagram && (
                <motion.div
                  className="relative w-full rounded-lg overflow-hidden border border-border/50 min-h-[45vh] flex items-center justify-center bg-background-card"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                >
                  <Image
                    src={diagram}
                    alt={title}
                    width={1920}
                    height={1440}
                    quality={85}
                    className="w-full h-full object-contain"
                  />
                </motion.div>
              )}

              {/* Main content */}
              <motion.div
                className="prose prose-sm max-w-none"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                {content}
              </motion.div>

              {/* Related links */}
              {relatedLinks.length > 0 && (
                <motion.div
                  className="pt-6 border-t border-border"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                >
                  <h3 className="text-sm font-semibold text-foreground-muted mb-3">
                    Related Documentation
                  </h3>
                  <div className="space-y-2">
                    {relatedLinks.map((link, index) => (
                      <motion.a
                        key={index}
                        href={link.href}
                        className="block px-4 py-3 rounded-lg border border-border hover:border-primary/50 hover:bg-background-card transition-all text-sm"
                        whileHover={{ x: 4 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                      >
                        {link.label} →
                      </motion.a>
                    ))}
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
