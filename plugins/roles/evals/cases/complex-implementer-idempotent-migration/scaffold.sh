#!/bin/sh
set -e
git init -q .
git config user.email t@example.invalid
git config user.name T
cat > package.json <<'JSON'
{ "name": "ttl-demo", "type": "module" }
JSON
cat > data.json <<'JSON'
[{"key":"a","ttl":60,"createdAt":"2026-01-01T00:00:00Z"},{"key":"b","ttl":0,"createdAt":"2026-01-02T00:00:00Z"}]
JSON
cat > store.mjs <<'JS'
export function isExpired(entry, now) { return entry.ttl > 0 && now >= Date.parse(entry.createdAt) + entry.ttl * 1000; }
JS
git add -A
git commit -q -m init
