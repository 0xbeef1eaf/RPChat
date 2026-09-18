/** The page a blocked navigation lands on: who blocked it and until when, from the stored rule table. */
import { RULES_STORAGE_KEY, readTable } from './lib/rules.js';

async function main(): Promise<void> {
  const id = new URLSearchParams(location.search).get('rule') ?? '';
  const reason = document.getElementById('reason');
  const patterns = document.querySelector('#patterns code');
  let rule;
  try {
    rule = readTable((await chrome.storage.local.get(RULES_STORAGE_KEY))[RULES_STORAGE_KEY]).rules.find((r) => r.id === id);
  } catch {
    rule = undefined;
  }
  if (!reason) return;
  if (!rule) {
    reason.textContent = 'This block has already been lifted — try the page again.';
    return;
  }
  const who = rule.by ? rule.by : 'a character';
  const until = rule.expiresAt ? ` until ${new Date(rule.expiresAt).toLocaleString()}` : '';
  const allowlist = rule.mode === 'allow';
  reason.textContent = allowlist ? `${who} left only a few sites open${until}.` : `Blocked by ${who}${until}.`;
  if (patterns) patterns.textContent = allowlist ? `Open right now: ${rule.patterns.join(', ')}` : rule.patterns.join(', ');
  const why = document.getElementById('why');
  if (why && rule.reason) {
    why.textContent = `“${rule.reason}”`;
    why.hidden = false;
  }
}

void main();
