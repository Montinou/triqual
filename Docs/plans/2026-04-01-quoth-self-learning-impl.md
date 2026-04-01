# Quoth Self-Learning Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `quoth-plugin` — an autonomous Claude Code plugin that logs agent trajectories, runs a background daemon with Haiku subagents to JUDGE/DISTILL/CONSOLIDATE patterns, and scores a confidence-weighted pattern library. Triqual gets 2 non-blocking hook extensions to close the feedback loop.

**Architecture:** Hooks log JSONL trajectories silently during sessions. A detached Node.js daemon (started by session-start, survives session close) watches trajectories, spawns parallel `claude -p --model claude-haiku-4-5-20251001` subprocesses for pipeline steps, and writes scored patterns to SQLite. Triqual calls two new MCP tools (fire-and-forget) after test runs to feed outcomes back into pattern scores.

**Tech Stack:** Node.js (CJS), SQLite3 (`better-sqlite3`), bash hooks, `claude -p` subprocesses, Claude Code plugin system. No external APIs. Auth inherited from Claude Code.

---

## Task 1: Scaffold quoth-plugin directory + install deps

**Files:**
- Create: `Quoth/quoth-plugin/package.json`
- Create: `Quoth/quoth-plugin/.claude-plugin/plugin.json`

**Step 1: Create directory structure**

```bash
mkdir -p Quoth/quoth-plugin/{.claude-plugin,hooks/lib,daemon/pipeline,mcp,skills/patterns,skills/learn,context}
```

**Step 2: Create package.json**

```json
{
  "name": "quoth-plugin",
  "version": "1.0.0",
  "description": "Autonomous self-learning plugin for Claude Code",
  "main": "daemon/daemon.js",
  "scripts": {
    "daemon": "node daemon/daemon.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.3"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "@types/better-sqlite3": "^7.6.8"
  }
}
```

**Step 3: Install deps**

```bash
cd Quoth/quoth-plugin && npm install
```

Expected: `node_modules/` created with `better-sqlite3`.

**Step 4: Create plugin.json**

```json
{
  "name": "quoth-plugin",
  "version": "1.0.0",
  "description": "Autonomous self-learning layer for Claude Code — logs agent trajectories, scores patterns, injects learnings",
  "author": "AttorneyShare",
  "mcpServers": ["quoth", "quoth-learning"],
  "hooks": "hooks/hooks.json",
  "skills": "skills/"
}
```

**Step 5: Commit**

```bash
cd Quoth && git add quoth-plugin/ && git commit -m "feat(quoth-plugin): scaffold plugin structure and deps"
```

---

## Task 2: SQLite wrapper (db.js)

**Files:**
- Create: `Quoth/quoth-plugin/daemon/db.js`
- Create: `Quoth/quoth-plugin/tests/db.test.js`

**Step 1: Write failing test**

```javascript
// Quoth/quoth-plugin/tests/db.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Dynamically require db.js with a custom DB_PATH
let tmpDir, db

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quoth-test-'))
  process.env.QUOTH_HOME = tmpDir
  // Re-require to get fresh instance
  const { createDb } = require('../daemon/db.js')
  db = createDb(join(tmpDir, 'memory.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true })
})

describe('db', () => {
  it('initializes schema tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map(r => r.name)
    expect(tables).toContain('patterns')
    expect(tables).toContain('trajectories')
    expect(tables).toContain('memory_entries')
  })

  it('upserts a pattern and reads it back', () => {
    db.upsertPattern({
      id: 'test-pat-1',
      name: 'visibility-filter',
      pattern_type: 'code-pattern',
      condition: 'multiple elements match',
      action: 'add :visible filter',
      confidence: 0.5,
      tags: ['selector', 'playwright'],
      source: 'distilled'
    })
    const p = db.getPattern('test-pat-1')
    expect(p.name).toBe('visibility-filter')
    expect(p.confidence).toBeCloseTo(0.5)
  })

  it('applies confidence delta correctly', () => {
    db.upsertPattern({ id: 'p1', name: 'p', pattern_type: 'code-pattern',
      condition: 'c', action: 'a', confidence: 0.5, tags: [], source: 'test' })
    db.applyConfidenceDelta('p1', 0.03) // success
    const p = db.getPattern('p1')
    expect(p.confidence).toBeCloseTo(0.53)
  })

  it('caps confidence at 1.0', () => {
    db.upsertPattern({ id: 'p2', name: 'p', pattern_type: 'code-pattern',
      condition: 'c', action: 'a', confidence: 0.99, tags: [], source: 'test' })
    db.applyConfidenceDelta('p2', 0.03)
    const p = db.getPattern('p2')
    expect(p.confidence).toBeLessThanOrEqual(1.0)
  })

  it('returns top patterns sorted by confidence', () => {
    db.upsertPattern({ id: 'low', name: 'l', pattern_type: 'code-pattern',
      condition: 'c', action: 'a', confidence: 0.3, tags: [], source: 'test' })
    db.upsertPattern({ id: 'high', name: 'h', pattern_type: 'code-pattern',
      condition: 'c', action: 'a', confidence: 0.9, tags: [], source: 'test' })
    const top = db.getTopPatterns(5)
    expect(top[0].id).toBe('high')
  })

  it('applies hourly decay to all patterns', () => {
    db.upsertPattern({ id: 'decay-p', name: 'p', pattern_type: 'code-pattern',
      condition: 'c', action: 'a', confidence: 0.8, tags: [], source: 'test' })
    db.applyHourlyDecay()
    const p = db.getPattern('decay-p')
    expect(p.confidence).toBeCloseTo(0.795) // 0.8 - 0.005
  })

  it('floors confidence at 0.0', () => {
    db.upsertPattern({ id: 'floor-p', name: 'p', pattern_type: 'code-pattern',
      condition: 'c', action: 'a', confidence: 0.002, tags: [], source: 'test' })
    db.applyHourlyDecay()
    const p = db.getPattern('floor-p')
    expect(p.confidence).toBeGreaterThanOrEqual(0.0)
  })
})
```

**Step 2: Run test — verify fails**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/db.test.js
```

Expected: FAIL — `Cannot find module '../daemon/db.js'`

**Step 3: Implement db.js**

```javascript
// Quoth/quoth-plugin/daemon/db.js
'use strict'

const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pattern_type TEXT NOT NULL DEFAULT 'code-pattern',
  condition TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT,
  confidence REAL DEFAULT 0.5,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  decay_rate REAL DEFAULT 0.005,
  embedding TEXT,
  version INTEGER DEFAULT 1,
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'distilled',
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_matched_at INTEGER
);

CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  status TEXT DEFAULT 'active',
  verdict TEXT,
  task TEXT,
  context TEXT,
  total_steps INTEGER DEFAULT 0,
  total_reward REAL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  ended_at INTEGER,
  extracted_pattern_id TEXT REFERENCES patterns(id)
);

