# Demo Implementation Plan

**Branch prefix:** demo

## Phase 1: Core

**Slice:** S1
**Branch:** demo/01-core
**PR title:** feat: core
**Stands alone because:** core only
**Phase check:** `true` → exit 0

### Task 1: One

**Role:** roles:tdd-implementer

- [ ] **Step 1:** do one.

### Task 2: Two

**Role:** roles:tdd-implementer

- [ ] **Step 1:** do two.

```
## Phase 9: inside a fence

**Branch:** demo/09-fake

### Task 9: fake
```

## Phase 2: Edge

**Slice:** S2
**Branch:** demo/02-edge
**PR title:** feat: edge
**Stands alone because:** core only
**Phase check:** `true` → exit 0

### Task 3: Three

**Depends on:** T2
**Role:** roles:tdd-implementer

- [ ] **Step 1:** do three.

## After Merge

- [ ] `echo deploy` → prints deploy
