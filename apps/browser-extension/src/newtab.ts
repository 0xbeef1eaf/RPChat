/**
 * The new-tab override: go to the home page a character set through the app
 * (`chrome.storage.local.homePage`, http(s) only), else stay on the plain page with the app's name.
 */
import { isNavigableUrl } from './lib/protocol.js';

async function main(): Promise<void> {
  let items: Record<string, unknown> = {};
  try {
    items = await chrome.storage.local.get('homePage');
  } catch {
    /* storage unavailable: stay on the plain page */
  }
  const home = items['homePage'];
  if (isNavigableUrl(home)) location.replace(home as string);
}

void main();
