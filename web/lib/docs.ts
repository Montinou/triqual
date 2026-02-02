import fs from "fs"
import path from "path"
import matter from "gray-matter"

// Path to docs relative to the project
const DOCS_PATH = path.join(process.cwd(), "..", "triqual-plugin", "docs", "references")

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
  // Getting Started
  "installation": {
    title: "Installation & Setup",
    description: "Install Triqual, connect MCP servers, complete first-time setup",
    category: "Getting Started",
    order: 0,
  },
  "bootstrap-workflow": {
    title: "Getting Started",
    description: "Set up Triqual and learn available skills",
    category: "Workflows",
    order: 1,
  },

  // Patterns
  "standard-patterns": {
    title: "Standard Patterns",
    description: "Core patterns for writing reliable Playwright tests",
    category: "Patterns",
    order: 2,
  },

  // Integrations
  "quoth-integration": {
    title: "Quoth Integration",
    description: "Persisting live docs for learned patterns",
    category: "Integrations",
    order: 3,
  },
  "exolar-integration": {
    title: "Exolar Integration",
    description: "Fetch CI analytics, failure history, and test trends",
    category: "Integrations",
    order: 4,
  },
  "playwright-mcp": {
    title: "Playwright MCP",
    description: "Autonomous app verification and exploration",
    category: "Integrations",
    order: 5,
  },

  // Reference
  "locator-strategies": {
    title: "Locator Strategies",
    description: "Best practices for element locators",
    category: "Reference",
    order: 6,
  },
  "skills-reference": {
    title: "Skills Reference",
    description: "Complete reference for all 5 Triqual skills (slash commands)",
    category: "Reference",
    order: 7,
  },
  "configuration": {
    title: "Configuration Reference",
    description: "Complete reference for triqual.config.ts configuration",
    category: "Configuration",
    order: 8,
  },
  "troubleshooting": {
    title: "Troubleshooting Guide",
    description: "Common issues, solutions, and debugging techniques",
    category: "Reference",
    order: 9,
  },
  "api-reference": {
    title: "API Reference",
    description: "Complete API reference for MCP tools, TypeScript types, and configuration",
    category: "Reference",
    order: 10,
  },
  "error-patterns": {
    title: "Error Patterns",
    description: "Common test failure patterns and solutions",
    category: "Reference",
    order: 11,
  },

  // Architecture
  "learning-loop": {
    title: "Documented Learning Loop",
    description: "6-stage learning loop enforced by hooks",
    category: "Architecture",
    order: 12,
  },
  "hooks-system": {
    title: "Hook System",
    description: "Hook architecture, communication protocol, and exit codes",
    category: "Architecture",
    order: 13,
  },
  "agents-guide": {
    title: "Agent Orchestration",
    description: "Complete guide to Triqual's 5 specialized agents",
    category: "Architecture",
    order: 14,
  },
  "draft-folder": {
    title: "Draft Folder Pattern",
    description: "Tests developed in .draft/ folder, promotion requires approval",
    category: "Workflow",
    order: 15,
  },
  "session-state": {
    title: "Session State & Persistence",
    description: "Understanding what persists across sessions and compaction",
    category: "Architecture",
    order: 16,
  },

  // Workflows
  "debug-workflow": {
    title: "Debug Workflow",
    description: "Systematic debugging workflow for test failures",
    category: "Workflows",
    order: 17,
  },
  "explore-workflow": {
    title: "Explore Workflow",
    description: "Interactive browser exploration workflow",
    category: "Workflows",
    order: 18,
  },
  "verification-workflow": {
    title: "Verification Workflow",
    description: "Verification and validation workflow for tests",
    category: "Workflows",
    order: 19,
  },
  "escalation-triggers": {
    title: "Escalation Triggers",
    description: "When and how to escalate test healing attempts",
    category: "Workflows",
    order: 20,
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
