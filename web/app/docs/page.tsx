import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getDocsByCategory } from "@/lib/docs"
import { BookOpen, Workflow, Puzzle, FileCode, Wrench, ArrowRight } from "lucide-react"

const categoryIcons: Record<string, typeof BookOpen> = {
  Patterns: BookOpen,
  Workflows: Workflow,
  Tools: Wrench,
  Reference: FileCode,
  Integrations: Puzzle,
  Other: FileCode,
}

const categoryColors: Record<string, string> = {
  Patterns: "border-secondary/25 hover:border-secondary/50",
  Workflows: "border-primary/25 hover:border-primary/50",
  Tools: "border-accent/25 hover:border-accent/50",
  Reference: "border-destructive/25 hover:border-destructive/50",
  Integrations: "border-primary/25 hover:border-primary/50",
  Other: "border-white/10 hover:border-white/25",
}

const categoryOrder = ["Patterns", "Workflows", "Tools", "Reference", "Integrations", "Other"]

export default function DocsPage() {
  const docsByCategory = getDocsByCategory()

  const sortedCategories = Object.keys(docsByCategory).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b)
  )

  return (
    <div className="max-w-4xl">
      <div className="mb-12">
        <Badge
          variant="outline"
          className="mb-4 border-primary/40 bg-background-card text-primary font-mono"
        >
          Documentation
        </Badge>
        <h1 className="text-4xl font-extrabold tracking-tight mb-4">
          Triqual Documentation
        </h1>
        <p className="text-lg text-foreground-secondary">
          Learn how to use Triqual for intelligent test automation. These guides cover
          everything from basic patterns to advanced integrations.
        </p>
      </div>

      <div className="space-y-12">
        {sortedCategories.map((category) => {
          const Icon = categoryIcons[category] || FileCode
          const docs = docsByCategory[category]

          return (
            <section key={category}>
              <h2 className="flex items-center gap-3 text-xl font-bold mb-6">
                <Icon className="w-5 h-5 text-primary" />
                {category}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {docs.map((doc) => (
                  <Link key={doc.slug} href={`/docs/${doc.slug}`}>
                    <Card
                      className={`bg-background-surface border transition-all h-full group ${categoryColors[category]}`}
                    >
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base font-semibold flex items-center justify-between">
                          {doc.title}
                          <ArrowRight className="w-4 h-4 text-foreground-muted group-hover:text-primary group-hover:translate-x-1 transition-all" />
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-foreground-secondary">
                          {doc.description}
                        </p>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
