"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { DocMeta } from "@/lib/docs"
import { ChevronRight, BookOpen, Workflow, Puzzle, FileCode, Wrench } from "lucide-react"

interface DocsSidebarProps {
  docsByCategory: Record<string, DocMeta[]>
}

const categoryIcons: Record<string, typeof BookOpen> = {
  Patterns: BookOpen,
  Workflows: Workflow,
  Tools: Wrench,
  Reference: FileCode,
  Integrations: Puzzle,
  Other: FileCode,
}

const categoryOrder = ["Patterns", "Workflows", "Tools", "Reference", "Integrations", "Other"]

export function DocsSidebar({ docsByCategory }: DocsSidebarProps) {
  const pathname = usePathname()

  const sortedCategories = Object.keys(docsByCategory).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b)
  )

  return (
    <aside className="hidden lg:block w-64 flex-shrink-0 border-r border-white/5">
      <div className="sticky top-20 h-[calc(100vh-5rem)]">
        <ScrollArea className="h-full py-6 pr-6">
          <nav className="space-y-6">
            <div>
              <Link
                href="/docs"
                className={cn(
                  "flex items-center gap-2 text-sm font-medium transition-colors",
                  pathname === "/docs"
                    ? "text-primary"
                    : "text-foreground-secondary hover:text-foreground"
                )}
              >
                <BookOpen className="w-4 h-4" />
                Documentation
              </Link>
            </div>

            {sortedCategories.map((category) => {
              const Icon = categoryIcons[category] || FileCode
              const docs = docsByCategory[category]

              return (
                <div key={category}>
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-3">
                    <Icon className="w-3.5 h-3.5" />
                    {category}
                  </h3>
                  <ul className="space-y-1">
                    {docs.map((doc) => {
                      const isActive = pathname === `/docs/${doc.slug}`
                      return (
                        <li key={doc.slug}>
                          <Link
                            href={`/docs/${doc.slug}`}
                            className={cn(
                              "group flex items-center gap-2 py-1.5 text-sm transition-colors rounded-md pl-2 -ml-2",
                              isActive
                                ? "text-primary bg-primary/5"
                                : "text-foreground-secondary hover:text-foreground hover:bg-white/5"
                            )}
                          >
                            <ChevronRight
                              className={cn(
                                "w-3 h-3 transition-transform",
                                isActive ? "text-primary" : "text-foreground-muted group-hover:text-foreground-secondary"
                              )}
                            />
                            {doc.title}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </nav>
        </ScrollArea>
      </div>
    </aside>
  )
}
