import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import {
  GROK_SNAPSHOT_SOURCE,
  assertGrokHomeDirectory,
  assertGrokProfileHome,
  fetchGrokUsage,
  grokPeriodScope,
  parseGrokBilling,
} from '../src/adapters/grok.mjs';
import {
  GROK_BILLING_BASE_FALLBACK,
  GROK_EXPIRED_ERROR,
  GROK_SIGN_IN_ERROR,
  billingUrl,
  grokAccess,
  main as probeGrokUsage,
  readGrokCredentials,
  runProbeCli,
} from '../src/adapters/grok-usage-probe.mjs';
import { SIGN_IN_EXPIRED_ERROR_PATTERN, SIGN_IN_REQUIRED_ERROR_PATTERN } from '../src/service.mjs';

// Decision 0035, stage two — the Grok quota probe.
//
// Fixtures only: no network, no real credential, no live port, placeholder
// identities throughout. Every endpoint shape below is modelled on the fields
// recorded in docs/research/grok-xai-feasibility-2026-08-17.md §Unknown 1.

const WEEKLY_PAYLOAD = {
  credit_usage_percent: 59,
  current_period: {
    type: 'USAGE_PERIOD_TYPE_WEEKLY',
    start: '2026-08-17T00:00:00.000Z',
    end: '2026-08-24T00:00:00.000Z',
  },
  subscription_tier: 'SuperGrok Heavy',
  on_demand_cap: 5000,
  on_demand_used: 120,
  prepaid_balance: 0,
  is_unified_billing_user: true,
  history: [],
};

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function grokHome(t, credentials = { oauth: { accessToken: 'placeholder-token' } }) {
  const home = path.join(temporaryRoot(t), 'grok');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (credentials) {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(credentials), { mode: 0o600 });
  }
  return home;
}

// ---------------------------------------------------------------------------
// Endpoint shapes

test('a weekly billing payload becomes one ground-truth snapshot', () => {
  const [snapshot, ...rest] = parseGrokBilling(WEEKLY_PAYLOAD);
  assert.equal(rest.length, 0);
  assert.equal(snapshot.scope, 'weekly');
  assert.equal(snapshot.usedPercent, 59);
  assert.equal(snapshot.resetsAt, '2026-08-24T00:00:00.000Z');
  assert.equal(snapshot.source, GROK_SNAPSHOT_SOURCE);
  assert.equal(snapshot.detail.planType, 'SuperGrok Heavy');
  assert.equal(snapshot.detail.periodType, 'USAGE_PERIOD_TYPE_WEEKLY');
});

test('a monthly billing period is named monthly', () => {
  const [snapshot] = parseGrokBilling({
    ...WEEKLY_PAYLOAD,
    current_period: { ...WEEKLY_PAYLOAD.current_period, type: 'USAGE_PERIOD_TYPE_MONTHLY' },
  });
  assert.equal(snapshot.scope, 'monthly');
});

test('camelCase and a nested billing envelope parse identically', () => {
  const [snapshot] = parseGrokBilling({
    billing: {
      creditUsagePercent: 59,
      currentPeriod: { periodType: 'weekly', endTime: '2026-08-24T00:00:00.000Z' },
      subscriptionTier: 'SuperGrok Heavy',
    },
  });
  assert.equal(snapshot.scope, 'weekly');
  assert.equal(snapshot.usedPercent, 59);
  assert.equal(snapshot.resetsAt, '2026-08-24T00:00:00.000Z');
});

test('an unstated period type is decided by the period length, not a guess', () => {
  assert.equal(grokPeriodScope({ start: '2026-08-01T00:00:00Z', end: '2026-08-08T00:00:00Z' }), 'weekly');
  assert.equal(grokPeriodScope({ start: '2026-08-01T00:00:00Z', end: '2026-08-31T00:00:00Z' }), 'monthly');
});

test('a percent with no period at all keeps an honestly unnamed window', () => {
  const [snapshot] = parseGrokBilling({ credit_usage_percent: 12 });
  assert.equal(snapshot.scope, 'usage period');
  assert.equal(snapshot.resetsAt, null);
  assert.equal(snapshot.usedPercent, 12);
});

test('an over-100 percent is clamped so the card can never show negative % left', () => {
  const [snapshot] = parseGrokBilling({ ...WEEKLY_PAYLOAD, credit_usage_percent: 104.5 });
  assert.equal(snapshot.usedPercent, 100);
});

// ---------------------------------------------------------------------------
// Error / absent cases: the column goes away, never a broken card

test('TRIPWIRE grok-no-percent-no-snapshot — a payload without a percent throws instead of inventing a card', () => {
  for (const payload of [
    {},
    { current_period: WEEKLY_PAYLOAD.current_period },
    { credit_usage_percent: 'not a number' },
    [],
    null,
  ]) {
    assert.throws(() => parseGrokBilling(payload), /did not contain a credit usage percent/);
  }
});

