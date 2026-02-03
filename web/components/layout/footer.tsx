import Link from "next/link"
import { Github, Twitter, Mail } from "lucide-react"

const footerLinks = [
  { href: "https://github.com/Montinou/triqual", label: "GitHub", external: true },
  { href: "https://github.com/Montinou/triqual/issues", label: "Issues", external: true },
  { href: "https://github.com/Montinou/triqual/blob/main/LICENSE", label: "MIT License", external: true },
  { href: "/docs", label: "Docs", external: false },
  { href: "/how-it-works", label: "How It Works", external: false },
]

const socialLinks = [
  { href: "https://github.com/Montinou/triqual", icon: Github, label: "GitHub" },
  { href: "https://x.com/Montinou", icon: Twitter, label: "Twitter / X" },
  { href: "mailto:hi@triqual.dev", icon: Mail, label: "Email" },
]

export function Footer() {
  return (
    <footer className="border-t border-white/5 px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <div className="max-w-6xl mx-auto flex flex-col gap-8">
        {/* Top row: logo + links */}
        <div className="flex flex-col sm:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <img
              src="/triqual_logo.png"
              alt="Triqual Logo"
              className="w-8 h-8"
              style={{
                filter: 'drop-shadow(0 0 6px rgba(0, 255, 136, 0.4)) drop-shadow(0 0 6px rgba(168, 85, 247, 0.4)) drop-shadow(0 0 6px rgba(0, 240, 255, 0.4))'
              }}
            />
            <div className="flex items-center gap-2 text-sm text-foreground-muted">
              <span>Built with</span>
              <span className="text-primary">♦</span>
              <span>by Montinou</span>
            </div>
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

        {/* Bottom row: socials + copyright */}
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 pt-4 border-t border-white/5">
          <div className="flex items-center gap-4">
            {socialLinks.map((social) => {
              const Icon = social.icon
              return (
                <a
                  key={social.href}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground-muted hover:text-primary transition-colors"
                  aria-label={social.label}
                >
                  <Icon className="w-4 h-4" />
                </a>
              )
            })}
          </div>
          <p className="text-xs text-foreground-muted">
            © 2026 Triqual. Open source under MIT License.
          </p>
        </div>
      </div>
    </footer>
  )
}
