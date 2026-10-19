# Tiers Implementation Plan

### Task 1: Heavy work

**Tier:** heavy
**Role:** roles:complex-implementer
**Skills:** s1, s2

- [ ] **Step 1:** do the heavy thing.

### Task 2: Standard work

**Tier:** standard
**Role:** roles:tdd-implementer
**Depends on:** T1

- [ ] **Step 1:** do the standard thing.

### Task 3: Light work

**Tier:** light
**Role:** coordinator
**Depends on:** T1, T2

- [ ] **Step 1:** record the status.

## After Merge

**Role:** coordinator

- [ ] `echo deploy` → prints deploy