CREATE TABLE IF NOT EXISTS trajectory_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trajectory_id TEXT NOT NULL REFERENCES trajectories(id),
  step_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  observation TEXT,
  reward REAL DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'semantic',
  tags TEXT,
  metadata TEXT,
  access_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_accessed_at INTEGER,
  UNIQUE(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_status ON patterns(status);
`

function createDb(dbPath) {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const db = new Database(dbPath)
  db.exec(SCHEMA)

  // --- Pattern operations ---

  db.upsertPattern = function(p) {
    const stmt = db.prepare(`
      INSERT INTO patterns (id, name, pattern_type, condition, action, description,
        confidence, tags, source, status)
      VALUES (@id, @name, @pattern_type, @condition, @action, @description,
        @confidence, @tags, @source, @status)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        condition = excluded.condition,
        action = excluded.action,
        description = excluded.description,
        confidence = excluded.confidence,
        tags = excluded.tags,
        source = excluded.source,
        updated_at = strftime('%s','now') * 1000
    `)
    stmt.run({
      id: p.id,
      name: p.name,
      pattern_type: p.pattern_type || 'code-pattern',
      condition: p.condition,
      action: p.action,
      description: p.description || null,
      confidence: p.confidence ?? 0.5,
      tags: JSON.stringify(p.tags || []),
      source: p.source || 'distilled',
      status: p.status || 'active'
    })
  }

  db.getPattern = function(id) {
    const row = db.prepare('SELECT * FROM patterns WHERE id = ?').get(id)
    if (!row) return null
    return { ...row, tags: JSON.parse(row.tags || '[]') }
  }

  db.getTopPatterns = function(limit = 5, tags = []) {
    let query = `SELECT * FROM patterns WHERE status = 'active'`
    if (tags.length > 0) {
      const tagConditions = tags.map(t => `tags LIKE '%"${t}"%'`).join(' OR ')
      query += ` AND (${tagConditions})`
    }
    query += ` ORDER BY confidence DESC LIMIT ?`
    return db.prepare(query).all(limit).map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') }))
  }

  db.applyConfidenceDelta = function(id, delta) {
    db.prepare(`
      UPDATE patterns
      SET confidence = MIN(1.0, MAX(0.0, confidence + ?)),
          success_count = CASE WHEN ? > 0 THEN success_count + 1 ELSE success_count END,
          failure_count = CASE WHEN ? < 0 THEN failure_count + 1 ELSE failure_count END,
          last_matched_at = strftime('%s','now') * 1000,
          updated_at = strftime('%s','now') * 1000
      WHERE id = ?
    `).run(delta, delta, delta, id)
  }

  db.applyHourlyDecay = function() {
    db.prepare(`
      UPDATE patterns
      SET confidence = MAX(0.0, confidence - decay_rate),
          updated_at = strftime('%s','now') * 1000
      WHERE status = 'active'
    `).run()
  }

  db.archiveWeakPatterns = function() {
    db.prepare(`
      UPDATE patterns SET status = 'archived', updated_at = strftime('%s','now') * 1000
      WHERE confidence < 0.1
        AND (success_count + failure_count) > 5
        AND status = 'active'
    `).run()
  }

  db.getPromotionCandidates = function() {
    return db.prepare(`
      SELECT * FROM patterns
      WHERE confidence > 0.8
        AND (success_count + failure_count) > 10
        AND status = 'active'
        AND source = 'distilled'
    `).all()
  }

  // --- Trajectory operations ---

  db.appendTrajectoryEntry = function(entry) {
    const id = `${entry.session}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    db.prepare(`
      INSERT OR IGNORE INTO trajectories (id, session_id, status, task, context)
      VALUES (?, ?, 'active', ?, ?)
    `).run(entry.session, entry.session, entry.task || null, JSON.stringify(entry))

    db.prepare(`
      INSERT INTO trajectory_steps (trajectory_id, step_number, action, observation, metadata)
      VALUES (?, (SELECT COUNT(*) + 1 FROM trajectory_steps WHERE trajectory_id = ?), ?, ?, ?)
    `).run(entry.session, entry.session,
      entry.event || 'agent_stop',
      entry.outcome || null,
      JSON.stringify(entry))
  }

  db.getPendingTrajectoryEntries = function(limit = 50) {
    return db.prepare(`
      SELECT ts.*, t.session_id
      FROM trajectory_steps ts
      JOIN trajectories t ON t.id = ts.trajectory_id
      WHERE ts.metadata NOT LIKE '%"processed":true%'
      ORDER BY ts.created_at ASC
      LIMIT ?
    `).all(limit)
  }

  db.markStepProcessed = function(stepId) {
    const row = db.prepare('SELECT metadata FROM trajectory_steps WHERE id = ?').get(stepId)
    if (!row) return
    let meta = {}
    try { meta = JSON.parse(row.metadata || '{}') } catch {}
    meta.processed = true
    db.prepare('UPDATE trajectory_steps SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(meta), stepId)
  }

  return db
}

module.exports = { createDb }
```

**Step 4: Run tests — verify pass**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/db.test.js
```

Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
cd Quoth/quoth-plugin && git add daemon/db.js tests/db.test.js
git commit -m "feat(quoth-plugin): SQLite wrapper with pattern scoring and decay"
```

---

## Task 3: Pipeline — judge.js

**Files:**
- Create: `Quoth/quoth-plugin/daemon/pipeline/judge.js`
- Create: `Quoth/quoth-plugin/tests/judge.test.js`

**Step 1: Write failing test**

```javascript
// Quoth/quoth-plugin/tests/judge.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execSync } from 'child_process'

// Mock execSync to simulate claude -p responses
vi.mock('child_process', () => ({
  execSync: vi.fn()
}))

const { judge } = require('../daemon/pipeline/judge.js')

beforeEach(() => vi.clearAllMocks())

describe('judge', () => {
  it('returns effective:true for successful agent outcome', () => {
    execSync.mockReturnValue(
      JSON.stringify({ effective: true, reason: 'selector fixed', category: 'selector' })
    )
    const result = judge({ agent: 'test-healer', outcome: 'success', task: 'fix login' })
    expect(result.effective).toBe(true)
    expect(result.category).toBe('selector')
  })

  it('returns effective:false for failed outcome', () => {
    execSync.mockReturnValue(
      JSON.stringify({ effective: false, reason: 'timeout issue', category: 'wait' })
    )
    const result = judge({ agent: 'test-healer', outcome: 'failure', task: 'fix login' })
    expect(result.effective).toBe(false)
  })

  it('handles malformed JSON from claude gracefully', () => {
    execSync.mockReturnValue('not valid json at all')
    const result = judge({ agent: 'test-healer', outcome: 'success', task: 'fix login' })
    // Falls back to outcome-based verdict
    expect(result.effective).toBe(true) // success → effective true
    expect(result.fallback).toBe(true)
  })

  it('handles claude subprocess error gracefully', () => {
    execSync.mockImplementation(() => { throw new Error('claude not found') })
    const result = judge({ agent: 'test-healer', outcome: 'success', task: 'fix login' })
    expect(result.effective).toBe(true) // fallback: outcome === 'success'
    expect(result.error).toBeDefined()
  })
})
```

**Step 2: Run test — verify fails**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/judge.test.js
```

Expected: FAIL — `Cannot find module '../daemon/pipeline/judge.js'`

**Step 3: Implement judge.js**

```javascript
// Quoth/quoth-plugin/daemon/pipeline/judge.js
'use strict'

const { execSync } = require('child_process')

const JUDGE_PROMPT = `You are evaluating whether an AI agent action was effective.

Agent: {{agent}}
Task: {{task}}
Outcome: {{outcome}}
Attempts: {{attempts}}
Tools used: {{tool_calls}}

Was this agent action effective and did it achieve the task? 