test('empty or unparseable probe output throws rather than yielding a blank card', () => {
  assert.throws(() => parseGrokBilling('   '), /Grok usage output was empty/);
  assert.throws(() => parseGrokBilling('<html>nope</html>'), /Grok usage output was not valid JSON/);
});

test('an absent Grok home is reported, not silently skipped', async (t) => {
  await assert.rejects(
    fetchGrokUsage({ grokHome: path.join(temporaryRoot(t), 'missing') }),
    /Grok profile home does not exist/,
  );
});

test('a profile with no stored credentials asks for a sign-in', async (t) => {
  const home = grokHome(t, null);
  await assert.rejects(fetchGrokUsage({ grokHome: home }), (error) => {
    assert.match(error.message, /does not contain stored credentials/);
    assert.match(error.message, SIGN_IN_REQUIRED_ERROR_PATTERN);
    return true;
  });
});

// The permission rule is scoped to the ATTACK, not to tidiness. Planting a
// credential needs write access to the directory; reading it discloses
// nothing, because the secret is 0600. A stock `~/.grok` is 0755/0600
// (measured on the maintainer's machine), so demanding chmod 700 would
// refuse every stock install while doing nothing about planting.
const WRITABLE_BY_OTHERS = [0o775, 0o757, 0o777, 0o770, 0o707, 0o722];
const NOT_WRITABLE_BY_OTHERS = [0o700, 0o755, 0o750, 0o705, 0o711];

test('TRIPWIRE grok-home-must-not-be-writable — a home others can write is refused at refresh', async (t) => {
  const home = grokHome(t);
  for (const mode of WRITABLE_BY_OTHERS) {
    fs.chmodSync(home, mode);
    await assert.rejects(
      fetchGrokUsage({ grokHome: home }),
      /must not be writable by anyone else \(chmod g-w,o-w/,
      `mode ${mode.toString(8)} must be refused`,
    );
  }
  for (const mode of NOT_WRITABLE_BY_OTHERS) {
    fs.chmodSync(home, mode);
    // Gets past the permission gate and on to the probe itself.
    await assert.rejects(
      fetchGrokUsage({ grokHome: home }),
      /Grok usage refresh failed/,
      `mode ${mode.toString(8)} must be accepted`,
    );
  }
  fs.chmodSync(home, 0o700);
});

// The credential mask is the symmetric half of the directory mask. Refusing a
// writable DIRECTORY only stops a swap that replaces the directory entry; a
// world-writable auth.json inside an ordinary 0755 home is overwritten IN
// PLACE with no directory write at all. Same attack, same rule — and, as with
// the directory, only writability is refused: who may READ the file is the
// grok CLI's choice, not ours.
const CREDENTIAL_WRITABLE_BY_OTHERS = [0o666, 0o664, 0o662, 0o622, 0o606];
const CREDENTIAL_NOT_WRITABLE_BY_OTHERS = [0o600, 0o640, 0o604, 0o644];

test('TRIPWIRE grok-credential-must-not-be-writable — the parent gate masks auth.json too', async (t) => {
  const home = grokHome(t);
  const credential = path.join(home, 'auth.json');
  for (const mode of CREDENTIAL_WRITABLE_BY_OTHERS) {
    fs.chmodSync(credential, mode);
    await assert.rejects(
      assertGrokProfileHome(home),
      /credentials must not be writable by anyone else \(chmod 600/,
      `credential mode ${mode.toString(8)} must be refused`,
    );
    // And the refusal reaches the refresh path, not just the assertion.
    await assert.rejects(fetchGrokUsage({ grokHome: home }), /chmod 600/);
  }
  for (const mode of CREDENTIAL_NOT_WRITABLE_BY_OTHERS) {
    fs.chmodSync(credential, mode);
    await assert.doesNotReject(
      assertGrokProfileHome(home),
      `credential mode ${mode.toString(8)} must be accepted`,
    );
  }
  fs.chmodSync(credential, 0o600);
});

test('TRIPWIRE grok-credential-must-not-be-writable — the child masks auth.json before reading', async (t) => {
  const home = grokHome(t);
  const credential = path.join(home, 'auth.json');
  for (const mode of CREDENTIAL_WRITABLE_BY_OTHERS) {
    fs.chmodSync(credential, mode);
    let fetched = false;
    await assert.rejects(
      probeGrokUsage({
        env: { MODELDECK_GROK_HOME: home },
        stdout: { write: () => {} },
        fetcher: async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' }; },
      }),
      /credentials must not be writable by anyone else \(chmod 600/,
      `credential mode ${mode.toString(8)} must be refused`,
    );
    assert.equal(fetched, false, 'an overwritable credential must never reach the network');
  }
  for (const mode of CREDENTIAL_NOT_WRITABLE_BY_OTHERS) {
    fs.chmodSync(credential, mode);
    await assert.doesNotReject(
      readGrokCredentials({ home }),
      `credential mode ${mode.toString(8)} must be accepted`,
    );
  }
  fs.chmodSync(credential, 0o600);
});

test('TRIPWIRE grok-child-reasserts-the-whole-home — a home renamed aside and substituted is refused', async (t) => {
  const root = temporaryRoot(t);
  const home = path.join(root, 'grok');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ accessToken: 'placeholder-token' }), { mode: 0o600 });
  // The parent's gate passes, and the child is spawned.
  await assert.doesNotReject(assertGrokProfileHome(home));

  // Now the swap: an attacker who can write the home's PARENT renames the
  // real home aside and drops their own directory at the same path. Its
  // auth.json is a perfectly ordinary regular file, so a child that
  // re-checked only the FILE TYPE would read the attacker's token.
  fs.renameSync(home, path.join(root, 'grok-real'));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o777);
  const planted = path.join(home, 'auth.json');
  fs.writeFileSync(planted, JSON.stringify({ accessToken: 'placeholder-attacker-token' }), { mode: 0o600 });
  const credentialStat = fs.lstatSync(planted);
  assert.ok(credentialStat.isFile() && !credentialStat.isSymbolicLink(),
    'the substituted credential must look ordinary — that is the point of the test');

  let fetched = false;
  await assert.rejects(
    probeGrokUsage({
      env: { MODELDECK_GROK_HOME: home },
      stdout: { write: () => {} },
      fetcher: async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' }; },
    }),
    /must not be writable by anyone else/,
  );
  assert.equal(fetched, false, 'a substituted home must never reach the network');
});

