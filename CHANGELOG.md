# Changelog

All notable changes to Triqual are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-01-31

### Added
- **`triqual_load_context` MCP tool** — Local stdio MCP server that spawns a headless Sonnet subprocess to build comprehensive context files
- `triqual-context-server.js` MCP server with caching, validation, and error handling
- `context-builder.md` prompt template for the subprocess (7-step research pipeline)
- `triqual-context` entry in `.mcp.json` for auto-installation
- `context_files_exist()`, `get_context_dir()`, `list_context_files()`, `extract_feature_from_prompt()` helper functions in `common.sh`
- Triple-layer enforcement: pre-task gate, pre-write gate (GATE 4.5), and pre-retry gate (GATE 0) all check for context files

### Removed
- **`quoth-context` agent** — Replaced entirely by `triqual_load_context` MCP tool
- `quoth_context_invoked()`, `mark_quoth_context_invoked()`, `quoth_search_documented()`, `quoth_search_skipped_justified()` functions from `common.sh`
- `quoth_context` session state field
- `quoth-context` cases from `subagent-start.sh` and `subagent-stop.sh`
- `triqual-plugin:quoth-context` from `hooks.json` SubagentStart/SubagentStop matchers

### Changed
- Agent count reduced from 6 to 5 (quoth-context was the only Sonnet agent)
- `pattern-learner` agent now has direct Quoth MCP tools (`mcp__quoth__*`) for capture mode (previously delegated to quoth-context)
- `test-planner` agent reads pre-built `.triqual/context/{feature}/` files instead of invoking quoth-context
- `pre-spec-write.sh` GATE 4.5 now checks file existence instead of session flags
- `pre-task-gate.sh` checks context files before allowing test-planner dispatch
- `pre-retry-gate.sh` GATE 0 checks context files before first test run
- `session-start.sh` references `triqual_load_context` tool instead of quoth-context agent
- `stop.sh` references `triqual_load_context` and pattern-learner's Quoth capture capability
- All documentation updated: CLAUDE.md, README.md, ARCHITECTURE.md, help SKILL.md

## [1.1.1] - 2026-01-29

### Fixed
- Use fully-qualified `triqual-plugin:*` agent names in hooks.json matchers
- Use fully-qualified agent names in SubagentStart/SubagentStop hooks
- Version bump to refresh plugin cache after plugin.json schema fix
- Remove invalid `agents` and `skills` fields from plugin.json (auto-discovered)

## [1.1.0] - 2026-01-29

### Added
- **Quoth v2 integration** — Enhanced context injection via hooks
- `quoth-context` Sonnet agent with three modes: session inject, pre-agent research, capture
- Session context injection in `subagent-start.sh` for test-planner
- Quoth context enforcement in pre-write and pre-retry hooks

### Changed
- Hooks now inject Quoth context summaries before agent execution
- test-planner requires Quoth context before creating test plans
- Enhanced session-start guidance to emphasize Quoth context loading

## [1.0.5] - 2026-01-27

### Added
- **Mandatory Quoth pattern search enforcement** - Hooks now BLOCK test writing until Quoth search is documented
- New `quoth_search_documented()` helper function in common.sh
- New GATE 4.5 in pre-spec-write hook that verifies Quoth search
- Skip justification support if MCP is unavailable

### Changed
- Session start now emphasizes Quoth search as mandatory first step
- test-planner agent updated to make Quoth search "Step 0" (non-negotiable first action)
- Documentation updated to reflect mandatory Quoth pattern search

## [1.0.4] - 2026-01-27

### Changed
- All 5 agents now run on **Opus 4.5** model for maximum intelligence
- Comprehensive documentation update with architecture diagrams
- Version sync across all configuration files

### Added
- ARCHITECTURE.md with detailed technical documentation
- Component interaction diagrams
- Hook communication protocol documentation
- API reference for skills, MCP tools, and configuration
- CONTRIBUTING.md with guidelines for adding rules, agents, and hooks

### Fixed
- Duplicate line numbering in workflow documentation

## [1.0.3] - 2026-01-26

### Fixed
- macOS stdin reading compatibility in hooks
- Hook input validation for edge cases
- Session state file locking on macOS

### Changed
- Updated `lib/common.sh` with robust stdin handling
- Improved error messages for blocked actions

## [1.0.2] - 2026-01-25

### Added
- **SubagentStart hook** - Injects context before agents run
- **SubagentStop hook** - Guides next steps after agent completion
- 25-attempt maximum limit for test-healer
- Deep analysis phase at attempt 12
- `.fixme()` marking for unfixable tests

### Changed
- test-healer now promotes tests only on SUCCESS
- Run logs track attempt counts
- Improved failure categorization

## [1.0.1] - 2026-01-24

### Added
- **Documented learning loop** (ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN)
- Run logs at `.triqual/runs/{feature}.md`
- Knowledge file at `.triqual/knowledge.md`
- Gate-based enforcement through hooks
- Pre-Write blocking hook
- Post-Run logging hook
- Pre-Compact context preservation

### Changed
- Skills now enforce documentation before writing code
- Agents update run logs at each stage

## [1.0.0] - 2026-01-23

### Added
- Initial release of Triqual plugin
- 5 skills: `/init`, `/test`, `/check`, `/rules`, `/help`
- 5 agents: test-planner, test-generator, test-healer, failure-classifier, pattern-learner
- 7 hooks for enforcement and context management
- MCP integration: Quoth (patterns), Exolar (analytics)
- 31 Playwright best practice rules (8 categories)
- Draft-first development pattern
- Session state management

### Infrastructure
- Plugin manifest and marketplace configuration
- Auto-discovery of skills and hooks
- Template system for project initialization
