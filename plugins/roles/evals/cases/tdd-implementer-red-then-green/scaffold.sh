#!/bin/sh
set -e
git init -q .
git config user.email t@example.invalid
git config user.name T
cat > package.json <<'JSON'
{ "name": "slug-demo", "type": "module" }
JSON
cat > slug.mjs <<'JS'
export function slugify(text) { return text.toLowerCase().replace(/\s+/g, '-'); }
JS
printf '# Report\n' > report.md
git add -A
git commit -q -m init
