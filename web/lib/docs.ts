import fs from "fs"
import path from "path"
import matter from "gray-matter"

// Path to docs relative to the project
const DOCS_PATH = path.join(process.cwd(), "..", "quolar-plugin", "docs", "references")

export interface DocMeta {
  slug: string
  title: string
  description: string
  category: string
  order: number
}

export interface Doc extends DocMeta {
  content: string
}

// Define document metadata (since the markdown files may not have frontmatter)
const docsMeta: Record<string, Omit<DocMeta, "slug">> = {
  "standard-patterns": {
    title: "Standard Patterns",
    description: "Core patterns for writing reliable Playwright tests",
    category: "Patterns",
    order: 1,
  },
  "escalation-triggers": {
    title: "Escalation Triggers",
    description: "When and how to escalate test failures",
    category: "Patterns",
    order: 2,
  },
  "playwright-mcp": {
    title: "Playwright MCP",
    description: "Using the Playwright MCP server for browser automation",
    category: "Tools",
    order: 3,
  },
  "bootstrap-workflow": {
    title: "Bootstrap Workflow",
    description: "How to bootstrap new test projects",
    category: "Workflows",
    order: 4,
  },
  "debug-workflow": {
    title: "Debug Workflow",
    description: "Systematic approach to debugging test failures",
    category: "Workflows",
    order: 5,
  },
  "explore-workflow": {
    title: "Explore Workflow",
    description: "How to explore and understand web applications",
    category: "Workflows",
    order: 6,
  },
  "verification-workflow": {
    title: "Verification Workflow",
    description: "Verifying test results and assertions",
    category: "Workflows",
    order: 7,
  },
  "error-patterns": {
    title: "Error Patterns",
    description: "Common error patterns and how to handle them",
    category: "Reference",
    order: 8,
  },
  "locator-strategies": {
    title: "Locator Strategies",
    description: "Best practices for element locators",
    category: "Reference",
    order: 9,
  },
  "quoth-integration": {
    title: "Quoth Integration",
    description: "Integrating with Quoth for pattern documentation",
    category: "Integrations",
    order: 10,
  },
  "exolar-integration": {
    title: "Exolar Integration",
    description: "Integrating with Exolar for test analytics",
    category: "Integrations",
    order: 11,
  },
}

export function getAllDocs(): DocMeta[] {
  if (!fs.existsSync(DOCS_PATH)) {
    console.warn(`Docs path not found: ${DOCS_PATH}`)
    return []
  }

  const files = fs.readdirSync(DOCS_PATH)

  return files
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const slug = file.replace(/\.md$/, "")
      const meta = docsMeta[slug]

      if (!meta) {
        return {
          slug,
          title: slug
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" "),
          description: "",
          category: "Other",
          order: 99,
        }
      }

      return {
        slug,
        ...meta,
      }
    })
    .sort((a, b) => a.order - b.order)
}

export function getDocBySlug(slug: string): Doc | null {
  const filePath = path.join(DOCS_PATH, `${slug}.md`)

  if (!fs.existsSync(filePath)) {
    return null
  }

  const fileContents = fs.readFileSync(filePath, "utf8")
  const { data, content } = matter(fileContents)

  const meta = docsMeta[slug] || {
    title: data.title || slug.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
    description: data.description || "",
    category: data.category || "Other",
    order: data.order || 99,
  }

  return {
    slug,
    ...meta,
    content,
  }
}

export function getDocsByCategory(): Record<string, DocMeta[]> {
  const docs = getAllDocs()
  const byCategory: Record<string, DocMeta[]> = {}

  for (const doc of docs) {
    if (!byCategory[doc.category]) {
      byCategory[doc.category] = []
    }
    byCategory[doc.category].push(doc)
  }

  return byCategory
}

export function getAllDocSlugs(): string[] {
  return getAllDocs().map((doc) => doc.slug)
}
