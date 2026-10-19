---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---

# Brainstorming

Turn a request into a design your human partner has approved, before anything is built. First decide how much process the request needs, then work that path: understand the context, settle the idea, present the design, get the approval.

## Share your understanding first

The result of brainstorming is an understanding your partner can recognize and correct.

1. **Find the intent.** From the request and what you can see, work out the outcome wanted, who it is for and what success looks like. If the purpose is missing, ask one focused question about it before you propose features or an approach: knowing the genre of the app does not tell you why they want it.
2. **Write it back.** In a few lines, state the outcome, the constraints and the success criteria, marking what they said apart from what you assumed. Take their corrections before you treat it as the brief.
3. **Carry it into the design.** The design artifact of your path (the written spec, or the in-chat design or probe) keeps that understanding, and every feature and technical choice is checked against it.

When the request already gives the purpose and constraints, reflect them back instead of asking again.

<HARD-GATE>
Take no implementation action until your path's approvals exist. Implementation means invoking an implementation skill, writing product code, scaffolding, installing product dependencies or creating an external project.

- Spike: your human partner approves the question and the probe.
- Bounded: your human partner approves the short design you gave in chat.
- Architectural: your human partner approves the written spec. Approving the idea in conversation only lets you write the spec; approving the spec only lets you invoke writing-plans, whose plan they approve in turn.

A reply approves what was actually shown. Approving an idea or a scope does not approve an artifact that does not exist yet, and one approval never stands in for the rest of the path: resume at the earliest stage still open. An instruction such as "no questions, no design, just do it" asks you to be quick; it does not waive this gate. Show the design in a sentence or two and wait for the yes, and offer to skip further process only after the design is on the table. Reading the project is always allowed.
</HARD-GATE>

## Vault skills and tracking paths

At the start, run `triqual suggest "<the request>"`. It prints a `<headjack-suggestions>` block, and you handle a fitting skill the way `methodology:using-methodology` says. On a non-zero exit (exit 3 means headjack is not installed), on empty output, or when `triqual` is not on `PATH` (`command -v triqual` fails, or exit 127), there is no suggestion: skip it silently.

Before you write a spec, run `triqual tasks paths --json` once to learn where tracking files go:

- **Opted in** (`"optedIn": true`; an older `triqual` prints the same fields without `optedIn`): specs go to `specsDir`. In local mode (`"mode": "local"`) it sits under the git dir, so the spec stays out of git. In store mode (`"mode": "store"`) it sits in the store's documents directory, outside the working tree.
- **Not opted in** (`"optedIn": false`, or exit 2 from an older progress-tracking): specs go to `docs/specs/` unless your partner names another place. Run no `triqual tasks` command and never create `progress.md`: creating it opts the repo in and commits a personal log into a shared repo.
- **`triqual` missing** (exit 3, or not on `PATH`): treat it as not opted in and say so once.

