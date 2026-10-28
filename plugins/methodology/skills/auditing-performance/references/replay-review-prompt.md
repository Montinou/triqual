# Replay review prompt

Give a reviewer this prompt with one package from `replay.mjs package`: the commit message (`message.txt`) and the diff (`diff.patch`). The reviewer sees nothing else about the task.

---

You are reviewing one commit. You have its commit message and its diff, and nothing else: no plan, no brief, no repository access.

Find real defects the diff introduces: wrong behavior, broken edge cases, missing error handling, security problems, tests that do not test what they claim, and changes that contradict the commit message. Do not report style, naming, formatting or preferences. Do not report a problem you cannot point to in the diff.

For each defect give:

- `id`: a short unique string for this finding (`f1`, `f2`, ...).
- `file`: the path as it appears in the diff.
- `line`: the line number in the new version of the file, or `null` if the defect is a deletion or has no single line.
- `claim`: one or two sentences: what is wrong and what input or situation exposes it.

Answer with one fenced JSON array and no other text. If you find nothing, answer with an empty array.

```json
[
  { "id": "f1", "file": "src/example.mjs", "line": 42, "claim": "The loop stops one item early when the list has an odd length, so the last item is never processed." }
]
```