Respond with ONLY valid JSON (no markdown, no explanation):
{"effective": true/false, "reason": "brief explanation", "category": "selector|wait|auth|data|env|general"}`

function judge(entry) {
  const prompt = JUDGE_PROMPT
    .replace('{{agent}}', entry.agent || 'unknown')
    .replace('{{task}}', entry.task || 'unknown')
    .replace('{{outcome}}', entry.outcome || 'unknown')
    .replace('{{attempts}}', String(entry.attempts || 1))
    .replace('{{tool_calls}}', String(entry.tool_calls || 0))

  try {
    const raw = execSync(
      `echo ${JSON.stringify(prompt)} | claude -p --model claude-haiku-4-5-20251001 --output-format text`,
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    // Extract JSON from response (handle any surrounding text)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')

    const result = JSON.parse(jsonMatch[0])
    return {
      effective: Boolean(result.effective),
      reason: result.reason || '',
      category: result.category || 'general'
    }
  } catch (err) {
    // Graceful fallback: use outcome field
    return {
      effective: entry.outcome === 'success',
      reason: 'fallback: claude unavailable',
      category: 'general',
      fallback: true,
      error: err.message
    }
  }
}

module.exports = { judge }
```

**Step 4: Run tests — verify pass**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/judge.test.js
```

Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add daemon/pipeline/judge.js tests/judge.test.js
git commit -m "feat(quoth-plugin): judge pipeline step with Haiku subagent"
```

---

## Task 4: Pipeline — distill.js

**Files:**
- Create: `Quoth/quoth-plugin/daemon/pipeline/distill.js`
- Create: `Quoth/quoth-plugin/tests/distill.test.js`

**Step 1: Write failing test**

```javascript
// Quoth/quoth-plugin/tests/distill.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execSync } from 'child_process'

vi.mock('child_process', () => ({ execSync: vi.fn() }))

const { distill } = require('../daemon/pipeline/distill.js')

beforeEach(() => vi.clearAllMocks())

describe('distill', () => {
  it('extracts a pattern from a successful entry', () => {
    execSync.mockReturnValue(JSON.stringify({
      pattern: 'Use :visible when multiple buttons match the same selector',
      tags: ['selector', 'playwright'],
      applicability: 'broad'
    }))
    const result = distill({ agent: 'test-healer', task: 'fix button selector',
      outcome: 'success', pattern_used: 'visibility-filter' })
    expect(result.pattern).toContain(':visible')
    expect(result.tags).toContain('selector')
    expect(result.applicability).toBe('broad')
  })

  it('generates a stable id from the pattern content', () => {
    execSync.mockReturnValue(JSON.stringify({
      pattern: 'Always use data-testid for stable selectors',
      tags: ['selector'], applicability: 'broad'
    }))
    const result = distill({ agent: 'test-healer', task: 'fix selector', outcome: 'success' })
    expect(result.id).toBeTruthy()
    expect(typeof result.id).toBe('string')
  })

  it('falls back gracefully on parse error', () => {
    execSync.mockReturnValue('unparseable output')
    const result = distill({ agent: 'test-healer', task: 'fix selector',
      outcome: 'success', pattern_used: 'some-pattern' })
    expect(result.fallback).toBe(true)
    expect(result.pattern).toBeTruthy() // uses pattern_used as fallback
  })
})
```

**Step 2: Run test — verify fails**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/distill.test.js
```

**Step 3: Implement distill.js**

```javascript
// Quoth/quoth-plugin/daemon/pipeline/distill.js
'use strict'

const { execSync } = require('child_process')
const crypto = require('crypto')

const DISTILL_PROMPT = `You are extracting a reusable pattern from a successful AI agent action.

Agent: {{agent}}
Task: {{task}}
Pattern that was used: {{pattern_used}}
Context: {{context}}

Extract ONE concise, generalizable pattern that other agents can reuse in similar situations.

Respond with ONLY valid JSON:
{"pattern": "clear description of the pattern", "tags": ["tag1","tag2"], "applicability": "broad|narrow"}`

function makeId(content) {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12)
}

