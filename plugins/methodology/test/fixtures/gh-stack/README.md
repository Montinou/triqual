# gh stack fixtures

Real output captured on 2026-10-14 from `gh stack version 0.1.1` (`github/gh-stack`), read-only on GitHub, in the
private development repository (owner/repo `Montinou/triqual`), for the tests of `stack.mjs`. Kept byte for
byte; they hold no secret.

| File | Command | HEAD when captured |
|---|---|---|
| `view.json` | `gh stack view --json` | `stacked-execution/02-phased-plans` (a stack member; the stack's two branches, PR #7 on the first) |
| `view-2prs.json` | `gh stack view --json` (captured 2026-10-14) | `stacked-execution/01-opus-effort` (a stack member; GitHub stack #9 linked, PR #7 and PR #8 on its two branches) |
| `submit-2prs.txt` | `gh stack submit --auto --remote origin` stdout (captured 2026-10-14) | not recorded; two branches, PR #7 already up to date, PR #8 created, the stack linked (`Stack created on GitHub with 2 PRs (stack #9)`) |
| `submit-1pr.txt` | `gh stack submit --auto --remote origin` stdout (captured 2026-10-14) | not recorded; one branch, PR #7 created; no stack line |
| `repo-view.json` | `gh repo view Montinou/triqual --json nameWithOwner,defaultBranchRef` | any |
| `pr-list.json` | `gh pr list --repo Montinou/triqual --head stacked-execution/01-opus-effort --json number,isDraft` | any |
| `pr-view.json` | `gh pr view 7 --repo Montinou/triqual --json number,state,isDraft` | any |

Observed behavior the fixtures do not show:

- `gh stack view --json` on a branch outside the stack exits **2**, prints nothing on stdout and this on stderr:
  `✗ current branch "probe-nonmember" is not part of a stack`
- On the trunk (`main`) it exits 0 and prints the stack, with `"currentBranch": "main"`.
- A branch with no PR has no `pr` key; a branch with a PR has `pr.number`, `pr.url` and `pr.state` (`OPEN`).
- No field names a stack number or link in this output, with one PR in the stack (`view.json`) or with two PRs and
  the stack linked on GitHub (`view-2prs.json`). The link signal is the `submit` stdout: a line `Stack created on
  GitHub with N PRs (stack #M)` (`gh stack sync --help` documents `Stack synced` for an existing stack); gh stack v0.1.1 also prints
  `Stack #N is already up to date`, `Stack with N PRs is up to date`, `Stack on GitHub is up to date with N PRs`,
  `Updated stack to N PRs`, `Created stack with N PRs` and `Stack recreated on GitHub to match local state`. One PR
  cannot be stacked, so `submit-1pr.txt` has no such line.
