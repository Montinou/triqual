import Link from "next/link"

const footerLinks = [
  { href: "https://github.com/Montinou/quolar-unified", label: "GitHub", external: true },
  { href: "https://github.com/Montinou/quolar-unified/issues", label: "Issues", external: true },
  { href: "https://github.com/Montinou/quolar-unified/blob/main/LICENSE", label: "MIT License", external: true },
]

export function Footer() {
  return (
    <footer className="border-t border-white/5 px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-6">
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <span>Built with</span>
          <span className="text-primary">♦</span>
          <span>by Montinou</span>
        </div>

        <div className="flex items-center gap-6 sm:gap-8">
          {footerLinks.map((link) => (
            link.external ? (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-foreground-secondary hover:text-primary transition-colors"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-foreground-secondary hover:text-primary transition-colors"
              >
                {link.label}
              </Link>
            )
          ))}
        </div>
      </div>
    </footer>
  )
}