test('the stock Grok layout — a 0755 home holding a 0600 credential — is accepted', async (t) => {
  const home = grokHome(t);
  fs.chmodSync(home, 0o755);
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  // Nothing but the current user can write the directory, and the secret is
  // already owner-only, so there is nothing here to refuse.
  await assert.doesNotReject(assertGrokHomeDirectory(home));
  await assert.doesNotReject(assertGrokProfileHome(home));
  fs.chmodSync(home, 0o700);
});

test('TRIPWIRE grok-home-must-not-be-writable — a home others can write is refused at registration', async (t) => {
  const { store, service } = serviceFixture(t, { fetchGrok: async () => [] });
  const profileRef = path.join(temporaryRoot(t), 'grok-home');
  fs.mkdirSync(profileRef, { recursive: true, mode: 0o700 });
  for (const mode of [0o775, 0o757]) {
    fs.chmodSync(profileRef, mode);
    await assert.rejects(
      service.saveAccount({ provider: 'grok', label: 'Studio', profileRef }),
      /must not be writable by anyone else \(chmod g-w,o-w/,
      `mode ${mode.toString(8)} must be refused`,
    );
  }
  assert.equal(store.listAccounts().length, 0, 'a writable home must not be registered at all');
  // The stock layout registers without the user changing anything.
  fs.chmodSync(profileRef, 0o755);
  assert.equal((await service.saveAccount({ provider: 'grok', label: 'Studio', profileRef })).provider, 'grok');
});

test('a symlinked credential file is refused', async (t) => {
  const home = grokHome(t, null);
  fs.symlinkSync(path.join(os.tmpdir(), 'elsewhere.json'), path.join(home, 'auth.json'));
  await assert.rejects(fetchGrokUsage({ grokHome: home }), /must be a regular file/);
});

// ---------------------------------------------------------------------------
// Credential handling (the probe process, never the daemon)

test('stored credentials are read from auth.json in every plausible nesting', async (t) => {
  const home = grokHome(t, { tokens: { access_token: 'placeholder-token', user_id: 'placeholder-user' } });
  const credentials = await readGrokCredentials({ home });
  const access = grokAccess(credentials);
  assert.equal(access.token, 'placeholder-token');
  assert.equal(access.userId, 'placeholder-user');
});

test('an expired credential reports the calm idle-decay reason, not a sign-out', () => {
  assert.throws(
    () => grokAccess({ accessToken: 'placeholder-token', expiresAt: 1 }),
    (error) => {
      assert.equal(error.message, GROK_EXPIRED_ERROR);
      // Both service-layer patterns must agree, or the deck shows the wrong
      // recovery path for an account that only needs to be used again.
      assert.match(error.message, SIGN_IN_REQUIRED_ERROR_PATTERN);
      assert.match(error.message, SIGN_IN_EXPIRED_ERROR_PATTERN);
      return true;
    },
  );
});

test('a credential with no token at all asks for a sign-in', () => {
  assert.throws(() => grokAccess({ oauth: {} }), new RegExp(GROK_SIGN_IN_ERROR));
});

test('unparseable auth.json is a credential problem, not a crash', async (t) => {
  const home = grokHome(t, null);
  fs.writeFileSync(path.join(home, 'auth.json'), '{not json', { mode: 0o600 });
  await assert.rejects(readGrokCredentials({ home }), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// The request itself

test('TRIPWIRE grok-probe-is-a-billing-read — the probe GETs the billing endpoint and sends no prompt', async (t) => {
  const home = grokHome(t, { oauth: { accessToken: 'placeholder-token', userId: 'placeholder-user' } });
  const calls = [];
  let written = '';
  await probeGrokUsage({
    env: { MODELDECK_GROK_HOME: home },
    stdout: { write: (value) => { written += value; } },
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify(WEEKLY_PAYLOAD) };
    },
  });
  assert.equal(calls.length, 1);
  // Decision 0032: metadata only. A billing read spends no quota; an
  // inference request would. This asserts the shape of what we send.
  assert.equal(calls[0].url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer placeholder-token');
  assert.equal(calls[0].options.headers['x-userid'], 'placeholder-user');
  assert.deepEqual(parseGrokBilling(written)[0].usedPercent, 59);
});

test('a 401 or 403 from the billing endpoint asks for a sign-in; other statuses stay transient', async (t) => {
  const home = grokHome(t);
  const run = (status) => probeGrokUsage({
    env: { MODELDECK_GROK_HOME: home },
    stdout: { write: () => {} },
    fetcher: async () => ({ ok: false, status, text: async () => '' }),
  });
  for (const status of [401, 403]) {
    await assert.rejects(run(status), SIGN_IN_REQUIRED_ERROR_PATTERN);
  }
  await assert.rejects(run(503), /provider returned HTTP 503/);
  // A transient failure must NOT look like a sign-out, or the deck sends the
  // user down a re-login path that fixes nothing.
  await assert.rejects(run(503), (error) => {
    assert.doesNotMatch(error.message, SIGN_IN_REQUIRED_ERROR_PATTERN);
    return true;
  });
});

test('TRIPWIRE grok-probe-refuses-redirects — the bearer token never follows a hop to another origin', async (t) => {
  const home = grokHome(t, { oauth: { accessToken: 'placeholder-token', userId: 'placeholder-user' } });
  let options;
  await probeGrokUsage({
    env: { MODELDECK_GROK_HOME: home },
    stdout: { write: () => {} },
    fetcher: async (url, requestOptions) => {
      options = requestOptions;
      return { ok: true, status: 200, text: async () => JSON.stringify(WEEKLY_PAYLOAD) };
    },
  });
  // Following a 3xx would carry Authorization and x-userid to the redirect
  // target and then parse whatever it returned as billing truth.
  assert.equal(options.redirect, 'error');

  // And the belt to that brace: a 3xx that somehow arrives as a response is
  // never read as a payload.
  await assert.rejects(
    probeGrokUsage({
      env: { MODELDECK_GROK_HOME: home },
      stdout: { write: () => { throw new Error('a redirect must never be written as billing truth'); } },
      fetcher: async () => ({ ok: false, status: 302, text: async () => JSON.stringify(WEEKLY_PAYLOAD) }),
    }),
    /provider returned HTTP 302/,
  );
});

test('TRIPWIRE grok-probe-rechecks-the-credential — a symlink swapped in after the parent check is refused', async (t) => {
  const home = grokHome(t, { oauth: { accessToken: 'placeholder-token' } });
  const credentialPath = path.join(home, 'auth.json');
  const elsewhere = path.join(temporaryRoot(t), 'attacker.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ accessToken: 'placeholder-attacker-token' }), { mode: 0o600 });

  // The parent's lstat passed a moment ago; the swap happens now, in the
  // window before the child reads. The child must catch it on its own.
  fs.rmSync(credentialPath);
  fs.symlinkSync(elsewhere, credentialPath);

  let fetched = false;
  await assert.rejects(
    probeGrokUsage({
      env: { MODELDECK_GROK_HOME: home },
      stdout: { write: () => {} },
      fetcher: async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' }; },
    }),
    /must be a regular file/,
  );
  assert.equal(fetched, false, 'a swapped-in credential must never reach the network');
});

test('TRIPWIRE grok-billing-base-requires-tls — a plaintext base is refused before the token is read', async (t) => {
  const home = grokHome(t, { oauth: { accessToken: 'placeholder-token' } });
  let fetched = false;
  let credentialRead = false;
  await assert.rejects(
    probeGrokUsage({
      env: {
        MODELDECK_GROK_HOME: home,
        MODELDECK_GROK_BILLING_BASE: 'http://billing.example.com/v1',
      },
      stdout: { write: () => {} },
      readFile: async (...args) => { credentialRead = true; return fs.promises.readFile(...args); },
      fetcher: async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' }; },
    }),
    /must use https/,
  );
  assert.equal(fetched, false, 'the bearer token must never go out over plaintext');
  assert.equal(credentialRead, false, 'a bad destination must fail before the credential is even read');
});

test('the billing base allows plaintext loopback and nothing else', () => {
  // Fixtures and staging run on loopback, where the request never leaves the
  // machine — that is the one plaintext hop worth allowing.
  for (const base of ['http://127.0.0.1:8123/v1', 'http://localhost:8123/v1', 'http://[::1]:8123/v1']) {
    assert.match(billingUrl(base), /\/billing\?format=credits$/);
  }
  for (const base of ['https://cli-chat-proxy.grok.com/v1', 'https://billing.example.com/v1']) {
    assert.match(billingUrl(base), /^https:\/\//);
  }
  for (const base of [
    'http://billing.example.com/v1',
    'http://127.0.0.1.example.com/v1',
    'http://evil.localhost.example.com/v1',
  ]) {
    assert.throws(() => billingUrl(base), /must use https/);
  }
  assert.throws(() => billingUrl('not a url'), /not a valid URL/);
  // The default is TLS and keeps the exact path the CLI itself calls.
  assert.equal(
    billingUrl(GROK_BILLING_BASE_FALLBACK),
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  );
});

test('every probe failure reaches the parent in one shape', async () => {
  const lines = [];
  const code = await runProbeCli({
    stderr: { write: (value) => lines.push(value) },
    probe: async () => { throw new Error('boom'); },
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['Grok usage probe failed: boom\n']);
});

// ---------------------------------------------------------------------------
// Service: the refresh pass, and only the refresh pass

function serviceFixture(t, { fetchGrok, accounts = [] } = {}) {
  const store = new Store(':memory:');
  store.saveSettings({ autoRefreshEnabled: false });
  const root = temporaryRoot(t);
  const saved = accounts.map((item) => {
    const profileRef = path.join(root, item.label);
    fs.mkdirSync(profileRef, { recursive: true, mode: 0o700 });
    return store.saveAccount({ provider: 'grok', label: item.label, profileRef, ...item.overrides });
  });
  const service = new ModelDeckService(store, {
    fetchGrok,
    fetchClaude: async () => [],
    fetchCodex: async () => [],
  });
  t.after(() => { service.stopAutoRefresh(); store.close(); });
  return { store, service, accounts: saved };
}

test('the store accepts Grok accounts and gives them their own swatch', (t) => {
  const { accounts } = serviceFixture(t, { accounts: [{ label: 'Studio' }] });
  assert.equal(accounts[0].provider, 'grok');
  assert.equal(accounts[0].color, '#6f7ae8');
});

test('a Grok account registers through the service with a caller-supplied home', async (t) => {
  const { service } = serviceFixture(t, { fetchGrok: async () => [] });
  const profileRef = path.join(temporaryRoot(t), 'grok-home');
  fs.mkdirSync(profileRef, { recursive: true, mode: 0o700 });
  // Grok homes belong to the grok CLI, so — unlike Claude and Codex — they
  // are NOT required to live inside a ModelDeck-managed profiles directory.
  const account = await service.saveAccount({ provider: 'grok', label: 'Studio', profileRef });
  assert.equal(account.provider, 'grok');
  // Stored canonicalized, so later comparisons cannot be walked around.
  assert.equal(account.profileRef, fs.realpathSync(profileRef));
});

test('a Grok home is stored canonicalized, symlinks and dot-segments resolved', async (t) => {
  const { service } = serviceFixture(t, { fetchGrok: async () => [] });
  const root = temporaryRoot(t);
  const real = path.join(root, 'grok-home');
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
  const link = path.join(root, 'link-to-grok');
  fs.symlinkSync(real, link);
  const account = await service.saveAccount({
    provider: 'grok',
    label: 'Studio',
    profileRef: path.join(link, '..', 'link-to-grok'),
  });
  assert.equal(account.profileRef, fs.realpathSync(real));
});

test('TRIPWIRE grok-home-is-not-another-providers-home — a Codex home cannot be registered as Grok', async (t) => {
  const { store, service } = serviceFixture(t, { fetchGrok: async () => [] });
  const codexHome = path.join(temporaryRoot(t), 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}', { mode: 0o600 });
  store.saveAccount({ provider: 'codex', label: 'Studio', profileRef: codexHome });

  // Nothing at refresh time can tell these apart: the directory exists, and
  // auth.json is a regular owner-owned file either way. Probing it would send
  // the OpenAI bearer token to xAI's billing endpoint. Registration is the
  // only place that can catch it.
  await assert.rejects(
    service.saveAccount({ provider: 'grok', label: 'Studio', profileRef: codexHome }),
    /already registered as a codex subscription's home/,
  );
  // The same home reached through a symlink is the same home.
  const link = path.join(temporaryRoot(t), 'sneaky');
  fs.symlinkSync(codexHome, link);
  await assert.rejects(
    service.saveAccount({ provider: 'grok', label: 'Studio', profileRef: link }),
    /already registered as a codex subscription's home/,
  );
  assert.equal(store.listAccounts().filter((item) => item.provider === 'grok').length, 0);
});

// ---------------------------------------------------------------------------
// The accounts-table rebuild
//
// Five tables carry six foreign keys onto accounts(id). Two of them CASCADE
// (usage_snapshots, session_model_state) and the rest SET NULL, which makes
// the rebuild's two real hazards:
//
//   (a) dropping the old table with foreign_keys ENFORCEMENT ON silently
//       deletes every cascade child and blanks every set-null reference;
//   (b) copying a fixed column list bricks databases old enough to predate
//       the identity/purpose columns.
//
// A hand-written accounts table has no children, so it cannot catch (a) — the
// fixture below stands up the REAL schema and downgrades `accounts` back to
// the pre-0035 shape, so both hazards are live.

/// Rows planted in every child table, keyed to the accounts they reference.
const CHILD_ROWS = `
  INSERT INTO usage_snapshots(account_id, scope, used_percent, observed_at, source)
    VALUES ('a1', 'week', 37, '2026-08-01T00:00:00.000Z', 'claude-oauth-api'),
           ('a1', '5h', 12, '2026-08-01T00:00:00.000Z', 'claude-oauth-api'),
           ('a2', 'week', 51, '2026-08-01T00:00:00.000Z', 'codex-app-server');
  INSERT INTO session_model_state(account_id, session_id, model, observed_at)
    VALUES ('a1', 'placeholder-session', 'placeholder-model', '2026-08-01T00:00:00.000Z');
  INSERT INTO projects(id, name, path, claude_account_id, codex_account_id, created_at, updated_at)
    VALUES ('p1', 'placeholder', '/tmp/placeholder-project', 'a1', 'a2',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  INSERT INTO launch_events(account_id, provider, command_preview, launched_at)
    VALUES ('a1', 'claude', 'placeholder', '2026-08-01T00:00:00.000Z');
`;

const LEGACY_COLUMNS_FULL = [
  'id', 'provider', 'label', 'identity', 'purpose', 'profile_ref', 'color',
  'enabled', 'is_default', 'metadata_json', 'created_at', 'updated_at',
];
// The genuinely ancient shape: no identity, no purpose.
const LEGACY_COLUMNS_PRE_IDENTITY = LEGACY_COLUMNS_FULL
  .filter((column) => column !== 'identity' && column !== 'purpose');

function legacyDatabase(t, { preIdentity = false } = {}) {
  const dbPath = path.join(temporaryRoot(t), 'legacy.sqlite');
  const seed = new Store(dbPath);
  seed.db.exec(`
    INSERT INTO accounts(id, provider, label, profile_ref, is_default, created_at, updated_at)
      VALUES ('a1', 'claude', 'Studio', '/tmp/placeholder-claude', 1,
              '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
             ('a2', 'codex', 'Studio', '/tmp/placeholder-codex', 1,
              '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    ${CHILD_ROWS}
  `);
  seed.close();

  // Downgrade `accounts` to the pre-0035 CHECK, leaving every other table —
  // and every child row — exactly as the real schema built it.
  const columns = (preIdentity ? LEGACY_COLUMNS_PRE_IDENTITY : LEGACY_COLUMNS_FULL).join(', ');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec('PRAGMA foreign_keys = OFF');
  legacy.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE accounts_legacy (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
      label TEXT NOT NULL,
      ${preIdentity ? '' : `identity TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',`}
      profile_ref TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6f7bf7',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, profile_ref)
    );
    INSERT INTO accounts_legacy(${columns}) SELECT ${columns} FROM accounts;
    DROP TABLE accounts;
    ALTER TABLE accounts_legacy RENAME TO accounts;
    CREATE UNIQUE INDEX one_default_per_provider ON accounts(provider) WHERE is_default = 1;
    COMMIT;
  `);
  const recorded = legacy.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
  ).get().sql;
  assert.ok(!recorded.includes("'grok'"), 'fixture must start at the pre-0035 shape');
  assert.equal(recorded.includes('identity'), !preIdentity);
  legacy.close();
  return dbPath;
}

function childCounts(store) {
  const count = (sql) => Number(store.db.prepare(sql).get().count);
  return {
    // ON DELETE CASCADE — these vanish if the drop runs with enforcement on.
    usageSnapshots: count('SELECT COUNT(*) AS count FROM usage_snapshots'),
    sessionModelState: count('SELECT COUNT(*) AS count FROM session_model_state'),
    // ON DELETE SET NULL — these survive but get blanked.
    projectsLinked: count(
      'SELECT COUNT(*) AS count FROM projects WHERE claude_account_id IS NOT NULL AND codex_account_id IS NOT NULL',
    ),
    launchEventsLinked: count('SELECT COUNT(*) AS count FROM launch_events WHERE account_id IS NOT NULL'),
  };
}

const EXPECTED_CHILDREN = {
  usageSnapshots: 3,
  sessionModelState: 1,
  projectsLinked: 1,
  launchEventsLinked: 1,
};

test('TRIPWIRE grok-accounts-schema-migration — the rebuild keeps every cascade child and set-null reference', (t) => {
  const dbPath = legacyDatabase(t);
  const store = new Store(dbPath);
  t.after(() => { try { store.close(); } catch { /* closed by the test */ } });

  // Hazard (a): with foreign_keys left ON, DROP TABLE accounts cascades and
  // these counts collapse to zero / null out.
  assert.deepEqual(childCounts(store), EXPECTED_CHILDREN);
  // And nothing was orphaned in the other direction either.
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);

  const kept = store.getAccount('a1');
  assert.equal(kept.label, 'Studio');
  assert.equal(kept.isDefault, true);
  assert.equal(kept.createdAt, '2026-08-01T00:00:00.000Z');
  assert.equal(store.listAccounts().length, 2);

  // The point of the whole rebuild.
  assert.equal(store.saveAccount({ provider: 'grok', label: 'Studio', profileRef: '/tmp/placeholder-grok' }).provider, 'grok');
  // The one-default-per-provider index survived it.
  assert.throws(
    () => store.db.exec(
      "INSERT INTO accounts(id, provider, label, profile_ref, is_default, created_at, updated_at)"
      + " VALUES ('a4','claude','Other','/tmp/placeholder-claude-2',1,'x','x')",
    ),
    /UNIQUE constraint failed/,
  );
});

test('TRIPWIRE grok-accounts-schema-migration — a pre-identity database migrates instead of erroring', (t) => {
  // Hazard (b): a fixed copy list references columns this database has never
  // had, and the Store constructor throws before anything can open it.
  const dbPath = legacyDatabase(t, { preIdentity: true });
  const store = new Store(dbPath);
  t.after(() => store.close());

  assert.deepEqual(childCounts(store), EXPECTED_CHILDREN);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  const kept = store.getAccount('a1');
  assert.equal(kept.label, 'Studio');
  // The columns this database never had arrive at their defaults, not as null.
  assert.equal(kept.identity, '');
  assert.equal(kept.purpose, '');
  assert.equal(store.saveAccount({ provider: 'grok', label: 'Studio', profileRef: '/tmp/placeholder-grok' }).provider, 'grok');
});

test('re-opening a migrated database is a no-op', (t) => {
  const dbPath = legacyDatabase(t);
  const first = new Store(dbPath);
  first.saveAccount({ provider: 'grok', label: 'Studio', profileRef: '/tmp/placeholder-grok' });
  first.close();

  const reopened = new Store(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.listAccounts().length, 3);
  assert.deepEqual(childCounts(reopened), EXPECTED_CHILDREN);
  assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a Grok refresh records the same usage snapshots every other provider records', async (t) => {
  const { store, service, accounts } = serviceFixture(t, {
    accounts: [{ label: 'Studio' }],
    fetchGrok: async () => parseGrokBilling(WEEKLY_PAYLOAD),
  });
  const results = await service.refreshGrok();
  assert.deepEqual(results.map((item) => item.ok), [true]);
  const usage = store.state().usage.filter((row) => row.accountId === accounts[0].id);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].scope, 'weekly');
  assert.equal(usage[0].remainingPercent, 41);
  assert.equal(usage[0].source, GROK_SNAPSHOT_SOURCE);
});

test('a failed Grok probe is remembered per account and never throws the pass', async (t) => {
  const { service, accounts } = serviceFixture(t, {
    accounts: [{ label: 'Studio' }, { label: 'Personal' }],
    fetchGrok: async ({ grokHome }) => {
      if (grokHome.endsWith('Personal')) throw new Error(GROK_SIGN_IN_ERROR);
      return parseGrokBilling(WEEKLY_PAYLOAD);
    },
  });
  const results = await service.refreshGrok();
  const personal = results.find((item) => item.accountId === accounts[1].id);
  assert.equal(personal.ok, false);
  assert.match(personal.error, SIGN_IN_REQUIRED_ERROR_PATTERN);
  const state = await service.state();
  const row = state.accounts.find((item) => item.id === accounts[1].id);
  assert.equal(row.authState, 'signin-required');
});

test('TRIPWIRE grok-refresh-rides-the-existing-pass — Grok is probed once per refreshAll, never on a timer of its own', async (t) => {
  let calls = 0;
  const { service } = serviceFixture(t, {
    accounts: [{ label: 'Studio' }],
    fetchGrok: async () => { calls += 1; return parseGrokBilling(WEEKLY_PAYLOAD); },
  });
  // No scheduler is started here, so nothing may probe on its own.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0, 'Grok must never poll outside the approved refresh pass');
  const result = await service.refreshAll();
  assert.equal(calls, 1);
  assert.equal(result.grok.ok, true);
  await service.refreshAll();
  assert.equal(calls, 2);
});

test('an install with no Grok accounts reports nothing for Grok', async (t) => {
  const { service } = serviceFixture(t, { fetchGrok: async () => { throw new Error('never called'); } });
  const result = await service.refreshAll();
  assert.equal(result.grok, null);
  assert.equal(result.claude.ok, true);
  assert.equal(result.codex.ok, true);
});

test('a Grok failure cannot change what the other two providers report', async (t) => {
  const { service } = serviceFixture(t, {
    accounts: [{ label: 'Studio' }],
    fetchGrok: async () => { throw new Error('provider returned HTTP 503'); },
  });
  const result = await service.refreshAll();
  assert.equal(result.claude.ok, true);
  assert.equal(result.codex.ok, true);
  assert.equal(result.grok.ok, false);
});

test('TRIPWIRE grok-counts-as-an-active-session — the pause/cap discipline sees grok processes', async (t) => {
  const store = new Store(':memory:');
  store.saveSettings({ autoRefreshEnabled: false });
  const service = new ModelDeckService(store, {
    exec: async () => ({ stdout: '/opt/homebrew/bin/grok\n/usr/bin/vim\n/usr/local/bin/codex\n' }),
  });
  t.after(() => { service.stopAutoRefresh(); store.close(); });
  assert.deepEqual((await service.listProviderProcesses()).sort(), ['codex', 'grok']);
});

// ---------------------------------------------------------------------------
// Public issue #9 — the REAL file and endpoint shapes, as reported by two
// users against the current Grok Build CLI (keys real, values placeholders).
// Everything above this line was written against guessed shapes; these two
// tests pin the observed ones so the probe can never regress to "sign in"
// against a freshly logged-in CLI.

const REAL_AUTH_JSON = {
  'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
    key: 'placeholder-jwt',
    auth_mode: 'oidc',
    user_id: 'placeholder-user',
    email: 'placeholder@example.invalid',
    refresh_token: 'placeholder-refresh',
    expires_at: '2999-01-01T00:00:00.000000Z',
  },
};

test('TRIPWIRE grok-real-auth-shape — the issuer::client-id entry with the token under `key` is read', async (t) => {
  const home = grokHome(t, REAL_AUTH_JSON);
  const access = grokAccess(await readGrokCredentials({ home }));
  assert.equal(access.token, 'placeholder-jwt');
  assert.equal(access.userId, 'placeholder-user');
  assert.equal(access.expiresAt, Date.parse('2999-01-01T00:00:00.000000Z'));
});

test('an ISO expires_at in the past on the real shape reports expiry, not a sign-out', () => {
  const expired = structuredClone(REAL_AUTH_JSON);
  Object.values(expired)[0].expires_at = '2020-01-01T00:00:00Z';
  assert.throws(() => grokAccess(expired), new RegExp(GROK_EXPIRED_ERROR));
});

test('TRIPWIRE grok-real-billing-shape — the percent and period nested under `config` parse', () => {
  const [snapshot] = parseGrokBilling({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-09-14T00:00:00.000Z',
        end: '2026-09-21T00:00:00.000Z',
      },
      creditUsagePercent: 5.0,
    },
  });
  assert.equal(snapshot.scope, 'weekly');
  assert.equal(snapshot.usedPercent, 5);
  assert.equal(snapshot.resetsAt, '2026-09-21T00:00:00.000Z');
});

test('an empty config envelope beside a billing envelope does not shadow it (CodeRabbit, PR #671)', () => {
  const [snapshot] = parseGrokBilling({ config: {}, billing: { creditUsagePercent: 5 } });
  assert.equal(snapshot.usedPercent, 5);
});
