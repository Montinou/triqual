#!/bin/sh
set -e
git init -q .
git config user.email t@example.invalid
git config user.name T
cat > package.json <<'JSON'
{ "name": "retry-demo", "type": "module" }
JSON
cat > fetch.mjs <<'JS'
export async function fetchWithRetry(url) { throw new Error('todo'); }
JS
printf '# Report\n' > report.md
git add -A
git commit -q -m init
