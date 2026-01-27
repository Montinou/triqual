# Changelog

All notable changes to Triqual are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
