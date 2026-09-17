# Repository configuration

GitHub keeps branch protection and the Actions policy in settings, not in the repository.
The JSON here is the reviewable copy: diffable, restorable, and visible in a pull request.
Nothing applies it automatically — the commands below do.

| File | What it is |
| --- | --- |
| `rulesets/main.json` | Branch protection for the default branch |
| `rulesets/tags.json` | `v*` release tags cannot be deleted or moved |
| `actions-policy.json` | Which actions may run, and what the default token may do |
| `actions-lock.json` | The commit SHA every action is pinned to |

## Applying

```sh
R=0xbeef1eaf/RPChat
gh api -X POST "repos/$R/rulesets" --input .github/rulesets/main.json
gh api -X POST "repos/$R/rulesets" --input .github/rulesets/tags.json

jq '.permissions'       .github/actions-policy.json | gh api -X PUT "repos/$R/actions/permissions" --input -
jq '.selected_actions'  .github/actions-policy.json | gh api -X PUT "repos/$R/actions/permissions/selected-actions" --input -
jq '.workflow'          .github/actions-policy.json | gh api -X PUT "repos/$R/actions/permissions/workflow" --input -
```

Rulesets already applied are updated with `PUT repos/$R/rulesets/<id>`; list ids with
`gh api "repos/$R/rulesets" --jq '.[] | "\(.id) \(.name)"'`.

## Bumping an action

`sha_pinning_required` means GitHub refuses an action that is not pinned to a commit SHA,
and `scripts/check-actions-lock.mjs` (an early CI step) refuses one whose SHA disagrees with
`actions-lock.json`.

Dependabot keeps the SHA pinning when it bumps an action, but cannot know about the lockfile,
so its pull request fails that check until the lockfile is regenerated:

```sh
node scripts/check-actions-lock.mjs --write   # then commit the lockfile into the same PR
```

That is deliberate. An action bump changes what runs against this repository with a token,
so it should be looked at rather than auto-merged on a label.
