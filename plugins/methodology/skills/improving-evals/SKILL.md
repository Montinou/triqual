---
name: improving-evals
description: Use when the session start has an `evals` line that says to run methodology:improving-evals, or your human partner asks to improve the evals or a failure judge. Runs one improvement round, rewrites each judge prompt a round flags from the train split's notes, keeps a rewrite only when the dev score says `better`, and ships what it kept.
---

# Improving Evals

## Overview

A judge prompt is revised from what it got wrong on the train split and kept only when it measures better on the dev
split. The test split is never read to change anything. A rewrite is a candidate until the dev line says otherwise.

`<evals>` below is `$TRIQUAL_EVALS_DIR`, else `$XDG_DATA_HOME/triqual/evals`, else `~/.local/share/triqual/evals`. Run commands from the repository root.

## When to use

The SessionStart output carries a line `evals: <n> judge(s) below the bar (<ids>): run methodology:improving-evals`,
or your human partner asks you to improve the evals. Without either, do not start.

The session's working directory is a checkout of this repository. Never run the skill from another project, from the
plugin cache or from a marketplace clone (`~/.claude/plugins`, `~/.codex`): those are copies the plugin manager owns.
When the round's branch `evals/<report name>` already exists, or an `eval.mjs judge` process for the round is
already running, another session has the round: stop and say so.

## The round

1. **Get a report.** Run `triqual eval improve`. When the newest file of `<evals>/rounds/` is under a day old, read it
   instead and run nothing. Pass `--paid` only when your human partner asked for it: a credential entry marked paid
   spends money and is used only with the flag. The report is `<evals>/rounds/<YYYY-MM-DDTHHMMSSZ>.json`. Before step 3 the checkout is the trunk, up to date, and the
   `version` in `plugins/methodology/.claude-plugin/plugin.json` equals the report's `pluginVersion`; then the report's
   `version` for a category is the hash of the prompt in the checkout. When they differ, update the checkout or the
   installed plugin, whichever is behind, and run `triqual eval improve` again before step 3.
2. **Read what failed.** When the report's `failed` is not empty, name those steps in the final report to your human
   partner (`review sample`, `review propose`, `check`, `judge <id>`, `referee`, `score <id>`, `validate <id>`), and
   say so when `paidOnly` is true. A round with failed steps still has a usable `revise`, built from what exists:
   continue with it. Exit code 3 of `triqual eval improve` means the same.
3. **For each category id of `revise`, once**, do 3a to 3h on one round branch (`evals/<the report's file name without
   .json>`, made once, before the first category). A category that already has a line in `<evals>/revisions.jsonl` for
   this round is skipped: it was attempted. An empty `revise` ends the round: report it.

   a. **Read the notes.** The `misleading` notes of that category's rulings, on train sessions only. This command
      lists them; run it with the category id in place of `<id>`, and never open `rulings.jsonl` any other way:

