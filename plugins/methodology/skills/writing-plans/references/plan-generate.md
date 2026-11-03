# Generating plans from a template

Use `triqual plan generate` when several plans share one shape (an initiative of near-identical chains, for example): write the plan once as a template, put what differs in a data file, and let the command write and check every plan file.

```
triqual plan generate --template <file.md> --data <file.json> --out <dir> [--replace]
```

## Template syntax

Plain Markdown with three tags, all inside `{{ }}`:

- `{{key}}`: the value of `key` from the plan's data (a string, number or boolean).
- `{{#each key}}` … `{{/each}}`: repeats the lines between the tags once per item of the array `key`. One level only: a block inside a block is an error. Inside the block, `{{field}}` reads the item's value and, when the item has none, the plan's; `{{@n}}` is the 1-based index of the item (use it for `### Task {{@n}}: …`). The items are objects.
- A block tag alone on its line takes the line with it, so a block adds no blank lines of its own. Put the blank line you want inside the block.

No nesting, no dotted paths, no conditionals. Nothing is ever substituted with an empty value: a key that is missing or `null`, a value that is an object or an array, an `#each` over something that is not an array, a nested, unclosed or stray block and any other `{{…}}` tag are errors that name the template, the line and the key: `template.md:12: missing key "branch"`.

## Data file

```json
{
  "defaults": { "prefix": "initiative", "tier": "standard" },
  "plans": [
    { "file": "2026-11-03-first.md", "name": "first", "tasks": [{ "title": "Read the input" }, { "title": "Write the output" }] },
    { "file": "2026-11-03-second.md", "name": "second", "tasks": [{ "title": "One task", "tier": "light" }] }
  ]
}
```

Each plan is its own object over `defaults`. `file` is required: a plain file name ending in `.md`, written to `<dir>/<file>`.

## The loop

1. `triqual plan generate --template t.md --data d.json --out <dir>` prints one line per plan: `OK <file> tasks <n> phases <m>` or `ERR <file>: <message>`, and exits 1 when any plan is an ERR. A plan is checked the way registration reads it: its tasks and phases must parse, the tier rules must hold (`validatePlanForRegistration`) and every `Depends on:` must name a task of the same plan.
2. Fix what the ERR lines name, in the template or in the data, and run again with `--replace`: a file that already exists is an ERR without it. A plan that failed to render is not written; one that failed the check stays written so you can read it.
3. When every line is `OK`, register the plans with `triqual tracking write plan --all <dir>`.
