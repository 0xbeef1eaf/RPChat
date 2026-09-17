#!/usr/bin/env node
// Verifies .github/actions-lock.json against the workflows: every `uses:` must be pinned to a
// full commit SHA, and that SHA must be the one the lockfile records. A tag like `v7` is mutable
// — the owner can move it — so pinning by tag means a third party can change what runs in CI
// without a commit here. Run by CI.
//
// `node scripts/check-actions-lock.mjs --write` rewrites the lockfile from what the workflows
// currently say. That is the one command to run on a dependabot action bump: dependabot keeps the
// SHA pinning but cannot know about this file, so its pull request fails here until the lockfile
// is regenerated and committed alongside — which is the point, since an action bump is a
// supply-chain change that deserves a look rather than an unattended auto-merge.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS = '.github/workflows';
const LOCK = '.github/actions-lock.json';

const write = process.argv.includes('--write');
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const expected = new Map(lock.actions.map((a) => [a.action, a]));
const seen = new Set();
const found = new Map(); // action -> { sha, usedBy:Set }
const problems = [];

for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(path.join(WORKFLOWS, file), 'utf8');
  for (const [, raw] of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    if (raw.startsWith('./') || raw.startsWith('.\\')) continue; // a local composite action
    const at = raw.lastIndexOf('@');
    if (at === -1) {
      problems.push(`${file}: \`${raw}\` has no ref at all`);
      continue;
    }
    const action = raw.slice(0, at);
    const ref = raw.slice(at + 1);
    seen.add(action);
    if (!found.has(action)) found.set(action, { sha: ref, usedBy: new Set() });
    found.get(action).usedBy.add(file);
    const want = expected.get(action);
    if (!want) {
      problems.push(`${file}: ${action} is not in ${LOCK} — add it with the SHA it should be pinned to`);
      continue;
    }
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      problems.push(`${file}: ${action}@${ref} is not pinned to a commit SHA (expected ${want.sha} # ${want.ref})`);
      continue;
    }
    if (ref !== want.sha) {
      problems.push(`${file}: ${action} is pinned to ${ref}, but ${LOCK} records ${want.sha} (${want.ref})`);
    }
  }
}

for (const action of expected.keys()) {
  if (!seen.has(action)) problems.push(`${LOCK}: ${action} is locked but no workflow uses it`);
}

if (write) {
  // Keep the recorded ref/refType for an action we already know; a new one starts as unknown and
  // wants filling in by hand, so it cannot silently enter the lockfile with no provenance.
  lock.generated = new Date().toISOString().slice(0, 10);
  lock.actions = [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([action, { sha, usedBy }]) => {
      const prev = expected.get(action);
      return {
        action,
        ref: prev?.ref ?? 'UNKNOWN — set this to the tag the SHA came from',
        sha,
        refType: prev?.refType ?? 'tag',
        usedBy: [...usedBy].sort(),
      };
    });
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  console.log(`Rewrote ${LOCK} from the workflows: ${lock.actions.length} actions.`);
  const unknown = lock.actions.filter((a) => a.ref.startsWith('UNKNOWN'));
  if (unknown.length > 0) {
    console.error(`\nSet the ref for: ${unknown.map((a) => a.action).join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

if (problems.length > 0) {
  console.error('Actions lockfile is out of date:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nUpdate ${LOCK} and the workflow together, so a change of action version is a reviewable commit.`);
  process.exit(1);
}

console.log(`Actions lockfile is current: ${expected.size} actions, all pinned by SHA.`);
