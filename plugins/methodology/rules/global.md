## Discovering Project Documentation

### Priority Order

1. **Project-specific CLAUDE.md** / `.claude/CLAUDE.md` / `.claude_instructions.md`
2. **Local /docs/** or `/documentation/`
3. **README.md** and inline code comments

Also read `CLAUDE.local.md` for developer-specific overrides.

---

## Universal Development Rules

### Never Assume - Always Verify

- "This probably uses Supabase" -> Check project docs/code
- "The API is probably at /api/" -> Search for actual endpoints
- "Tests probably use Jest" -> Verify test framework in package.json

**Rule:** Confirm instead of saying "probably". Verify by reading files, not guessing.

### No Hardcoded Values

- **Timeouts:** `await page.waitFor({ timeout: 5000 })` - Use config
- **URLs:** `const API_URL = "https://api.example.com"` - Use env vars
- **Credentials:** `const TOKEN = "sk-123..."` - Use env vars

Use constants, environment variables, or config files.
Use `VERCEL_TOKEN` environment variable for Vercel CLI (never hardcode tokens).

### UI: shadcn/ui + shadcnblocks Pro

Any UI you design or implement starts from shadcn/ui and shadcnblocks Pro blocks
(the account has Pro) before hand-writing components: search and inspect them with
the `shadcn` MCP, then install with the command it returns. The MCP needs a
`components.json` in the project.

- Registry URL in `components.json`: `https://www.shadcnblocks.com/r/{name}`, with
  `www`. The bare domain answers 308 and Node drops the Authorization header on that
  redirect: pro blocks fail with "Authentication failed" while free ones still
  install, which hides the bug.
- The key lives only in `~/.config/shadcn/auth.env` (read by the MCP wrapper). If a
  project's CLI needs it, reference `SHADCNBLOCKS_API_KEY` from the environment; don't
  copy the key into repos.

### Language

- Artifacts are in English: skills, specs, plans, ledgers, code, commits, and
  progress entries.
- Conversation mirrors the language of the user's message; a mixed message uses the
  dominant language.
- Prompts may be in Spanish or English; tooling must treat both equally.

### Feature Flags in Vercel Apps

New features in Vercel apps ship behind Flags SDK flags (`flags/next` or
`flags/sveltekit` with `vercelAdapter`, set up per the `vercel:flags-sdk` skill).
A/B comparisons run as flag variants.

### Multi-Agent Coordination

Delegate when the work splits into independent pieces that would otherwise flood this
session's context (multi-component reviews, parallel implementation of separate tasks);
do small or tightly coupled work directly. Launch independent agents in one message.

Subagents don't see each other's work, so give every agent working on the same initiative
the same context document, with the exact field names, paths and data they share.

### Multi-Agent Roles: Model and Effort

Agent definitions ship in the `roles` plugin. Dispatch by `subagent_type` in the Agent
tool or `agentType` in Workflow scripts, using `roles:<name>`; the definition carries
the model. Pass `effort` explicitly in Workflow `agent()` calls (the Agent tool has no
effort parameter). Coordination and rulings stay with the session model.

| Role | Agent type | Model | Effort | Dispatched by | Why |
|---|---|---|---|---|---|
| Briefs from plan + code | `roles:brief-writer` | sonnet | medium | `methodology:executing-plans`, on demand (plan text lacks interfaces from current code) | read and summarize, no design |
| TDD implementation | `roles:tdd-implementer` | sonnet | high | `methodology:executing-plans` (the task's `**Role:**`) | code and tests that must fail for the right reason |
| Complex implementation | `roles:complex-implementer` | opus | medium | `methodology:executing-plans` (a task whose `**Role:**` is `roles:complex-implementer`, and its fix rounds) | multi-system or live-state work where a mistake is costly |
| Style / canaries / commits (safety) | `roles:safety-reviewer` | sonnet | medium | `methodology:executing-plans` | a mechanical checklist, no judgment |
| Spec compliance and test honesty | `roles:spec-reviewer` | opus | medium | `methodology:executing-plans`, `methodology:reviewing-code` | judgment and branch tracing |
| Review-round fixer | `roles:review-fixer` | sonnet | high | `methodology:executing-plans` (fix rounds) | must refute the reviewer when warranted |
| Final adversarial whole-branch review | `roles:final-adversarial-reviewer` | opus | low | `methodology:executing-plans`, `methodology:brainstorming` (spec audit), `methodology:writing-plans` (plan audit) | one pass, the most valuable one |
| Candidate findings (hunter) | `roles:hunter` | claude-haiku-5-5 | medium | `methodology:executing-plans`, `methodology:reviewing-code` | cheap candidates, every one verified by the Opus spec reviewer (by the Opus final reviewer in the phase review) |
| Run one plan phase | `roles:phase-orchestrator` | sonnet | medium | `methodology:executing-plans` (one per phase, from methodology 1.3.0) | follows the phase's task loop, dispatches the other roles, never edits product code; the only role that may dispatch |
| Coordination and decisions | (session) | session model | — | — | never delegated |

Methodology's skills dispatch `roles:*` and pass no model: the role's definition carries it.
Do not use `general-purpose` for these roles; pick the matching agent type above.

### Workflow Fan-out Caps

A `PreToolUse(Workflow)` hook, shipped in the `workflow-gate` plugin, caps the
agents a workflow script launches **per model**: Fable 3, Opus 8, Sonnet 12,
Haiku unlimited (env `WORKFLOW_MAX_FABLE` / `_OPUS` / `_SONNET` override). It
exists because one uncapped `findings × 3 refuters` stage spawned 92 Fable
agents and burned the session limit. The "Dynamic workflow size" setting is
advisory only; this is the enforcement. A denial lists every problem with its
fix; apply them and call Workflow again.

- **Name the model.** Every `agent()` call sets `agentType:` (a `roles:*`
  agent from the table above) or an explicit string `model:`. Nothing
  inherits the session model by omission; the session model is only for coordination.
- **Declare the budget per model.** `// MAX_AGENTS: fable=0 opus=2 sonnet=4`,
  counting every agent each model launches, including inside
  `parallel`/`pipeline`/loops (the hook only checks one per `agent()` call
  site, so the true count is yours to get right). Haiku needs no entry.
- **Bound non-Haiku fan-outs.** `pipeline(x, …)`, `parallel(x)` and `.map(`
  over a dynamic list that launch Fable/Opus/Sonnet agents must be capped
  with `.slice(0, N)` in the same chain. Literal arrays, Haiku-only fan-outs
  and `Array.from({length: 3})` (a number literal) as the list of
  `pipeline`/`parallel` pass; `Array.from(…).map(` does not.

The same plugin also checks the `Agent` tool (`PreToolUse` on `Agent|Task`), which
dispatches the role agents: a start is denied when the session already started that
many agents of the same model within 120 s (`WORKFLOW_GATE_AGENT_WINDOW_S`), with the
same caps. A `model` input wins over the role's model, Haiku is never denied, and starts
whose model cannot be resolved are counted apart, capped at the Opus cap. The denial names the wait:
start fewer at once, use a cheaper model, or retry.

Not checked by the hook, but same reason: run one Workflow at a time and read its
result before launching the next.

### Git Best Practices

- Use absolute paths in shell commands instead of changing directory
- Ask before pushing to remote (don't push automatically) — **unless the
  project's own CLAUDE.md or skills define a push workflow** (e.g. a PR
  convergence loop with gates); follow the project's workflow in that case
- Verify deployment status before validating
- Use conventional commits with ticket references

### Code Quality Rules

- Run `typecheck`, `lint`, and tests freely to verify your work (encouraged after changes)
- Don't ship constant conditions (`if (true)`, hardcoded flags) in place of real logic
- Read each background agent's result when it arrives and adjust the plan from it
- **Never** run commands that could close the code editor (no kill commands)

---

## Instruction Hierarchy

**Global (this managed section):** universal development rules, multi-agent coordination,
git and deployment patterns.

**Project-specific (CLAUDE.md / CLAUDE.local.md in each repo):** technology and
framework conventions, testing strategies, domain logic.

**When in doubt:** Check project-specific instructions, then ask the user.
