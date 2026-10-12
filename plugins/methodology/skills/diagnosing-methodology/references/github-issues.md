# GitHub issues

Issues go to this system's repository, `<methodology-repo>` below: the
`owner/name` of the `triqual` marketplace's GitHub source
(`source.repo` in `~/.claude/plugins/known_marketplaces.json`).

Use `gh`, installed and authenticated: the repository may be private, so
unauthenticated API calls and links do not reach it. Check first:

```bash
gh auth status
```

If `gh` is missing or not authenticated, stop this step and tell your
partner; there is no fallback.

## Search

```bash
gh search issues --repo <methodology-repo> --limit 10 "<terms>" \
  --json number,state,title --jq '.[] | "\(.number)\t\(.state)\t\(.title)"'
```

## File

Write the filled `templates/issue.md` to the workspace and show the exact
text. After approval:

```bash
gh issue create --repo <methodology-repo> --title "<title>" --body-file <path>
```

The template footer marks the issue as skill-filed. `gh` cannot attach
files: give your partner the bundle path to attach through the browser
after the issue exists.
