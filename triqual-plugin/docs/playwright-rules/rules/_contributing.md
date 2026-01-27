# Contributing to Playwright Rules

Guidelines for adding, updating, or improving rules in this documentation.

## Adding a New Rule

1. **Copy the template**: Start with `_template.md`
2. **Name the file**: Use kebab-case matching the rule name (e.g., `wait-no-timeout.md`)
3. **Fill all sections**: Every section in the template should be completed
4. **Add to index**: Update `_sections.md` with the new rule

## Rule Naming Convention

Rules follow the pattern: `{category}-{specific-rule}`

**Categories:**
- `locator-*` - Element selection
- `selector-*` - CSS/XPath selectors
- `wait-*` - Timing and waits
- `assert-*` - Assertions
- `page-object-*` - Page Object patterns
- `test-*` - Test organization
- `network-*` - Network handling
- `debug-*` - Debugging
- `parallel-*` - Parallelization

## Writing Guidelines

### Summary
- One clear sentence
- Start with a verb (Prefer, Avoid, Use, etc.)
- Example: "Prefer role-based locators over CSS selectors"

### Rationale
- Explain the "why" not just the "what"
- Include failure scenarios this prevents
- Reference Playwright internals if relevant

### Code Examples
- Keep examples minimal but complete
- Show realistic scenarios, not contrived examples
- Include imports if non-obvious
- Use TypeScript

### Good Example Structure
```typescript
// Good - {brief explanation}
await page.getByRole('button', { name: 'Submit' }).click();
```

### Bad Example Structure
```typescript
// Bad - {brief explanation of what's wrong}
await page.click('.btn-submit');
```

## Severity Guidelines

### ERROR
Use when the violation:
- Will definitely cause test failures
- Creates race conditions
- Violates Playwright's intended usage

### WARNING
Use when the violation:
- May cause intermittent failures
- Works but is fragile
- Has better alternatives

### INFO
Use when the rule:
- Improves maintainability
- Follows best practices
- Is stylistic preference

## Auto-fix Requirements

If marking a rule as auto-fixable:
1. The transformation must be deterministic
2. The fix must not change test behavior
3. Document edge cases where auto-fix may fail

## Review Checklist

Before submitting a new rule:

- [ ] All template sections are filled
- [ ] Examples compile and run
- [ ] Severity is appropriate
- [ ] Related rules are linked
- [ ] References include official Playwright docs
- [ ] Rule is added to `_sections.md`

## Updates to Existing Rules

When updating rules:
1. Keep backward compatibility in mind
2. Note significant changes in the rule file
3. Update related rules if connections change