function distill(entry) {
  const prompt = DISTILL_PROMPT
    .replace('{{agent}}', entry.agent || 'unknown')
    .replace('{{task}}', entry.task || 'unknown')
    .replace('{{pattern_used}}', entry.pattern_used || 'none')
    .replace('{{context}}', JSON.stringify({ attempts: entry.attempts, tool_calls: entry.tool_calls }))

  try {
    const raw = execSync(
      `echo ${JSON.stringify(prompt)} | claude -p --model claude-haiku-4-5-20251001 --output-format text`,
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON')

    const result = JSON.parse(jsonMatch[0])
    const id = makeId(result.pattern)
    return {
      id,
      pattern: result.pattern,
      tags: result.tags || [],
      applicability: result.applicability || 'narrow'
    }
  } catch (err) {
    // Fallback: use pattern_used as the pattern content
    const fallbackContent = entry.pattern_used || `${entry.agent}: ${entry.task}`
    return {
      id: makeId(fallbackContent),
      pattern: fallbackContent,
      tags: [],
      applicability: 'narrow',
      fallback: true,
      error: err.message
    }
  }
}

module.exports = { distill }
```

**Step 4: Run tests — verify pass**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/distill.test.js
```

**Step 5: Commit**

```bash
git add daemon/pipeline/distill.js tests/distill.test.js
git commit -m "feat(quoth-plugin): distill pipeline step extracts reusable patterns"
```

---

## Task 5: Pipeline — consolidate.js

**Files:**
- Create: `Quoth/quoth-plugin/daemon/pipeline/consolidate.js`
- Create: `Quoth/quoth-plugin/tests/consolidate.test.js`

**Step 1: Write failing test**

```javascript
// Quoth/quoth-plugin/tests/consolidate.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execSync } from 'child_process'

vi.mock('child_process', () => ({ execSync: vi.fn() }))

const { consolidate } = require('../daemon/pipeline/consolidate.js')

const existingPatterns = [
  { id: 'vis-1', name: 'visibility-filter', pattern_type: 'code-pattern',
    condition: 'multiple elements', action: 'use :visible', confidence: 0.7, tags: ['selector'] },
]

beforeEach(() => vi.clearAllMocks())

describe('consolidate', () => {
  it('returns "strengthen" when new pattern matches existing', () => {
    execSync.mockReturnValue(JSON.stringify({
      action: 'strengthen', targetId: 'vis-1',
      updated: { id: 'vis-1', action: 'use :visible filter for ambiguous selectors' }
    }))
    const result = consolidate(
      { id: 'new-1', pattern: 'use :visible for buttons', tags: ['selector'] },
      existingPatterns
    )
    expect(result.action).toBe('strengthen')
    expect(result.targetId).toBe('vis-1')
  })

  it('returns "new" when no similar pattern exists', () => {
    execSync.mockReturnValue(JSON.stringify({
      action: 'new',
      updated: { id: 'auth-1', pattern: 'use storageState for auth' }
    }))
    const result = consolidate(
      { id: 'auth-1', pattern: 'use storageState for auth', tags: ['auth'] },
      []
    )
    expect(result.action).toBe('new')
  })

  it('falls back to "new" on parse error', () => {
    execSync.mockReturnValue('garbage')
    const result = consolidate(
      { id: 'x', pattern: 'some pattern', tags: [] },
      existingPatterns
    )
    expect(result.action).toBe('new')
    expect(result.fallback).toBe(true)
  })
})
```

**Step 2: Run test — verify fails**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/consolidate.test.js
```

**Step 3: Implement consolidate.js**

```javascript
// Quoth/quoth-plugin/daemon/pipeline/consolidate.js
'use strict'

const { execSync } = require('child_process')

const CONSOLIDATE_PROMPT = `You are deciding how to add a new pattern to a knowledge base.

New pattern:
{{new_pattern}}

Existing similar patterns (top 3):
{{existing_patterns}}

Should you:
- "strengthen": merge into an existing pattern (it's essentially the same idea)
- "new": add as a distinct new pattern (it's genuinely different)

Respond with ONLY valid JSON:
{"action": "strengthen|new", "targetId": "id of target if strengthen, else null", "updated": {the final pattern object}}`

function consolidate(newPattern, existingPatterns) {
  const prompt = CONSOLIDATE_PROMPT
    .replace('{{new_pattern}}', JSON.stringify(newPattern))
    .replace('{{existing_patterns}}', JSON.stringify(existingPatterns.slice(0, 3)))

  try {
    const raw = execSync(
      `echo ${JSON.stringify(prompt)} | claude -p --model claude-haiku-4-5-20251001 --output-format text`,
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON')

    const result = JSON.parse(jsonMatch[0])
    return {
      action: result.action || 'new',
      targetId: result.targetId || null,
      updated: result.updated || newPattern
    }
  } catch (err) {
    return {
      action: 'new',
      targetId: null,
      updated: newPattern,
      fallback: true,
      error: err.message
    }
  }
}

module.exports = { consolidate }
```

**Step 4: Run tests — verify pass**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/consolidate.test.js
```

**Step 5: Commit**

```bash
git add daemon/pipeline/consolidate.js tests/consolidate.test.js
git commit -m "feat(quoth-plugin): consolidate pipeline step merges or creates patterns"
```

---

## Task 6: Daemon core (daemon.js)

**Files:**
- Create: `Quoth/quoth-plugin/daemon/daemon.js`

This is the always-on background process. No unit tests needed (it's an orchestrator); covered by integration test in Task 10.

**Step 1: Implement daemon.js**

```javascript
// Quoth/quoth-plugin/daemon/daemon.js
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const readline = require('readline')
const { createDb } = require('./db.js')
const { judge } = require('./pipeline/judge.js')
const { distill } = require('./pipeline/distill.js')
const { consolidate } = require('./pipeline/consolidate.js')

// --- Paths ---
const QUOTH_HOME = process.env.QUOTH_HOME || path.join(os.homedir(), '.quoth')
const TRAJECTORIES_DIR = path.join(QUOTH_HOME, 'trajectories')
const PID_FILE = path.join(QUOTH_HOME, 'daemon.pid')
const LOG_FILE = path.join(QUOTH_HOME, 'daemon.log')
const LOCK_FILE = path.join(QUOTH_HOME, 'processing.lock')
const DB_PATH = path.join(QUOTH_HOME, 'memory.db')

// --- Setup ---
;[QUOTH_HOME, TRAJECTORIES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
})

const db = createDb(DB_PATH)
const jobQueue = []
let isProcessing = false
let decayTimer = null
let deepConsolidateTimer = null

// --- Logging ---
function log(level, msg, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, data }) + '\n'
  try { fs.appendFileSync(LOG_FILE, line) } catch {}
  if (process.env.QUOTH_DEBUG) process.stderr.write(line)
}

// --- PID management ---
fs.writeFileSync(PID_FILE, String(process.pid))
process.on('exit', () => { try { fs.unlinkSync(PID_FILE) } catch {} })

// --- Graceful shutdown ---
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down')
  clearTimers()
  db.close()
  process.exit(0)
})

// --- Immediate flush on SIGUSR1 (sent by stop hook) ---
process.on('SIGUSR1', () => {
  log('info', 'SIGUSR1: flush triggered by session end')
  scanAndEnqueue()
  processQueue()
})

// --- Self-heal on crash ---
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { message: err.message, stack: err.stack })
  setTimeout(() => {
    log('info', 'Restarting after crash...')
    // Daemon restarts via session-start hook on next session
  }, 5000)
})

// --- File watcher: new trajectory files ---
function watchTrajectories() {
  fs.watch(TRAJECTORIES_DIR, { persistent: true }, (event, filename) => {
    if (filename && filename.endsWith('.jsonl')) {
      log('debug', 'New trajectory file detected', { filename })
      setTimeout(() => scanAndEnqueue(), 500) // small delay for write to complete
    }
  })
  log('info', 'Watching trajectories dir', { dir: TRAJECTORIES_DIR })
}

// --- Scan JSONL files for unprocessed entries ---
function scanAndEnqueue() {
  const files = fs.readdirSync(TRAJECTORIES_DIR).filter(f => f.endsWith('.jsonl'))
  for (const file of files) {
    const filePath = path.join(TRAJECTORIES_DIR, file)
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (!entry._processed) {
            jobQueue.push({ entry, filePath, line })
          }
        } catch {}
      }
    } catch (err) {
      log('error', 'Failed to read trajectory file', { file, error: err.message })
    }
  }
  if (jobQueue.length > 0) {
    log('info', `Enqueued ${jobQueue.length} trajectory entries`)
    processQueue()
  }
}

// --- Process queue with up to 5 parallel Haiku workers ---
async function processQueue() {
  if (isProcessing) return
  if (jobQueue.length === 0) return
  if (fs.existsSync(LOCK_FILE)) return

  fs.writeFileSync(LOCK_FILE, String(process.pid))
  isProcessing = true

  try {
    const CONCURRENCY = 5
    while (jobQueue.length > 0) {
      const batch = jobQueue.splice(0, CONCURRENCY)
      await Promise.all(batch.map(job => processEntry(job)))
    }
  } finally {
    isProcessing = false
    try { fs.unlinkSync(LOCK_FILE) } catch {}
  }
}

// --- Process a single trajectory entry through the pipeline ---
async function processEntry({ entry, filePath, line }) {
  try {
    log('debug', 'Processing entry', { agent: entry.agent, outcome: entry.outcome })

    // JUDGE
    const judgment = judge(entry)

    if (!judgment.effective) {
      // Anti-pattern: log but don't distill
      log('debug', 'Entry judged ineffective', { reason: judgment.reason })
      markProcessed(filePath, line)
      return
    }

    // DISTILL
    const distilled = distill(entry)

    // CONSOLIDATE: find similar existing patterns
    const similarPatterns = db.getTopPatterns(3,
      distilled.tags.length > 0 ? distilled.tags : ['general'])
    const consolidation = consolidate(distilled, similarPatterns)

    // Write to DB
    if (consolidation.action === 'strengthen' && consolidation.targetId) {
      db.applyConfidenceDelta(consolidation.targetId, 0.03)
      log('info', 'Strengthened pattern', { id: consolidation.targetId })
    } else {
      // New pattern — start at 0.5
      db.upsertPattern({
        id: distilled.id,
        name: distilled.pattern.slice(0, 60),
        pattern_type: 'code-pattern',
        condition: entry.task || 'agent task',
        action: distilled.pattern,
        confidence: 0.5,
        tags: distilled.tags,
        source: 'distilled'
      })
      log('info', 'New pattern created', { id: distilled.id, pattern: distilled.pattern.slice(0, 60) })
    }

    markProcessed(filePath, line)

    // Check promotion candidates
    const candidates = db.getPromotionCandidates()
    if (candidates.length > 0) {
      log('info', 'Promotion candidates ready', { count: candidates.length })
      // Candidates will be pushed to Quoth cloud during deep consolidation
    }

  } catch (err) {
    log('error', 'processEntry failed', { error: err.message, agent: entry.agent })
  }
}

// --- Mark a line as processed in the JSONL file ---
function markProcessed(filePath, originalLine) {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const updated = content.replace(
      originalLine,
      originalLine.replace(/\}$/, ',"_processed":true}')
    )
    fs.writeFileSync(filePath, updated)
  } catch {}
}

// --- Hourly confidence decay ---
function startDecayTimer() {
  decayTimer = setInterval(() => {
    try {
      db.applyHourlyDecay()
      db.archiveWeakPatterns()
      log('info', 'Hourly decay applied')
    } catch (err) {
      log('error', 'Decay failed', { error: err.message })
    }
  }, 60 * 60 * 1000) // 1 hour
}

// --- Daily deep consolidation at 3am ---
function scheduleDeepConsolidate() {
  const now = new Date()
  const next3am = new Date(now)
  next3am.setHours(3, 0, 0, 0)
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1)
  const msUntil3am = next3am - now

  deepConsolidateTimer = setTimeout(() => {
    runDeepConsolidate()
    setInterval(runDeepConsolidate, 24 * 60 * 60 * 1000) // daily thereafter
  }, msUntil3am)

  log('info', `Deep consolidation scheduled in ${Math.round(msUntil3am / 60000)} minutes`)
}

function runDeepConsolidate() {
  log('info', 'Starting deep consolidation (Sonnet)')
  try {
    const patterns = db.getTopPatterns(50)
    if (patterns.length === 0) return

    const prompt = `Review these patterns and identify any that should be merged (similarity > 0.85) or archived (irrelevant).
Patterns: ${JSON.stringify(patterns.slice(0, 20))}

Respond with ONLY JSON: {"merges": [{"keep": "id", "archive": "id", "reason": "..."}], "archives": ["id1", "id2"]}`

    const raw = require('child_process').execSync(
      `echo ${JSON.stringify(prompt)} | claude -p --model claude-sonnet-4-6 --output-format text`,
      { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0])
      // Archive merged duplicates
      for (const archive of (result.archives || [])) {
        db.prepare("UPDATE patterns SET status='archived' WHERE id=?").run(archive)
      }
      // Strengthen kept patterns from merges
      for (const merge of (result.merges || [])) {
        db.applyConfidenceDelta(merge.keep, 0.05) // boost for surviving merge
        db.prepare("UPDATE patterns SET status='archived' WHERE id=?").run(merge.archive)
      }
      log('info', 'Deep consolidation complete', {
        merged: (result.merges || []).length,
        archived: (result.archives || []).length
      })
    }
  } catch (err) {
    log('error', 'Deep consolidation failed', { error: err.message })
  }
}

function clearTimers() {
  if (decayTimer) clearInterval(decayTimer)
  if (deepConsolidateTimer) clearTimeout(deepConsolidateTimer)
}

// --- Start ---
log('info', 'Quoth daemon started', { pid: process.pid, home: QUOTH_HOME })
watchTrajectories()
startDecayTimer()
scheduleDeepConsolidate()
scanAndEnqueue() // process any leftover entries from previous session
```

**Step 2: Verify daemon starts without error**

```bash
cd Quoth/quoth-plugin && QUOTH_DEBUG=true QUOTH_HOME=/tmp/quoth-test timeout 3 node daemon/daemon.js || true
```

Expected: Prints startup log line, exits after 3s timeout (that's fine — it's a persistent process).

**Step 3: Commit**

```bash
git add daemon/daemon.js
git commit -m "feat(quoth-plugin): autonomous daemon with file watcher and job queue"
```

---

## Task 7: Local MCP server (quoth-learning-server.js)

**Files:**
- Create: `Quoth/quoth-plugin/mcp/quoth-learning-server.js`

Follows the exact same pattern as `Triqual/triqual-plugin/mcp/triqual-context-server.js`.

**Step 1: Implement MCP server**

```javascript
// Quoth/quoth-plugin/mcp/quoth-learning-server.js
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const readline = require('readline')
const { execSync } = require('child_process')

const JSONRPC_VERSION = '2.0'
const MCP_PROTOCOL_VERSION = '2024-11-05'
const QUOTH_HOME = process.env.QUOTH_HOME || path.join(os.homedir(), '.quoth')
const DB_PATH = path.join(QUOTH_HOME, 'memory.db')
const TRAJECTORIES_DIR = path.join(QUOTH_HOME, 'trajectories')

// Lazy-load db (only if needed, avoids startup failure if better-sqlite3 not installed)
let _db = null
function getDb() {
  if (_db) return _db
  const { createDb } = require(path.join(__dirname, '../daemon/db.js'))
  _db = createDb(DB_PATH)
  return _db
}

const TOOLS = [
  {
    name: 'quoth_log_outcome',
    description: 'Record the outcome of using a pattern (success/failure). Feeds confidence scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        patternId: { type: 'string', description: 'Pattern ID that was used' },
        result: { type: 'string', enum: ['success', 'failure'], description: 'Outcome' },
        context: { type: 'string', description: 'Optional context about the use' }
      },
      required: ['patternId', 'result']
    }
  },
  {
    name: 'quoth_score_pattern',
    description: 'Manually adjust a pattern confidence score',
    inputSchema: {
      type: 'object',
      properties: {
        patternId: { type: 'string' },
        delta: { type: 'number', description: 'Confidence delta (+0.03 for success, -0.03 for failure)' }
      },
      required: ['patternId', 'delta']
    }
  },
  {
    name: 'quoth_top_patterns',
    description: 'Get top-N patterns by confidence score, optionally filtered by tags',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 5 },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' }
      }
    }
  },
  {
    name: 'quoth_seed_from_exolar',
    description: 'Import Exolar clustered failures as pattern candidates',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', default: 'clustered_failures' },
        projectId: { type: 'string' }
      }
    }
  },
  {
    name: 'quoth_daemon_status',
    description: 'Check if the Quoth learning daemon is running',
    inputSchema: { type: 'object', properties: {} }
  }
]

function handleTool(name, args) {
  const db = getDb()
  switch (name) {
    case 'quoth_log_outcome': {
      const delta = args.result === 'success' ? 0.03 : -0.03
      db.applyConfidenceDelta(args.patternId, delta)
      return { logged: true, patternId: args.patternId, delta }
    }
    case 'quoth_score_pattern': {
      db.applyConfidenceDelta(args.patternId, args.delta)
      const p = db.getPattern(args.patternId)
      return { updated: true, pattern: p }
    }
    case 'quoth_top_patterns': {
      const patterns = db.getTopPatterns(args.limit || 5, args.tags || [])
      return { patterns }
    }
    case 'quoth_seed_from_exolar': {
      // Spawn a headless claude subprocess that queries Exolar and seeds patterns
      const sessionId = `exolar-seed-${Date.now()}`
      const trajFile = path.join(TRAJECTORIES_DIR, `${sessionId}.jsonl`)
      const prompt = `Query Exolar for clustered failures (dataset: clustered_failures${args.projectId ? `, project: ${args.projectId}` : ''}).
For each cluster, write a JSON line to: ${trajFile}
Format: {"event":"exolar_seed","session":"${sessionId}","task":"<cluster description>","outcome":"failure","pattern_used":"<error type>","agent":"exolar-importer"}
One line per cluster. Use the mcp__plugin_triqual-plugin_exolar-qa__query_exolar_data tool.`
      try {
        execSync(
          `echo ${JSON.stringify(prompt)} | claude -p --model claude-haiku-4-5-20251001 --output-format text`,
          { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'ignore'], detached: false }
        )
        return { seeded: true, trajectoryFile: trajFile }
      } catch (err) {
        return { seeded: false, error: err.message }
      }
    }
    case 'quoth_daemon_status': {
      const pidFile = path.join(QUOTH_HOME, 'daemon.pid')
      if (!fs.existsSync(pidFile)) return { running: false }
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim())
      try {
        process.kill(pid, 0) // signal 0 = check existence
        const logFile = path.join(QUOTH_HOME, 'daemon.log')
        const lastLog = fs.existsSync(logFile)
          ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-3).join('\n')
          : 'no log'
        return { running: true, pid, lastLog }
      } catch {
        return { running: false, stalePid: pid }
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// --- MCP stdio protocol ---
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }

  if (msg.method === 'initialize') {
    send({ jsonrpc: JSONRPC_VERSION, id: msg.id, result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'quoth-learning', version: '1.0.0' }
    }})
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: JSONRPC_VERSION, id: msg.id, result: { tools: TOOLS } })
  } else if (msg.method === 'tools/call') {
    try {
      const result = handleTool(msg.params.name, msg.params.arguments || {})
      send({ jsonrpc: JSONRPC_VERSION, id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      }})
    } catch (err) {
      send({ jsonrpc: JSONRPC_VERSION, id: msg.id, error: { code: -32603, message: err.message } })
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} })
  }
})
```

**Step 2: Verify MCP server responds to initialize**

```bash
cd Quoth/quoth-plugin && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp/quoth-learning-server.js
```

Expected: JSON response with `serverInfo.name: "quoth-learning"`.

**Step 3: Commit**

```bash
git add mcp/quoth-learning-server.js
git commit -m "feat(quoth-plugin): local MCP server with 5 learning tools"
```

---

## Task 8: Hooks — common.sh + session-start.sh

**Files:**
- Create: `Quoth/quoth-plugin/hooks/lib/common.sh`
- Create: `Quoth/quoth-plugin/hooks/session-start.sh`

**Step 1: Create common.sh**

```bash
#!/usr/bin/env bash
# Quoth Plugin - Shared hook utilities

QUOTH_HOME="${HOME}/.quoth"
QUOTH_TRAJECTORIES="${QUOTH_HOME}/trajectories"
QUOTH_DAEMON_PID="${QUOTH_HOME}/daemon.pid"
QUOTH_DAEMON_LOG="${QUOTH_HOME}/daemon.log"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Ensure quoth home exists
mkdir -p "${QUOTH_HOME}" "${QUOTH_TRAJECTORIES}"

log_debug() {
  if [ "${QUOTH_DEBUG:-}" = "true" ]; then
    echo "[quoth-debug] $1" >&2
  fi
}

# Read stdin (Claude Code sends hook input via stdin)
_HOOK_INPUT=""
read_hook_input() {
  _HOOK_INPUT=$(cat)
  return 0
}

output_system_message() {
  local msg="$1"
  printf '%s' "$msg"
}

output_empty() {
  return 0
}

# Append one JSON line to the current session's trajectory file
# Usage: append_trajectory '{"event":"agent_stop","agent":"test-healer",...}'
append_trajectory() {
  local entry="$1"
  local session_id="${QUOTH_SESSION_ID:-unknown}"
  local traj_file="${QUOTH_TRAJECTORIES}/${session_id}.jsonl"
  echo "${entry}" >> "${traj_file}" 2>/dev/null || true
}

# Get or create session ID (persisted for the session)
get_or_create_session_id() {
  local id_file="${QUOTH_HOME}/current_session"
  if [ -f "${id_file}" ]; then
    cat "${id_file}"
  else
    local new_id
    new_id="session-$(date +%s)-$$"
    echo "${new_id}" > "${id_file}"
    echo "${new_id}"
  fi
}

clear_session_id() {
  rm -f "${QUOTH_HOME}/current_session"
}

# Check if daemon is running
daemon_is_running() {
  if [ ! -f "${QUOTH_DAEMON_PID}" ]; then
    return 1
  fi
  local pid
  pid=$(cat "${QUOTH_DAEMON_PID}" 2>/dev/null)
  [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null
}

# Start daemon as detached background process
start_daemon() {
  local daemon_js="${PLUGIN_ROOT}/daemon/daemon.js"
  if [ ! -f "${daemon_js}" ]; then
    log_debug "daemon.js not found at ${daemon_js}"
    return 1
  fi
  QUOTH_HOME="${QUOTH_HOME}" nohup node "${daemon_js}" \
    >> "${QUOTH_DAEMON_LOG}" 2>&1 &
  echo $! > "${QUOTH_DAEMON_PID}"
  log_debug "Daemon started with PID $!"
}

# Call quoth-learning MCP tool (fire-and-forget)
call_learning_tool() {
  local tool_name="$1"
  local args_json="$2"
  # Fire and forget — never wait, never fail Claude
  (claude mcp call quoth-learning "${tool_name}" "${args_json}" \
    >> "${QUOTH_HOME}/mcp-calls.log" 2>&1) &
}

# Send SIGUSR1 to daemon for immediate processing
signal_daemon_flush() {
  if daemon_is_running; then
    local pid
    pid=$(cat "${QUOTH_DAEMON_PID}")
    kill -USR1 "${pid}" 2>/dev/null || true
    log_debug "Sent SIGUSR1 to daemon PID ${pid}"
  fi
}

# Get top patterns as context string (for injection)
get_top_patterns_context() {
  local limit="${1:-5}"
  local result
  result=$(claude mcp call quoth-learning quoth_top_patterns \
    "{\"limit\":${limit}}" 2>/dev/null) || true
  echo "${result}"
}
```

**Step 2: Create session-start.sh**

```bash
#!/usr/bin/env bash
# Quoth Plugin - SessionStart Hook
# Ensures daemon is running; injects top patterns into context

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
  read_hook_input || true

  # Ensure daemon is running (start if dead/missing)
  if ! daemon_is_running; then
    log_debug "Daemon not running, starting..."
    start_daemon
    sleep 0.5  # brief wait for PID file to be written
  fi

  # Create/restore session ID
  local session_id
  session_id=$(get_or_create_session_id)
  export QUOTH_SESSION_ID="${session_id}"
  log_debug "Session: ${session_id}"

  # Get top patterns for context injection (non-blocking — if it fails, we just skip)
  local patterns_context=""
  if daemon_is_running; then
    patterns_context=$(get_top_patterns_context 5 2>/dev/null) || true
  fi

  # Build context message
  local message="[Quoth] Learning daemon active."
  if [ -n "${patterns_context}" ]; then
    message="${message}

Top learned patterns available:
${patterns_context}"
  fi

  output_system_message "${message}"
}

main "$@"
exit 0  # ALWAYS exit 0
```

**Step 3: Make hooks executable**

```bash
chmod +x Quoth/quoth-plugin/hooks/lib/common.sh Quoth/quoth-plugin/hooks/session-start.sh
```

**Step 4: Test session-start manually**

```bash
cd Quoth && echo '{"type":"SessionStart"}' | QUOTH_DEBUG=true CLAUDE_PLUGIN_ROOT=quoth-plugin \
  bash quoth-plugin/hooks/session-start.sh
```

Expected: Prints `[Quoth] Learning daemon active.` — exits 0.

**Step 5: Commit**

```bash
git add quoth-plugin/hooks/
git commit -m "feat(quoth-plugin): session-start hook resurrects daemon and injects patterns"
```

---

## Task 9: Hooks — subagent-start.sh + subagent-stop.sh

**Files:**
- Create: `Quoth/quoth-plugin/hooks/subagent-start.sh`
- Create: `Quoth/quoth-plugin/hooks/subagent-stop.sh`

**Step 1: Create subagent-start.sh**

```bash
#!/usr/bin/env bash
# Quoth Plugin - SubagentStart Hook
# Injects top relevant patterns into the agent's starting context

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
  read_hook_input || true

  # Extract agent name from hook input
  local agent_name=""
  if command -v jq >/dev/null 2>&1; then
    agent_name=$(echo "${_HOOK_INPUT}" | jq -r '.agent_name // .agentName // ""' 2>/dev/null || echo "")
  fi

  # Get top patterns — fire off silently, inject if available
  local patterns=""
  patterns=$(claude mcp call quoth-learning quoth_top_patterns '{"limit":3}' 2>/dev/null) || true

  if [ -n "${patterns}" ] && [ "${patterns}" != "null" ]; then
    output_system_message "[Quoth] Learned patterns for this task:
${patterns}

Apply these patterns where relevant."
  else
    output_empty
  fi
}

main "$@"
exit 0  # ALWAYS exit 0
```

**Step 2: Create subagent-stop.sh**

```bash
#!/usr/bin/env bash
# Quoth Plugin - SubagentStop Hook
# Logs agent outcome to trajectory JSONL (fire-and-forget)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
  read_hook_input || true

  local input="${_HOOK_INPUT}"
  local session_id
  session_id=$(get_or_create_session_id)

  # Extract fields from hook input
  local agent_name=""
  local outcome=""
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  if command -v jq >/dev/null 2>&1; then
    agent_name=$(echo "${input}" | jq -r '.agent_name // .agentName // "unknown"' 2>/dev/null || echo "unknown")
    outcome=$(echo "${input}" | jq -r '.outcome // "unknown"' 2>/dev/null || echo "unknown")
  fi

  # Build trajectory entry
  local project_dir="${PWD}"
  local entry
  entry=$(printf '{"ts":"%s","session":"%s","event":"agent_stop","agent":"%s","outcome":"%s","project":"%s"}' \
    "${ts}" "${session_id}" "${agent_name}" "${outcome}" "${project_dir}")

  # Append to trajectory file (non-blocking)
  append_trajectory "${entry}"
  log_debug "Logged trajectory: ${entry}"

  output_empty
}

main "$@"
exit 0  # ALWAYS exit 0
```

**Step 3: Make executable + commit**

```bash
chmod +x Quoth/quoth-plugin/hooks/subagent-start.sh Quoth/quoth-plugin/hooks/subagent-stop.sh
git add quoth-plugin/hooks/subagent-start.sh quoth-plugin/hooks/subagent-stop.sh
git commit -m "feat(quoth-plugin): subagent hooks for pattern injection and trajectory logging"
```

---

## Task 10: Hooks — stop.sh + hooks.json

**Files:**
- Create: `Quoth/quoth-plugin/hooks/stop.sh`
- Create: `Quoth/quoth-plugin/hooks/hooks.json`

**Step 1: Create stop.sh**

```bash
#!/usr/bin/env bash
# Quoth Plugin - Stop Hook
# Signals daemon to process queued trajectories; clears session ID

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
  read_hook_input || true

  # Signal daemon for immediate processing (non-blocking)
  signal_daemon_flush

  # Clear session ID so next session gets a fresh one
  clear_session_id

  log_debug "Session ended, daemon signaled"
  output_empty
}

main "$@"
exit 0  # ALWAYS exit 0
```

**Step 2: Create hooks.json**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" }]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start.sh" }]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-stop.sh" }]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh" }]
      }
    ]
  }
}
```

**Step 3: Make executable + commit**

```bash
chmod +x Quoth/quoth-plugin/hooks/stop.sh
git add quoth-plugin/hooks/stop.sh quoth-plugin/hooks/hooks.json
git commit -m "feat(quoth-plugin): stop hook and hooks.json registration"
```

---

## Task 11: .mcp.json + plugin manifest

**Files:**
- Create: `Quoth/quoth-plugin/.mcp.json`
- Modify: `Quoth/.mcp.json` (add quoth-learning server)

**Step 1: Create quoth-plugin/.mcp.json**

```json
{
  "mcpServers": {
    "quoth": {
      "type": "http",
      "url": "https://quoth.triqual.dev/api/mcp/sse"
    },
    "quoth-learning": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/quoth-learning-server.js"],
      "type": "stdio"
    }
  }
}
```

**Step 2: Read Quoth's existing .mcp.json**

```bash
cat Quoth/.mcp.json
```

**Step 3: Update Quoth/.mcp.json to add quoth-learning**

Add the `quoth-learning` entry to Quoth's root `.mcp.json` so it's available in all Quoth sessions (without the plugin, for developers working directly in Quoth):

```json
{
  "mcpServers": {
    "quoth-learning": {
      "command": "node",
      "args": ["quoth-plugin/mcp/quoth-learning-server.js"],
      "type": "stdio"
    }
  }
}
```

(Merge with existing entries rather than replacing them.)

**Step 4: Commit**

```bash
git add quoth-plugin/.mcp.json Quoth/.mcp.json
git commit -m "feat(quoth-plugin): register quoth-learning MCP server"
```

---

## Task 12: Skills — /patterns and /learn

**Files:**
- Create: `Quoth/quoth-plugin/skills/patterns/SKILL.md`
- Create: `Quoth/quoth-plugin/skills/learn/SKILL.md`

**Step 1: Create patterns/SKILL.md**

```markdown
---
name: patterns
description: Browse the Quoth confidence-scored pattern library. Use when asked to show learned patterns, check pattern confidence, or find patterns for a task.
---

