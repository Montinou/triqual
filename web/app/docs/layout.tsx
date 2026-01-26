import { Navbar, Footer } from "@/components/layout"
import { DocsSidebar } from "@/components/layout/docs-sidebar"
import { getDocsByCategory } from "@/lib/docs"

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const docsByCategory = getDocsByCategory()

  return (
    <>
      <Navbar />
      <div className="min-h-screen pt-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-8">
            <DocsSidebar docsByCategory={docsByCategory} />
            <main className="flex-1 min-w-0 py-8">{children}</main>
          </div>
        </div>
      </div>
      <Footer />
    </>
  )
}