```sh
node -e "Promise.all([import('./plugins/methodology/cli/lib/eval-validate.mjs'),import('./plugins/methodology/cli/lib/eval-paths.mjs'),import('node:fs'),import('node:os')]).then(([{splitOf},{evalsDir},fs,os])=>((d,j=f=>fs.readFileSync(d+f,'utf8').split('\\n').filter(Boolean).map(l=>JSON.parse(l)))=>((t)=>j('/rulings.jsonl').filter(x=>x.category===process.argv[1]).filter(x=>t.has(x.sessionId)).filter(x=>x.misleading).forEach(x=>console.log(x.misleading)))(new Set(j('/review/sample.jsonl').filter(s=>splitOf(s.sessionId,s.stratum)==='train').map(s=>s.sessionId))))(evalsDir(process.env,os.homedir())))" <id>
```

   b. **Read the dev counts.** A category with no `scores` entry, or no `version` in it, in the report is skipped: it is
      not rewritten, and it is never scored without `--against`. From the report's `scores` entry of the category, only its `dev` counts: `fn` is the
      failures the judge missed, `fp` the false alarms. Note too the category's `version` in the report's `scores`
      entry: that is the baseline, the version in place before the rewrite. Read nothing else about dev or test.
   c. **Rewrite** `plugins/methodology/evals/judges/<id>.md`, from those notes and counts and nothing else:
      - the FAIL conditions as a checklist;
      - the look-alikes that are not the failure, under PASS;
      - the easy-to-miss kinds of the failure, under FAIL;
      - invented examples only, and nothing copied from a session;
      - one failure per prompt;
      - the `model:` line unchanged, unless the change is the model (then the full model id, never an alias).
   d. **Test the prompt.** Run `node --test plugins/methodology/test/eval-checks.test.mjs`. A failure is a defect of the
      rewrite: fix the prompt, or revert it (3g).
   e. **Judge the sample.** Run
      `node plugins/methodology/cli/eval.mjs judge --category <id> --sessions <evals>/review/sample.jsonl` from the
      repository root, never as `triqual`: `triqual` runs the installed copy of the plugin, whose judge prompts are the
      installed ones, so it would judge the old prompt. It records verdicts under the new prompt's hash. Pass `--paid` here too when your human partner asked for it. Exit 1 means
      sessions were left (a limit or an error): rerun once, then treat the result as it stands.
   f. **Score.** Run `node plugins/methodology/cli/eval.mjs score --category <id> --against <baseline>`. Its `dev:` line is `dev: previous <balanced>
      (<correct>/<n>), current <balanced> (<correct>/<n>): <verdict>`. Exit 2 with "the prompt did not change" means the
      rewrite changed nothing: restore the file (3g) and record `kept: false` (3h), with `to` equal to `from` and null
      counts.
   g. **Keep or revert.** Keep the file only when the `dev:` line ends `better`. Otherwise (`not-better`, or `first
      version`, which compares nothing) restore it with `git checkout -- plugins/methodology/evals/judges/<id>.md`.
   h. **Record.** Append one line to `<evals>/revisions.jsonl`, written with `umask 077` so the file is mode 0600:
      `{ at, round, category, from, to, kept, n, previous, current }`. `at` is the time now (ISO 8601), `round` is the
      report's file name including `.json`, such as `2026-11-16T100000Z.json`, `category` is the id, `kept` is true or false. `from`, `to`, `n`, `previous` and `current`
      come from the `previous` block of the category's last line in `<evals>/scores.jsonl` (read that block and nothing
      else of the line): `from` is the baseline (the prompt hash before the rewrite), `to` is the line's own
      `version` (the hash after it), and `n`, `previous` and `current` are `previous.n`, `previous.previous` and
      `previous.current`. A line with no `previous` block (`dev: first version`) gives `from` null, `n` 0, and null
      `previous` and `current`. Then write the progress entry with both versions' counts, kept or reverted.
4. **Ship what was kept**, once for the whole round. On the round branch make one commit per kept category, with this
   in the body: `dev: previous <balanced> (<correct>/<n>), current <balanced> (<correct>/<n>)`. Then make one bump
   commit of `methodology`'s `version`, as the repository's release rule says, so the installed copy changes: it is the
   last commit of the branch, and no category commit bumps. Push the branch and open one pull request. Make one merge
   under the repository's own merge rule, then do one plugin update, `claude plugin update methodology@triqual`, only
   when this repository's own instructions or your human partner's standing instructions authorise you to merge there;
   without that authorisation, stop at the pull request and report its link. When no category was kept, there is no
   branch to ship: nothing is committed, pushed or merged.
5. **Report** to your human partner in the format below.

## Rules

- never open a test-split session or a ruling about one
- never ask the owner to rule on a case
- one attempt per category per round
- a rewrite is a candidate, never an improvement until measured
- a change to a skill, role or rule is released and measured by the next rounds' `triqual eval rates`, and a controlled comparison is an experiment
- merge only where authorised: without the authorisation of step 4 the round stops at the pull request, because a merge nobody authorised is a human-only decision
- stop only for a denial by policy, a human-only decision, or a failure you cannot explain

## Final report

The report is at most 20 lines in all, one per category of `revise`: the id, kept or reverted, and the counts, `previous <balanced>
(<correct>/<n>), current <balanced> (<correct>/<n>)`. Add one line for the failed steps of the round (step 2), one
for the categories skipped for a missing score (3b) and one for the report's path. Counts and ids only: no transcript text.