# Quoth Pattern Library

Show the user the current confidence-scored pattern library.

1. Call `quoth_top_patterns({ limit: 20 })` via the quoth-learning MCP tool
2. Present patterns sorted by confidence with their scores, tags, and use counts
3. Highlight patterns with confidence > 0.8 (promotion candidates)
4. Highlight patterns with confidence < 0.2 (candidates for archival)

Format:
| Pattern | Confidence | Uses | Tags |
|---------|------------|------|------|
| ... | 0.84 | 47 | selector, playwright |

Then offer: "Run `/learn` to trigger manual consolidation"
```

**Step 2: Create learn/SKILL.md**

```markdown
---
name: learn
description: Trigger immediate pattern consolidation from recent trajectories. Use when asked to run learning, consolidate patterns, or process recent agent logs.
---

# Quoth Manual Consolidation

Trigger immediate processing of any queued trajectory entries.

1. Check daemon status: `quoth_daemon_status({})`
   - If not running: inform user and suggest restarting Claude Code session
   - If running: proceed

2. Signal daemon by sending SIGUSR1:
   ```bash
   pid=$(cat ~/.quoth/daemon.pid)
   kill -USR1 $pid
   ```

3. Wait 5 seconds, then show updated pattern library via `quoth_top_patterns({ limit: 10 })`

