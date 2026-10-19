# workflow-gate

Two `PreToolUse` hooks. The first is on the `Workflow` tool: it reads the script a Workflow call is
about to run and denies it when it cannot bound how many agents of each expensive model it launches.
The second, since 0.3.0, is on the `Agent` and `Task` tools, which is how the role agents are
dispatched: it caps how many agents of one model a session starts in a short window
(see [The `Agent` burst cap](#the-agent-burst-cap)).

## Why

A migration-audit workflow once fanned out to 92 Fable agents, because its verify stage ran
`findings × 3 refuters` with no cap and no per-role model. The "Dynamic workflow size" setting is
advisory text in the tool prompt. Nothing enforced it. This hook is the enforcement.

## What it enforces

Caps per script, per model:

| Model | Cap | Override |
|---|---|---|
| Fable | 3 | `WORKFLOW_MAX_FABLE` |
| Opus | 8 | `WORKFLOW_MAX_OPUS` |
| Sonnet | 12 | `WORKFLOW_MAX_SONNET` |
| Haiku | unlimited | none |

An override must be a number of 0 or more (0 is valid and forbids that model). A value that is
not numeric, is empty or is negative is ignored and the default applies, with no warning.

A script is accepted when it meets all three rules.

1. **Every `agent()` names its model.**
   - `agentType: "roles:<name>"` for one of the eight [`roles`](../roles/README.md) agents, which
     maps to that role's model (map below), or
   - a string-literal `model:` that contains `fable`, `opus`, `sonnet` or `haiku`.

   Denied: any other model string (for example `gpt-5`), a `model:` that is not a string literal,
   a `roles:` name that does not exist, an `agentType` that is not a `roles:*` name (unless a
   valid `model:` is also given), and a call with neither. A call with neither would inherit the
   session model.

2. **A budget comment declares the count per model.** One line comment:

   ```js
   // MAX_AGENTS: fable=0 opus=2 sonnet=4
   ```

   - It is required only when the script uses a capped model (Fable, Opus or Sonnet).
   - Each used capped model needs its own `name=N`, and `N` must be at least the number of
     `agent()` call sites that resolve to that model. A declared value above the cap is denied.
   - The old single-number form (`// MAX_AGENTS: 3`) is denied.
   - `haiku=N` is accepted and never checked.
   - A block comment (`/* MAX_AGENTS: ... */`) does not count.
   - Only the first `MAX_AGENTS` line is read.

3. **Fan-outs over a dynamic list are bounded** (next section).

A script that only uses Haiku needs no budget comment.

The caps and their environment overrides are shared with the `Agent` burst cap below.

### What the count measures

The gate compares the declared number with the number of `agent()` call sites per model in the
source. It does not count launches: a call site inside a loop or a `.map` counts once. The
fan-out rule is what bounds the lists.

### Fan-out rule

`pipeline(x, ...)`, `parallel(x)` and `.map(` over a dynamic list that launch non-Haiku agents
must have `.slice(0, N)` in the same chain.

- **`.map` chains.** Reading backwards from `.map(`, only `.filter(...)` links may come before a
  `.slice(...)` link. So `x.filter(f).slice(0, 3).filter(g).map(...)` passes. Any other link
  between them (a property, an index, another method such as `.sort()`) breaks it, and a
  `.slice` elsewhere in the text does not count.
- **`pipeline` and `parallel`.** A `.slice(` anywhere in the first argument counts. A first
  argument that contains a `.map(` is checked by the `.map` rule.
- **Exempt: literal arrays.** `[a, b, c]`, and a name declared as `const`/`let`/`var name = [`.
- **Exempt: `Array.from({length: <numeric literal>})`, only as the first argument of
  `pipeline` or `parallel`.** `Array.from({length: k})` there is denied, and so is
  `Array.from({length: 3}).map(...)`.
- **Exempt: Haiku-only fan-outs.** If the fan-out call has `agent()` calls inline in its
  arguments, they must all be Haiku. If it has none (for example `items.map(worker)`), every
  `agent()` call in the whole script must be Haiku.

## Role models

Used when an `agent()` names `roles:<name>`, and when an `Agent` start has that `subagent_type`. The map is `ROLE_MODELS` in `scripts/gate.mjs`, and a
test keeps it equal to the `model:` of each agent file in `plugins/roles/agents/`.

| Role | Model family |
|---|---|
| `brief-writer`, `safety-reviewer`, `hunter` | haiku |
| `tdd-implementer`, `review-fixer` | sonnet |
| `complex-implementer`, `spec-reviewer`, `final-adversarial-reviewer` | opus |

## The `Agent` burst cap

The Workflow check bounds one script. Agents started through the `Agent` tool, one at a time or
together in one message, were not bounded at all. `hooks/hooks.json` registers
`scripts/gate.mjs agent` on `PreToolUse` with matcher `Agent|Task` and a 10 second timeout.

The check counts the session's recent starts per model and denies a start when the session already
started `cap` agents of that model within the last window:

| Setting | Value | Override |
|---|---|---|
| Fable, Opus, Sonnet caps | 3, 8, 12, the same as the Workflow caps | `WORKFLOW_MAX_FABLE`, `WORKFLOW_MAX_OPUS`, `WORKFLOW_MAX_SONNET` |
| Haiku | never denied | none |
| Window | 120 s | `WORKFLOW_GATE_AGENT_WINDOW_S` (a number above 0; anything else is ignored) |
| State directory | `$XDG_STATE_HOME/triqual/workflow-gate/`, else `~/.local/state/triqual/workflow-gate/` | none |

- **The model of a start.** The `model` input wins when it names a family (`fable`, `opus`, `sonnet` or
  `haiku`). Otherwise a `subagent_type` of `roles:<name>` takes that role's model from the map below. Anything
  else (a built-in type such as `general-purpose`, an unknown `roles:` name, no type at all) is counted apart, in
  an `unresolved` bucket, and capped at the Opus cap.
- **The session.** State is one file per `session_id`, and only an id that matches `^[A-Za-z0-9_-]{1,128}$`
  is used. A start with a missing or invalid id is allowed and not counted.
- **Parallel starts.** The state file is read and written under a lock, so agents started together lose no
  update. A denied start is not recorded.
- **The denial** names the model, how many starts the window holds, the cap, and about how many seconds until
  the oldest one leaves the window. Start fewer agents of that model at once, use a cheaper model for the rest, or
  retry then. The denial text starts with `[workflow-gate]`.
- **It fails open.** A state file that cannot be read, locked or written (the lock waits 2 s) allows the start
  and writes one line to stderr. A tool call with no usable `tool_input` is allowed.
- An allow is silent on stdout, so the user's own permission prompt for the `Agent` tool is unchanged.

`WORKFLOW_MAX_*` values follow the Workflow rule: 0 or more, and an invalid value is ignored. A cap of 0 denies
every start of that model.

## How the Workflow hook runs

`hooks/hooks.json` registers `scripts/gate.mjs` on `PreToolUse` with matcher `Workflow` and a
10 second timeout.

- The script always exits 0. It denies by printing JSON with
  `hookSpecificOutput.permissionDecision: "deny"` and a reason that starts with `[workflow-gate]`.
- A denial lists every problem found, each with its fix, then the caps in force and the
  role-to-model map.
- An accepted script gets `permissionDecision: "allow"` with a one-line note, for example
  `ok: 3 agent() call(s), opus 2/8, haiku unlimited, fan-outs bounded`.
- Script source, in order: the inline `script`, then the file at `scriptPath` if it exists,
  then, for a `name`, the first of these that exists:
  1. `./.claude/workflows/<name>.js`
  2. `./.claude/workflows/<name>.mjs`
  3. `~/.claude/workflows/<name>.js`
  4. `~/.claude/workflows/<name>.mjs`

  The `./` paths are relative to the hook's working directory.
- Comments are stripped before the structural checks. For the `.map` chain check, string and
  template literal contents are also blanked, so a `.slice(` or a bracket inside a string does not
  count.

### It fails open

The hook allows silently (no output) when:

- stdin is not valid JSON;
- a named workflow has no file in the four places above (it is assumed to be a built-in, which
  Anthropic authors);
- there is no `script`, and no `scriptPath` that exists, and no `name`.

## Limits

- The gate reads source text with regular expressions. It does not run or parse the script.
- It checks call sites, not launches. A loop that calls `agent()` once per iteration passes with
  `opus=1`.
- `agent()` options must be literals. `agent(task, opts)` with `opts` built elsewhere is denied
  as having neither `model:` nor `agentType:`.
- It does not check that workflows run one at a time. That rule is in the global rules and is not
  enforced.
- The `Agent` cap counts starts in a window, per session. It does not total a session's agents, and it does not
  look inside a prompt. Starts whose model cannot be resolved are counted apart and capped at the Opus cap, which is an approximation.

## Tests

`test/gate.test.mjs` covers the Workflow check and `test/agent-gate.test.mjs` the `Agent` cap. They spawn the
gate with a JSON payload on stdin, as the hook does. To probe one script by hand:

```sh
echo '{"tool_input":{"script":"// MAX_AGENTS: opus=1\nawait agent(\"x\", {model: \"opus\"})"}}' \
  | node plugins/workflow-gate/scripts/gate.mjs
```
