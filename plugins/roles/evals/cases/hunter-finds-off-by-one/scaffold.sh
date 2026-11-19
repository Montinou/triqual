#!/bin/sh
set -e
mkdir -p src
cat > src/queue.mjs <<'SRC'
export class Queue {
  constructor() { this.items = []; }
  push(item) { this.items.push(item); }
  // Removes and returns up to n items from the front.
  drain(n) {
    const out = [];
    for (let i = 0; i <= n && this.items.length > 0; i += 1) out.push(this.items.shift());
    return out;
  }
}
SRC
git init -q .
git add -N src
git diff > diff.patch