4. Report: how many patterns were updated, any new patterns added, any patterns archived
```

**Step 3: Commit**

```bash
git add quoth-plugin/skills/
git commit -m "feat(quoth-plugin): /patterns and /learn skills"
```

---

## Task 13: Triqual hook extensions

**Files:**
- Modify: `Triqual/triqual-plugin/hooks/post-test-run.sh`
- Modify: `Triqual/triqual-plugin/hooks/stop.sh`

**Step 1: Read current post-test-run.sh (already done — we have the content)**

The file currently calls `output_context "$context" "PostToolUse"` at the end. We need to add a fire-and-forget call before that.

**Step 2: Add quoth_log_outcome call to post-test-run.sh**

Find this block near line 141 (just before `output_context`):

```bash
    output_context "$context" "PostToolUse"
```

Insert before it:

```bash
    # Quoth learning: log outcome for pattern scoring (fire-and-forget)
    if [ -n "$feature" ]; then
        local pattern_id=""
        # Try to extract pattern_used from run log
        if run_log_exists "$feature"; then
            pattern_id=$(grep -oE '"pattern_used":"[^"]+"' "$(get_run_log_path "$feature")" | tail -1 | cut -d'"' -f4 || echo "")
        fi
        if [ -n "$pattern_id" ]; then
            local outcome_val="failure"
            [ "$has_failures" = "false" ] && outcome_val="success"
            (claude mcp call quoth-learning quoth_log_outcome \
                "{\"patternId\":\"${pattern_id}\",\"result\":\"${outcome_val}\"}" \
                >> "${HOME}/.quoth/mcp-calls.log" 2>&1) &
        fi
    fi
