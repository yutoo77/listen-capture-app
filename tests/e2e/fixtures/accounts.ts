import { readFileSync } from 'node:fs';
import { test as base, type BrowserContext, type Route } from '@playwright/test';
import { createLoginPacer, loginEndpoint } from './login-pacing.mjs';

type Account = { username: string; password: string };
type Accounts = { alice: Account; bob: Account };
let accounts: Record<string, Accounts> | undefined;
const paceLogin = createLoginPacer();

// Explicit extra browser contexts must also use this shared queue. Popups
// inherit their context hook. APIRequestContext logins would need their own hook.
export async function installLoginPacing(context: BrowserContext) {
  const pacedLogin = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await paceLogin(() => route.fallback());
  };
  await context.route(loginEndpoint, pacedLogin);
  return () => context.unroute(loginEndpoint, pacedLogin);
}

// Budgets deliberately survive document deletion. Each scenario therefore gets
// its own server-side identities, retaining the real production quota checks.
// Read only while a test runs, so Playwright --list never needs credentials.
export const test = base.extend<{ isolatedAccounts: void }>({
  isolatedAccounts: [async ({ context }, use, testInfo) => {
    if (testInfo.config.workers !== 1) throw new Error('Shared-IP login pacing requires the configured single E2E worker.');
    // Intercept only initial POST sends; no response rewriting or 429 retry.
    // Context scope also covers popup reauthentication and inline UI logins.
    const removeLoginPacing = await installLoginPacing(context);
    const path = process.env.LC_E2E_ACCOUNTS_FILE;
    if (!path) throw new Error('Run E2E through scripts/run-e2e.py to seed isolated accounts.');
    accounts ??= JSON.parse(readFileSync(path, 'utf8')) as Record<string, Accounts>;
    const pair = accounts[testInfo.testId];
    if (!pair?.alice?.username || !pair.bob?.username || !pair.alice.password || pair.alice.password !== pair.bob.password)
      throw new Error(`Missing isolated account pair for ${testInfo.testId}.`);
    const names = ['LC_E2E_ALICE', 'LC_E2E_BOB', 'LC_E2E_PASSWORD'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.LC_E2E_ALICE = pair.alice.username;
    process.env.LC_E2E_BOB = pair.bob.username;
    process.env.LC_E2E_PASSWORD = pair.alice.password;
    try { await use(); }
    finally {
      await removeLoginPacing();
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  }, { auto: true }],
});

export { expect } from '@playwright/test';
export type { Page, Route } from '@playwright/test';
