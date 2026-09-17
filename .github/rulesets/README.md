# Rulesets

The branch and tag protection for this repository, kept as JSON so it is reviewable
and can be restored if it is ever edited away in the web UI.

GitHub does not read these files by itself. Apply them with:

```sh
gh api -X POST repos/0xbeef1eaf/RPChat/rulesets --input .github/rulesets/main.json
gh api -X POST repos/0xbeef1eaf/RPChat/rulesets --input .github/rulesets/tags.json
```

To update one that already exists, find its id with
`gh api repos/0xbeef1eaf/RPChat/rulesets --jq '.[] | "\(.id) \(.name)"'` and
`gh api -X PUT repos/0xbeef1eaf/RPChat/rulesets/<id> --input <file>`.
They can also be imported from **Settings → Rules → New ruleset → Import a ruleset**.

Rulesets only take effect on a public repository (or a private one on a paid plan).
On a free private repository they can be created but are not enforced.

## `main.json`

Protects the default branch:

- **deletion** and **non_fast_forward** — `main` cannot be deleted or force-pushed.
  This is the one that matters most here: the history was rewritten once on purpose,
  and nothing should be able to do that again by accident.
- **required_linear_history** — no merge commits, which matches the squash-merge flow.
- **pull_request** — changes land through a pull request, squash only. Zero approvals
  are required, because a solo maintainer cannot approve their own pull request and
  would otherwise be unable to merge at all.
- **required_status_checks** — `Build, test and smoke (Linux)` (the CI job) must pass.
  `strict` is off deliberately: the Auto-merge workflow does not update a branch before
  merging, so requiring every branch to be up to date with `main` first would leave
  labelled pull requests stuck whenever `main` moved.

## `tags.json`

`v*` release tags cannot be deleted or moved, so a published release always keeps
pointing at the commit it was built from. Creating new tags is untouched, which is
what the Release workflow does on every green push to `main`.

## Bypass

Both grant bypass to the **admin** repository role (`actor_id: 5`), so the owner is
never locked out of their own repository — a hotfix straight to `main` still works.
Remove the `bypass_actors` array from both files (and re-apply) to make the rules
absolute, including for the owner.