```

**Step 3: Add quoth_seed_from_exolar call to stop.sh**

Find this block near the end of stop.sh (just before `cleanup_session`):

```bash
    # Cleanup session state (but keep run logs - they're persistent)
    cleanup_session
```

Insert before it:

```bash
    # Quoth learning: seed patterns from Exolar failure clusters (fire-and-forget)
    local project_id=""
    if [ -n "$config_path" ]; then
        project_id=$(get_config_value "project_id" "$config_path" 2>/dev/null || echo "")
    fi
    (claude mcp call quoth-learning quoth_seed_from_exolar \
        "{\"dataset\":\"clustered_failures\"${project_id:+,\"projectId\":\"${project_id}\"}}" \
        >> "${HOME}/.quoth/mcp-calls.log" 2>&1) &

    # Signal quoth daemon for immediate processing
    local quoth_pid_file="${HOME}/.quoth/daemon.pid"
    if [ -f "${quoth_pid_file}" ]; then
        local quoth_pid
        quoth_pid=$(cat "${quoth_pid_file}" 2>/dev/null)
        [ -n "${quoth_pid}" ] && kill -USR1 "${quoth_pid}" 2>/dev/null || true
    fi
```

**Step 4: Verify hooks still exit 0 on all paths**

```bash
cd Triqual && echo '{"type":"Stop"}' | bash triqual-plugin/hooks/stop.sh; echo "Exit: $?"
```

Expected: `Exit: 0`

**Step 5: Commit**

```bash
cd Triqual && git add triqual-plugin/hooks/post-test-run.sh triqual-plugin/hooks/stop.sh
git commit -m "feat(triqual): add quoth learning feedback hooks (fire-and-forget)"
```

---

## Task 14: Integration test

**Files:**
- Create: `Quoth/quoth-plugin/tests/integration.test.js`

**Step 1: Write integration test**

```javascript
// Quoth/quoth-plugin/tests/integration.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync, spawn } from 'child_process'

