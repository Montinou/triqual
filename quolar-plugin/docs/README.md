# Quolar Unified - Architecture & Approach

## Overview

Quolar Unified is a Claude Code plugin that enables **interactive test development** - the ability to navigate, observe, and interact with a live application via browser automation, then write or fix tests based on actual observed behavior.

This is fundamentally different from traditional test generation which works from documentation alone. With Quolar Unified, Claude Code becomes a **competent test developer** that can:

1. **See** the actual application state via browser snapshots
2. **Act** on the application via clicks, typing, navigation
3. **Analyze** differences between expected and actual behavior
4. **Update** test code based on real observation
5. **Verify** fixes by running the actual tests
6. **Learn** by documenting new patterns back to Quoth

## Core Philosophy

### Competent Autonomy with Smart Escalation

Claude Code should behave like a skilled test developer who:

- **Knows standard patterns** - Understands common automation project structures without being told
- **Explores independently** - Figures out project-specific details by reading code and config
- **Asks smart questions** - Only interrupts when something is genuinely unusual or requires a decision
- **Learns continuously** - Documents discoveries so future work goes faster

### The Knowledge Loop

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           THE KNOWLEDGE LOOP                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐                                      ┌─────────────┐      │
│   │   QUOTH     │◄─────── Learning ──────────────────┤   EXOLAR    │      │
│   │  Knowledge  │                                      │  Analytics  │      │
│   │    Base     │                                      │             │      │
│   └──────┬──────┘                                      └──────▲──────┘      │
│          │                                                    │              │
│          │ Search patterns                      Report results│              │
│          │ before acting                        after testing │              │
│          ▼                                                    │              │
│   ┌─────────────────────────────────────────────────────────────┐           │
│   │                    CLAUDE CODE                               │           │
│   │                                                              │           │
│   │   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐ │           │
│   │   │ Observe │───▶│ Analyze │───▶│ Update  │───▶│ Verify  │ │           │
│   │   │ (MCP)   │    │         │    │ (Edit)  │    │ (Run)   │ │           │
│   │   └─────────┘    └─────────┘    └─────────┘    └─────────┘ │           │
│   │        │                                                    │           │
│   │        │              PLAYWRIGHT MCP                        │           │
│   │        ▼              (browser control)                     │           │
│   │   ┌─────────────────────────────────────────────────────┐  │           │
│   │   │  browser_navigate  browser_snapshot  browser_click  │  │           │
│   │   │  browser_type      browser_wait_for  browser_hover  │  │           │
│   │   └─────────────────────────────────────────────────────┘  │           │
│   │                                                              │           │
│   └──────────────────────────────────────────────────────────────┘           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Two Operating Modes

### Mode A: Debug Existing Test

When a test is failing, Claude Code can:

1. **Read** the test file to understand expected behavior
2. **Open** the application in a browser via Playwright MCP
3. **Follow** the test steps manually, observing actual behavior
4. **Identify** where actual behavior diverges from expected
5. **Fix** the test code (locators, assertions, flow)
6. **Run** the test to verify the fix
7. **Document** any new patterns discovered

### Mode B: Explore & Create New Test

When creating tests for a feature:

1. **Search** Quoth for existing patterns for this type of test
2. **Navigate** to the feature in the live application
3. **Explore** the actual user flow step by step
4. **Observe** the elements, states, and transitions
5. **Write** test code based on real observation
6. **Run** to verify it works
7. **Document** the pattern for future use

## Key Components

### 1. Bootstrap / Project Scan

Before working on any project, Claude Code scans the test infrastructure:

- Page Objects and their methods
- Helper utilities and factories
- Authentication patterns and credentials location
- Test data structures
- Configuration and environments

This knowledge is uploaded to Quoth as the project's test documentation.

See: [references/bootstrap-workflow.md](references/bootstrap-workflow.md)

### 2. Standard Patterns Recognition

Claude Code knows what "normal" looks like for automation projects:

- Common folder structures (page-objects/, fixtures/, utils/)
- Standard file naming conventions (*.spec.ts, *.page.ts)
- Typical authentication patterns
- Common helper function patterns

This enables autonomous exploration without constant questions.

See: [references/standard-patterns.md](references/standard-patterns.md)

### 3. Playwright MCP Integration

The plugin leverages Playwright MCP tools for browser interaction:

- `browser_navigate` - Go to URLs
- `browser_snapshot` - See page state (accessibility tree)
- `browser_click` - Click elements
- `browser_type` - Enter text
- `browser_wait_for` - Wait for conditions
- And more...

See: [references/playwright-mcp.md](references/playwright-mcp.md)

### 4. Smart Escalation

Claude Code knows when to ask vs proceed:

**Proceed autonomously:**
- Standard folder structures
- Common patterns
- Clear test failures with obvious fixes

**Ask the user:**
- Non-standard project organization
- Business logic questions
- Multiple valid approaches
- Destructive actions

See: [references/escalation-triggers.md](references/escalation-triggers.md)

### 5. Error Pattern Reference

Common test failures and their fixes:

- Locator not found → selector strategies
- Timeout exceeded → wait strategies
- Strict mode violation → uniqueness fixes
- Authentication failures → auth state management

See: [references/error-patterns.md](references/error-patterns.md)

### 6. Verification Workflow

After making changes, Claude Code verifies:

1. Run the specific test
2. Check for pass/fail
3. If failed, analyze the new error
4. Iterate until passing or escalate

See: [references/verification-workflow.md](references/verification-workflow.md)

## Documentation Index

### Core Concepts
- [Standard Patterns](references/standard-patterns.md) - What "normal" looks like
- [Escalation Triggers](references/escalation-triggers.md) - When to ask vs act

### Workflows
- [Bootstrap Workflow](references/bootstrap-workflow.md) - Initial project scan
- [Debug Workflow](references/debug-workflow.md) - Fixing failing tests
- [Explore Workflow](references/explore-workflow.md) - Creating new tests
- [Verification Workflow](references/verification-workflow.md) - Confirming fixes work

### Technical References
- [Playwright MCP](references/playwright-mcp.md) - Browser control tools
- [Error Patterns](references/error-patterns.md) - Common failures and fixes
- [Locator Strategies](references/locator-strategies.md) - Finding elements reliably
- [Quoth Integration](references/quoth-integration.md) - Knowledge base interaction
- [Exolar Integration](references/exolar-integration.md) - Analytics and reporting

## Design Principles

### 1. Observation Over Assumption

Never assume what the UI looks like. Always observe via browser snapshot before acting or writing tests.

### 2. Existing Patterns First

Before creating anything new, search Quoth and the codebase for existing patterns. Consistency is more valuable than cleverness.

### 3. Fail Fast, Learn Fast

Run tests immediately after changes. Don't batch up changes hoping they'll all work. Quick feedback enables quick iteration.

### 4. Document Discoveries

When something unexpected is learned, propose it back to Quoth. The knowledge base should grow with every interaction.

### 5. Respect Project Conventions

Every project has its own style. Discover and follow it rather than imposing external patterns.
