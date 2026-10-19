// Task roles (spec Addendum E.5): who does a task's work. A plan task names its role on a `**Role:**` line; without
// one it is the default. Reviewer roles and roles:brief-writer serve a task and are never its role. Every `roles:*`
// entry names an agent of the roles plugin (a test pins it).

// Review tiers live in the plan reader (which imports nothing) and are re-exported here for the plugin's own code.
export { TIERS } from './plan.mjs';

export const DEFAULT_ROLE = 'roles:tdd-implementer';
export const TASK_ROLES = Object.freeze([
  'coordinator', 'roles:tdd-implementer', 'roles:complex-implementer', 'roles:review-fixer',
]);

// A task's role: the one its plan or ledger records, else the default (ledgers written before 0.2.2 have no field).
export const roleOf = (task) => task.role ?? DEFAULT_ROLE;
