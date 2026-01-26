"use client"

import { useState, type ReactNode } from "react"
import { motion, useReducedMotion, useInView, AnimatePresence } from "framer-motion"
import { useRef } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface CodeLine {
  type: "comment" | "command"
  content: ReactNode
}

const pluginCode: CodeLine[] = [
  { type: "comment", content: "# Add the marketplace" },
  {
    type: "command",
    content: (
      <>
        <span className="text-primary">/plugin</span>{" "}
        <span className="text-secondary">marketplace add</span>{" "}
        <span className="text-destructive">Montinou/triqual</span>
      </>
    ),
  },
  { type: "comment", content: "" },
  { type: "comment", content: "# Install the plugin" },
  {
    type: "command",
    content: (
      <>
        <span className="text-primary">/plugin</span>{" "}
        <span className="text-secondary">install</span>{" "}
        <span className="text-destructive">triqual@triqual</span>
      </>
    ),
  },
  { type: "comment", content: "" },
  { type: "comment", content: "# That's it! Start testing:" },
  {
    type: "command",
    content: (
      <span className="text-secondary">&quot;Test if the login page loads correctly&quot;</span>
    ),
  },
]

const manualCode: CodeLine[] = [
  { type: "comment", content: "# Clone to plugins directory" },
  {
    type: "command",
    content: (
      <>
        <span className="text-accent">git</span>{" "}
        <span className="text-secondary">clone</span>{" "}
        <span className="text-foreground-secondary">https://github.com/Montinou/triqual</span>{" "}
        <span className="text-destructive">~/.claude/plugins/triqual</span>
      </>
    ),
  },
  { type: "comment", content: "" },
  { type: "comment", content: "# Install Playwright" },
  {
    type: "command",
    content: (
      <>
        <span className="text-accent">cd</span>{" "}
        <span className="text-destructive">~/.claude/plugins/triqual/lib</span>
      </>
    ),
  },
  {
    type: "command",
    content: (
      <>
        <span className="text-accent">npm</span>{" "}
        <span className="text-secondary">run setup</span>
      </>
    ),
  },
  { type: "comment", content: "" },
  { type: "comment", content: "# Ready to use!" },
]

const copyText = {
  plugin: `/plugin marketplace add Montinou/triqual
/plugin install triqual@triqual
"Test if the login page loads correctly"`,
  manual: `git clone https://github.com/Montinou/triqual ~/.claude/plugins/triqual
cd ~/.claude/plugins/triqual/lib
npm run setup`,
}

function CodeBlock({ lines }: { lines: CodeLine[] }) {
  return (
    <pre className="p-6 overflow-x-auto font-mono text-sm leading-loose">
      <code>
        {lines.map((line, i) => (
          <div key={i} className={line.type === "comment" ? "text-foreground-muted" : ""}>
            {line.content || "\u00A0"}
          </div>
        ))}
      </code>
    </pre>
  )
}

export function CodePreview() {
  const shouldReduceMotion = useReducedMotion()
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState("plugin")

  const copyToClipboard = async () => {
    const text = copyText[activeTab as keyof typeof copyText]
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const content = (
    <div className="max-w-4xl mx-auto">
      <div className="text-center mb-12">
        <p className="font-mono text-sm text-primary uppercase tracking-widest mb-4">
          Installation
        </p>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
          Get Started in Seconds
        </h2>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="bg-background-elevated border border-white/10 p-1 rounded-t-2xl rounded-b-none w-fit">
          <TabsTrigger
            value="plugin"
            className="font-mono text-sm data-[state=active]:bg-background-card data-[state=active]:text-primary data-[state=active]:border-primary/25 rounded-xl px-6"
          >
            Plugin Install
          </TabsTrigger>
          <TabsTrigger
            value="manual"
            className="font-mono text-sm data-[state=active]:bg-background-card data-[state=active]:text-primary data-[state=active]:border-primary/25 rounded-xl px-6"
          >
            Manual
          </TabsTrigger>
        </TabsList>

        <div className="relative bg-background-card border border-white/10 border-t-0 rounded-b-2xl rounded-tr-2xl overflow-hidden">
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-4 right-4 text-foreground-secondary hover:text-foreground z-10"
            onClick={copyToClipboard}
          >
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span
                  key="check"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="flex items-center gap-2"
                >
                  <Check className="w-4 h-4 text-secondary" />
                  Copied!
                </motion.span>
              ) : (
                <motion.span
                  key="copy"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="flex items-center gap-2"
                >
                  <Copy className="w-4 h-4" />
                  Copy
                </motion.span>
              )}
            </AnimatePresence>
          </Button>

          <TabsContent value="plugin" className="m-0">
            <CodeBlock lines={pluginCode} />
          </TabsContent>

          <TabsContent value="manual" className="m-0">
            <CodeBlock lines={manualCode} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )

  if (shouldReduceMotion) {
    return (
      <section
        id="install"
        className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-transparent via-background-surface/50 to-transparent"
      >
        {content}
      </section>
    )
  }

  return (
    <motion.section
      ref={ref}
      id="install"
      className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-transparent via-background-surface/50 to-transparent"
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] as const }}
    >
      {content}
    </motion.section>
  )
}
