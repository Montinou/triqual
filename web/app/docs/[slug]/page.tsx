import { notFound } from "next/navigation"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getDocBySlug, getAllDocSlugs, getAllDocs } from "@/lib/docs"
import { ArrowLeft, ArrowRight, Edit } from "lucide-react"

interface DocPageProps {
  params: Promise<{
    slug: string
  }>
}

export async function generateStaticParams() {
  const slugs = getAllDocSlugs()
  return slugs.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: DocPageProps) {
  const { slug } = await params
  const doc = getDocBySlug(slug)

  if (!doc) {
    return {
      title: "Not Found | Quolar Docs",
    }
  }

  return {
    title: `${doc.title} | Quolar Docs`,
    description: doc.description,
  }
}

export default async function DocPage({ params }: DocPageProps) {
  const { slug } = await params
  const doc = getDocBySlug(slug)

  if (!doc) {
    notFound()
  }

  // Get previous and next docs for navigation
  const allDocs = getAllDocs()
  const currentIndex = allDocs.findIndex((d) => d.slug === slug)
  const prevDoc = currentIndex > 0 ? allDocs[currentIndex - 1] : null
  const nextDoc = currentIndex < allDocs.length - 1 ? allDocs[currentIndex + 1] : null

  return (
    <article className="max-w-3xl">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <Badge
            variant="outline"
            className="border-primary/40 bg-background-card text-primary font-mono text-xs"
          >
            {doc.category}
          </Badge>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
          {doc.title}
        </h1>
        <p className="text-lg text-foreground-secondary">{doc.description}</p>
      </div>

      <div className="prose prose-lg max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            h1: ({ children }) => (
              <h1 className="text-3xl font-extrabold tracking-tight mt-12 mb-4 text-foreground">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-2xl font-bold tracking-tight mt-10 mb-4 text-foreground border-b border-white/10 pb-2">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-xl font-semibold mt-8 mb-3 text-foreground">
                {children}
              </h3>
            ),
            h4: ({ children }) => (
              <h4 className="text-lg font-semibold mt-6 mb-2 text-foreground">
                {children}
              </h4>
            ),
            p: ({ children }) => (
              <p className="mb-4 text-foreground-secondary leading-relaxed">
                {children}
              </p>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                className="text-primary hover:underline"
                target={href?.startsWith("http") ? "_blank" : undefined}
                rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
              >
                {children}
              </a>
            ),
            ul: ({ children }) => (
              <ul className="list-disc list-inside mb-4 space-y-2 text-foreground-secondary">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal list-inside mb-4 space-y-2 text-foreground-secondary">
                {children}
              </ol>
            ),
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 border-primary pl-4 my-4 italic text-foreground-secondary">
                {children}
              </blockquote>
            ),
            code: ({ className, children, ...props }) => {
              const isInline = !className
              if (isInline) {
                return (
                  <code className="bg-background-card px-1.5 py-0.5 rounded text-sm font-mono text-primary">
                    {children}
                  </code>
                )
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            },
            pre: ({ children }) => (
              <pre className="bg-background-card border border-white/10 rounded-xl p-4 overflow-x-auto my-4 font-mono text-sm">
                {children}
              </pre>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto my-6">
                <table className="w-full border-collapse border border-white/10 rounded-lg overflow-hidden">
                  {children}
                </table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-background-card">{children}</thead>
            ),
            th: ({ children }) => (
              <th className="px-4 py-3 text-left text-sm font-semibold text-foreground border-b border-white/10">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-4 py-3 text-sm text-foreground-secondary border-b border-white/5">
                {children}
              </td>
            ),
            hr: () => <hr className="my-8 border-white/10" />,
            strong: ({ children }) => (
              <strong className="font-semibold text-foreground">{children}</strong>
            ),
            em: ({ children }) => <em className="italic">{children}</em>,
          }}
        >
          {doc.content}
        </ReactMarkdown>
      </div>

      {/* Navigation */}
      <div className="mt-16 pt-8 border-t border-white/10 flex justify-between gap-4">
        {prevDoc ? (
          <Link href={`/docs/${prevDoc.slug}`} className="group">
            <Button
              variant="ghost"
              className="h-auto py-4 px-6 flex flex-col items-start gap-1 hover:bg-background-card"
            >
              <span className="flex items-center gap-2 text-xs text-foreground-muted">
                <ArrowLeft className="w-3 h-3 group-hover:-translate-x-1 transition-transform" />
                Previous
              </span>
              <span className="text-sm font-medium">{prevDoc.title}</span>
            </Button>
          </Link>
        ) : (
          <div />
        )}
        {nextDoc && (
          <Link href={`/docs/${nextDoc.slug}`} className="group ml-auto">
            <Button
              variant="ghost"
              className="h-auto py-4 px-6 flex flex-col items-end gap-1 hover:bg-background-card"
            >
              <span className="flex items-center gap-2 text-xs text-foreground-muted">
                Next
                <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
              </span>
              <span className="text-sm font-medium">{nextDoc.title}</span>
            </Button>
          </Link>
        )}
      </div>

      {/* Edit link */}
      <div className="mt-8 text-center">
        <a
          href={`https://github.com/Montinou/quolar-unified/edit/main/quolar-plugin/docs/references/${slug}.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm text-foreground-muted hover:text-foreground-secondary transition-colors"
        >
          <Edit className="w-3 h-3" />
          Edit this page on GitHub
        </a>
      </div>
    </article>
  )
}