Local mode: `specsDir` is under the git dir, which Claude Code protects from agent file writes. Run `mktemp -d` for a private draft directory (call what it prints `$d`; other sessions share the temp dir), write the spec there under its final name, `$d/YYYY-MM-DD-<topic>-design.md`, and land it with `triqual tracking write spec <draft>`. After each edit (self-review, audit, your partner's changes) land it again with `triqual tracking write spec <draft> --replace`. Never write or edit under `.git/` with the file tools.

Store mode (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`): the same draft and the same `triqual tracking write spec` route, with `--replace` after edits. The spec never enters the working tree. Writing it ends the task with no commit, so write its `progress` entry as a draft in that directory (`$d/entry.md`) and land it with `triqual tracking add <draft> --no-commit`: a pending entry left behind would be stamped onto the next, unrelated commit.

## Three paths

Before your first question, classify the request and say the classification out loud ("this looks bounded, so I'll give a short design here instead of writing a spec") so your partner can overrule it.

- **Spike**: a feasibility question ("can we", "is it possible", "quick and dirty is fine") whose product is an answer, not code you keep. Say what you will try in two or three sentences, get a nod, then find out as cheaply as correctness allows. No design document and no spec file. Report a recommendation, and label anything you built as throwaway.
- **Bounded**: a well-scoped change to a flow that already exists in this repo (a flag, a small endpoint, a one-file fix). Knowing the kind of app is not enough: if there is no existing flow to read, the work is not bounded. Ask the questions that matter, give a short design in chat (a few sentences to a few short paragraphs), and stop. Implementation starts when your partner says yes to that design; this gate is as hard as the architectural one. No spec file and no plan document.
- **Architectural**: a new project or subsystem, or a change that restructures how components fit or alters interfaces others rely on. Run the full process: questions, approaches, a design in sections, a written spec, then writing-plans.

Between two paths, take the heavier one. The ratchet only turns one way: if hidden complexity shows up midway, stop, say so and step up. Nothing downgrades mid-task, and each new task gets its own classification and its own approval.

## Red flags

| Thought | Reality |
|---------|---------|
| "Too simple to need a design" | Scale the artifact, never skip it: a bounded change gets a short chat design, an architectural one gets the written spec. |
| "Calling it bounded saves the spec" | Reaching for the label to skip work is the doubt: take the heavier path. |
| "The design is obvious, I'll start while they read it" | The approval is the gate, not the design's length. Show it, then stop until you hear yes. |
| "I know this kind of app, so it's bounded" | Bounded measures the repo, not your familiarity. A new project is architectural. |
| "They said no design, so the gate is waived" | That instruction is about speed. Show a two-sentence design and wait. |
| "The spike worked, I'll keep the code" | A spike produces an answer. Keeping the code is a new request: classify it. |
| "It grew, but I'm nearly done" | Hidden complexity upgrades the path. Stop and say so. |

## Checklist

Classify, announce the path, then make a task for each item of your path and complete them in order.

**Spike:**
1. **Explore project context**: enough to frame the probe
2. **Present the question and probe**: two or three sentences
3. **Get a nod**
4. **Investigate**: as cheaply as correctness allows
5. **Report**: a recommendation, with anything built labeled throwaway

**Bounded:**
1. **Explore project context**: files, docs, recent commits
2. **Ask clarifying questions**: one at a time, only those that matter
3. **Present a short design in chat**: approach, files touched, testing
4. **Get an explicit yes**: stop and wait; presenting and starting in the same breath skips the gate
5. **Implement**: through the normal workflow (test-driven-development applies); no plan document

**Architectural:**
1. **Explore project context**: files, docs, recent commits
2. **Offer the visual companion just in time**: never upfront; see Visual companion below
3. **Ask clarifying questions**: one at a time, for purpose, constraints and success criteria
4. **Propose 2-3 approaches**: with trade-offs and your recommendation
5. **Present design**: in sections scaled to their difficulty, approval after each; it names its units and its delivery slices
6. **Write the spec**: to `<specs dir>/YYYY-MM-DD-<topic>-design.md` (see After the Design)
7. **Spec self-review**: an inline check for placeholders, contradictions, ambiguity, scope and modularity
8. **Spec audit**: dispatch `roles:final-adversarial-reviewer` with `spec-document-reviewer-prompt.md`, then fix its findings
9. **Partner reviews the written spec**: ask before moving on
10. **Hand off**: invoke writing-plans

The terminal state depends on the path. Architectural: the only skill you invoke afterwards is writing-plans, never an implementation skill such as frontend-design. Bounded: implement through the normal workflow once approved. Spike: the reported recommendation.

## The Process

Bounded work needs only context, a few questions and a short chat design. Everything from "Exploring approaches" down is architectural depth.

**Understanding the idea:**

- Look at the current project first: files, docs, recent commits.
- Judge scope before detail. If the request spans several independent subsystems ("a platform with chat, file storage, billing and analytics"), say so at once and decompose it: what are the independent pieces, how do they relate, in what order are they built? Brainstorm the first piece through this flow; each piece gets its own spec, plan and build.
- Ask one question at a time, and only one question per message; split a topic that needs more. Prefer multiple choice, accept open-ended answers.
- Aim at purpose, constraints and success criteria.

**Exploring approaches:**

- Offer 2-3 approaches with trade-offs, lead with your recommendation and say why.
- Apply YAGNI to every approach and every design: cut what is not needed.

**Presenting the design:**

- Once you believe you understand it, present the design in sections, each as short as its difficulty allows (a few sentences, up to 200-300 words when subtle), and ask after each whether it looks right.
- Cover architecture, components, data flow, error handling and testing.
- Cover the units (each with one purpose, interface, dependencies and acceptance) and the delivery slices (the ordered, independently mergeable pieces that together deliver every unit), so the written spec can carry them as `## Units` and `## Delivery Slices`.
- Go back and clarify whenever something does not make sense.

**Design for isolation and clarity:**

- Split the system into units that each have one clear purpose, talk through defined interfaces and can be understood and tested alone.
- For each unit you should be able to say what it does, how it is used and what it depends on. If someone cannot grasp a unit without reading its internals, or changing the internals breaks its consumers, the boundary needs work.
- Small units are easier to hold in context and to edit reliably; a file that keeps growing is usually doing too much.
- Put the units in the spec's `## Units` section and their shipping order in `## Delivery Slices`. Both are required.

**Existing codebases:** follow the patterns already there. Include a targeted improvement only where a problem in the existing code affects this work (an oversized file, tangled responsibilities); leave unrelated refactoring alone.

## Units and Delivery Slices

Every architectural spec carries these two sections, with exactly these headings and line labels. The spec is a target for the plan to map onto, not a story.

```markdown
## Units

### U<n> — <name>
**Purpose:** one sentence.
**Interface:** names, signatures, commands, files and formats that others use.
**Depends on:** units, or `none`.
**Acceptance:** observable checks.

## Delivery Slices

### S<n> — <name>
**Delivers:** what this slice puts on trunk.
**Units:** units, or parts of units, it builds.
**Stands alone because:** why trunk stays green and coherent if this slice merges alone, in order: no half-built reachable code; behind a feature flag where the global Feature Flags rule applies.
**Acceptance:** observable checks.
```

- A slice depends only on earlier slices.
- Together the slices cover every unit.
- A slice that would need more than about 6 atomic tasks is split.
- Work that needs the merge (deploy, production migration, publish) goes under the spec's rollout, not into a slice.

## After the Design (architectural path)

**Writing the spec:** save it to `<specs dir>/YYYY-MM-DD-<topic>-design.md`, where the specs directory comes from the tracking paths above.

- When it lives in the working tree (not opted in, or `"mode": "committed"`), commit it. In committed mode the same commit carries a new top `progress` entry (`progress.md`) and an updated `status` (`status.md`), edited around the tasks markers and never inside them: the repo's pre-commit rejects the commit without them.
- In local mode it stays under the git dir, out of git, and is landed with `triqual tracking write spec <draft>`.
- In store mode, land it the same way, make no commit, land the entry with `triqual tracking add <draft> --no-commit`, and stage no tracking file.

**Spec Self-Review:** read the spec again with fresh eyes.

1. **Placeholder scan:** any "TBD", "TODO", unfinished section or vague requirement? Fix it.
2. **Internal consistency:** do sections contradict each other, or the architecture the feature descriptions?
3. **Scope check:** is it focused enough for one implementation plan, or does it need decomposing?
4. **Ambiguity check:** could a requirement be read two ways? Pick one and say it.
5. **Modularity:** does every unit state its interface and what it depends on, does every slice depend only on earlier slices, do the slices cover every unit, does each slice say why it stands alone, and is any slice big enough (more than about 6 atomic tasks) to split?

Fix what you find inline and move on; this pass needs no second review.

**Spec Audit:** dispatch `roles:final-adversarial-reviewer` with `spec-document-reviewer-prompt.md` on the spec. The adversarial audit runs on every architectural spec and no other reviewer takes its place. Fix its findings in the spec, and in your message to your partner name each finding you did not fix and why.

**User review gate:** once the audit is handled, ask your partner to read the written spec before you go on:

> "Spec written to `<path>`. Please review it and tell me what to change before I start on the implementation plan."

Wait. If they ask for changes, make them and repeat the self-review and the audit. Continue only when they approve.

**Hand off:** invoke writing-plans, and nothing else.

## Visual companion

A browser tab for showing mockups, diagrams and visual options while you brainstorm. It is a tool, not a mode: accepting it does not send every question to the browser.

**Offer it just in time, never upfront.** Wait for the first question that would be clearer shown than described (a layout, a mockup, a diagram; a UI topic alone is not enough), then offer it as its own message, with no question or summary attached:

> "This next part might be easier if I show you: I can put together mockups, diagrams and comparisons in a browser tab as we go. It's still new and can use a lot of tokens. Want me to? I'll open it for you."

Wait for the answer. If they accept, start the server with `--open` so their browser opens on the first screen. If they decline, stay text-only and do not offer again unless they raise it.

**Decide per question.** The test is whether your partner would understand it better by seeing it. Use the browser for mockups, wireframes, layout comparisons and architecture diagrams. Use the terminal for requirements, concepts, trade-off lists, text options and scope decisions: "what does personality mean here?" is conceptual, "which wizard layout works better?" is visual.

After an acceptance, read `visual-companion.md` in this skill's folder before you start.