let tmpDir, dbPath

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quoth-integration-'))
  dbPath = join(tmpDir, 'memory.db')
  process.env.QUOTH_HOME = tmpDir
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true })
  delete process.env.QUOTH_HOME
})

describe('integration: db + pipeline', () => {
  it('creates db and writes a pattern via upsert', () => {
    const { createDb } = require('../daemon/db.js')
    const db = createDb(dbPath)
    db.upsertPattern({
      id: 'integ-1', name: 'test pattern', pattern_type: 'code-pattern',
      condition: 'test', action: 'do something', confidence: 0.6,
      tags: ['test'], source: 'distilled'
    })
    const p = db.getPattern('integ-1')
    expect(p).not.toBeNull()
    expect(p.confidence).toBeCloseTo(0.6)
    db.close()
  })

  it('MCP server responds to tools/list', () => {
    const result = execSync(
      `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | QUOTH_HOME=${tmpDir} node ${join(__dirname, '../mcp/quoth-learning-server.js')}`,
      { encoding: 'utf8', timeout: 5000 }
    )
    const parsed = JSON.parse(result.trim())
    const toolNames = parsed.result.tools.map(t => t.name)
    expect(toolNames).toContain('quoth_log_outcome')
    expect(toolNames).toContain('quoth_top_patterns')
    expect(toolNames).toContain('quoth_daemon_status')
  })

  it('quoth_daemon_status returns running:false when no daemon', () => {
    const input = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quoth_daemon_status', arguments: {} } }
    ].map(m => JSON.stringify(m)).join('\n'))

    const result = execSync(
      `printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quoth_daemon_status","arguments":{}}}' | QUOTH_HOME=${tmpDir} node ${join(__dirname, '../mcp/quoth-learning-server.js')}`,
      { encoding: 'utf8', timeout: 5000 }
    )
    const lines = result.trim().split('\n').map(l => JSON.parse(l))
    const callResult = lines.find(l => l.id === 2)
    const content = JSON.parse(callResult.result.content[0].text)
    expect(content.running).toBe(false)
  })
})
```

**Step 2: Run integration tests**

```bash
cd Quoth/quoth-plugin && npx vitest run tests/integration.test.js
```

Expected: All 3 tests PASS.

**Step 3: Run full test suite**

```bash
cd Quoth/quoth-plugin && npx vitest run
```

Expected: All tests PASS.

**Step 4: Commit**

```bash
git add tests/integration.test.js
git commit -m "test(quoth-plugin): integration tests for db, MCP server, and daemon status"
```

---

## Task 15: Update CLAUDE.md files

**Files:**
- Modify: `Quoth/CLAUDE.md` — add quoth-plugin section
- Modify: `Triqual/CLAUDE.md` — update MCP server list

**Step 1: Add to Quoth/CLAUDE.md**

Add a new section after the existing content:

```markdown
## Quoth Plugin (Self-Learning)

Located at `quoth-plugin/`. A standalone Claude Code plugin that provides autonomous self-learning.

### What It Does
- Logs all agent trajectories to `~/.quoth/trajectories/{session}.jsonl`
- Background daemon processes trajectories using Haiku subagents (JUDGE → DISTILL → CONSOLIDATE)
- Maintains confidence-scored pattern library in `~/.quoth/memory.db`
- Injects top patterns into every agent's context at session start

### Daemon
- Auto-starts via `session-start` hook
- PID: `~/.quoth/daemon.pid`, Log: `~/.quoth/daemon.log`
- Debug: `QUOTH_DEBUG=true`

### New MCP Tools (quoth-learning)
- `quoth_log_outcome` — record pattern success/failure
- `quoth_top_patterns` — get top-N scored patterns
- `quoth_daemon_status` — check daemon health

### Skills
- `/patterns` — browse confidence-scored pattern library
- `/learn` — trigger manual consolidation
```

**Step 2: Update Triqual/CLAUDE.md MCP server table**

Find the MCP servers table and add the new entry:

```markdown
| `quoth-learning` | `~/.quoth/daemon.js` (local stdio) | Pattern scoring and outcome logging |
```

**Step 3: Commit**

```bash
git add Quoth/CLAUDE.md Triqual/CLAUDE.md
git commit -m "docs: update CLAUDE.md files with quoth-plugin documentation"
```

---

## Complete

All 5 deliverables implemented:

| Deliverable | Location | Status |
|-------------|----------|--------|
| quoth-plugin structure | `Quoth/quoth-plugin/` | ✅ Tasks 1–2 |
| Daemon + pipeline | `Quoth/quoth-plugin/daemon/` | ✅ Tasks 3–6 |
| Local MCP server | `Quoth/quoth-plugin/mcp/` | ✅ Task 7 |
| Hooks (4 hooks) | `Quoth/quoth-plugin/hooks/` | ✅ Tasks 8–10 |
| .mcp.json + manifest | `Quoth/quoth-plugin/` | ✅ Task 11 |
| Skills | `Quoth/quoth-plugin/skills/` | ✅ Task 12 |
| Triqual extensions | `Triqual/triqual-plugin/hooks/` | ✅ Task 13 |
| Tests | `Quoth/quoth-plugin/tests/` | ✅ Tasks 2–5, 14 |
| Docs | `CLAUDE.md` files | ✅ Task 15 |
