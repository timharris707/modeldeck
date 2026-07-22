import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateClaudeProfile,
  claudePinnedEnvFileContent,
  claudeProfileEnv,
  createClaudeProfileHome,
  fetchClaudeUsage,
  importClaudeSwapProfiles,
  parseClaudeUsage,
  validateClaudeProfileHome,
} from '../src/adapters/claude.mjs';
import {
  createCodexProfileHome,
  parseCodexRateLimits,
  readCodexLoginStatus,
  readCodexPlan,
  validateCodexProfileHome,
} from '../src/adapters/codex.mjs';
import {
  extractClaudeSubscriptionType,
  readClaudeAuthStatus,
  readClaudeRateLimitTier,
  readClaudeProfileIdentity,
} from '../src/adapters/claude.mjs';
import { claudeCredentialServiceName, claudeCredentialsPresent } from '../src/adapters/claude-keychain.mjs';
import { readClaudeCredentials, runProbeCli, KEYCHAIN_DENIED_ERROR } from '../src/adapters/claude-usage-probe.mjs';
import { extractIdentity } from '../src/adapters/identity.mjs';
import { createProviderProfileHelpers } from '../src/adapters/provider-profile.mjs';

const claudeUsageFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/claude-usage.json', import.meta.url), 'utf8'));
const claudeCredentialsFixture = fs.readFileSync(new URL('./fixtures/claude-credentials.json', import.meta.url), 'utf8');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-claude-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('parses native Claude standard and model-scoped usage windows', () => {
  const parsed = parseClaudeUsage(claudeUsageFixture);
  assert.deepEqual(parsed.map((row) => [row.scope, row.usedPercent]), [
    ['Opus weekly', 96],
    ['5-hour', 25],
    ['weekly', 40],
    ['Fable weekly', 61],
  ]);
  assert.equal(parsed[0].resetsAt, '2026-07-23T00:59:59.000Z');
  assert.equal(parsed[1].resetsAt, '2026-07-19T20:00:00.000Z');
  assert.ok(parsed.every((row) => row.source === 'claude-oauth-api'));
});

test('parses serialized Claude JSON and rejects output without usage', () => {
  assert.equal(parseClaudeUsage(JSON.stringify(claudeUsageFixture))[2].scope, 'weekly');
  assert.throws(() => parseClaudeUsage('Signed in successfully'), /not valid JSON/);
});

// Issue #28: the `limits` array shape — kind-tagged session / weekly_all /
// model-scoped weekly_scoped entries (model from scope.model.display_name,
// never hardcoded) — parses into first-class snapshots; spend flows through
// as a scope the evaluators then deprioritize.
test('parses the limits-array payload including model-scoped weekly entries', () => {
  const parsed = parseClaudeUsage({
    limits: [
      { kind: 'session', group: 'session', percent: 29, resets_at: '2026-07-19T20:00:00Z', is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 49, resets_at: '2026-07-25T20:00:00Z', is_active: true },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 96,
        severity: 'critical',
        resets_at: '2026-07-23T00:59:59Z',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: true,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 12,
        resets_at: '2026-07-23T00:59:59Z',
        scope: { model: { id: null, display_name: 'Haiku' }, surface: null },
        is_active: true,
      },
      { kind: 'spend', group: 'spend', percent: 100, resets_at: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 50, scope: { model: null }, is_active: true },
    ],
  });
  assert.deepEqual(parsed.map((row) => [row.scope, row.usedPercent]), [
    ['5-hour', 29],
    ['weekly', 49],
    ['Fable weekly', 96],
    ['Haiku weekly', 12],
    ['spend', 100],
  ]);
  assert.equal(parsed[2].resetsAt, '2026-07-23T00:59:59.000Z');
  assert.ok(parsed.every((row) => row.source === 'claude-oauth-api'));
});

// Issue #26 (Claude half): plan facts come from output already in hand.
test('extracts subscription type from auth status JSON output', () => {
  assert.equal(extractClaudeSubscriptionType(JSON.stringify({ subscriptionType: 'max' })), 'max');
  assert.equal(extractClaudeSubscriptionType(JSON.stringify({ account: { subscription_type: 'pro' } })), 'pro');
  assert.equal(extractClaudeSubscriptionType('Signed in successfully'), null);
  assert.equal(extractClaudeSubscriptionType(''), null);
});

test('reads the organization rate-limit tier from the profile .claude.json', async (t) => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  assert.equal(await readClaudeRateLimitTier({ claudeConfigDir: profile }), null); // absent file
  fs.writeFileSync(path.join(profile, '.claude.json'), 'not json', { mode: 0o600 });
  assert.equal(await readClaudeRateLimitTier({ claudeConfigDir: profile }), null); // bad JSON
  fs.writeFileSync(path.join(profile, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x' },
  }), { mode: 0o600 });
  assert.equal(await readClaudeRateLimitTier({ claudeConfigDir: profile }), 'default_claude_max_20x');
});

test('reads normalized Claude identity facts from the credential-free profile file', async (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'User@Example.com', accountUuid: 'account-placeholder' },
  }));
  assert.deepEqual(await readClaudeProfileIdentity({ claudeConfigDir: root }), {
    identity: 'user@example.com', accountUuid: 'account-placeholder',
  });
  assert.equal(await readClaudeProfileIdentity({ claudeConfigDir: path.join(root, 'missing') }), null);
});

test('claude auth status captures the plan without extra provider calls', async (t) => {
  const root = temporaryRoot(t);
  const profilesDir = path.join(root, 'claude-profiles');
  fs.mkdirSync(profilesDir, { mode: 0o700 });
  const profileRef = path.join(profilesDir, 'work');
  fs.mkdirSync(profileRef, { mode: 0o700 });
  fs.writeFileSync(path.join(profileRef, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x' },
  }), { mode: 0o600 });
  const calls = [];
  const status = await readClaudeAuthStatus({
    claudeConfigDir: profileRef,
    profilesDir,
    run: async (binary, args, options) => {
      calls.push({ binary, args, env: options.env });
      return { stdout: JSON.stringify({ email: 'user@example.invalid', subscriptionType: 'max' }), stderr: '' };
    },
  });
  assert.equal(calls.length, 1, 'one status invocation only');
  assert.deepEqual(status, {
    authenticated: true,
    identity: 'user@example.invalid',
    plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  });
});

test('refreshes only with OAuth credentials stored in the selected profile home', async (t) => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'approved');
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'fixture-oauth-token', expiresAt: Date.now() + 60_000 },
  }), { mode: 0o600 });
  let invocation;
  const snapshots = await fetchClaudeUsage({
    claudeConfigDir: profile,
    run: async (...args) => {
      invocation = args;
      return { stdout: JSON.stringify(claudeUsageFixture) };
    },
  });
  assert.equal(snapshots.length, 4);
  assert.equal(invocation[0], process.execPath);
  assert.match(invocation[1][0], /claude-usage-probe\.mjs$/);
  assert.equal(invocation[2].env.CLAUDE_CONFIG_DIR, profile);
  assert.equal(invocation[2].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(invocation[2].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(invocation[2].env.MODELDECK_MUTATION_TOKEN, undefined);
});

test('derives Claude Keychain service names from the exact config directory path', () => {
  assert.equal(
    claudeCredentialServiceName('/profiles/selected', '/Users/fixture'),
    'Claude Code-credentials-d2719532',
  );
  assert.equal(
    claudeCredentialServiceName('/Users/fixture/.claude', '/Users/fixture'),
    'Claude Code-credentials',
  );
});

test('Claude credential presence checks Keychain metadata then legacy file fallback', async () => {
  const keychainCalls = [];
  const keychainHit = await claudeCredentialsPresent({
    claudeConfigDir: '/profiles/selected',
    platform: 'darwin',
    homeDirectory: '/Users/fixture',
    userInfo: () => ({ username: 'fixture-user' }),
    runSecurity: async (...args) => { keychainCalls.push(args); },
    lstat: async () => { throw new Error('legacy file must not be checked'); },
  });
  assert.equal(keychainHit, true);
  assert.deepEqual(keychainCalls[0][1], [
    'find-generic-password', '-s', 'Claude Code-credentials-d2719532',
    '-a', 'fixture-user',
  ]);
  assert.deepEqual(keychainCalls[0][2].env, { USER: 'fixture-user' });
  assert.ok(!keychainCalls[0][1].includes('-w'));

  const legacyHit = await claudeCredentialsPresent({
    claudeConfigDir: '/profiles/selected',
    platform: 'darwin',
    userInfo: () => ({ username: 'fixture-user' }),
    runSecurity: async () => { throw new Error('not found'); },
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
  });
  assert.equal(legacyHit, true);

  const bothMiss = await claudeCredentialsPresent({
    claudeConfigDir: '/profiles/selected',
    platform: 'darwin',
    userInfo: () => ({ username: 'fixture-user' }),
    runSecurity: async () => { throw new Error('not found'); },
    lstat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  assert.equal(bothMiss, false);
});

test('usage credentials fall back to an injected macOS Keychain lookup', async () => {
  const calls = [];
  const credentials = await readClaudeCredentials({
    profile: '/profiles/selected',
    platform: 'darwin',
    homeDirectory: '/Users/fixture',
    userInfo: () => ({ username: 'fixture-user' }),
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    runSecurity: async (...args) => {
      calls.push(args);
      return { stdout: claudeCredentialsFixture };
    },
  });

  assert.equal(credentials.account.email, 'user@example.invalid');
  assert.deepEqual(calls[0][0], '/usr/bin/security');
  assert.deepEqual(calls[0][1], [
    'find-generic-password', '-s', 'Claude Code-credentials-d2719532',
    '-a', 'fixture-user', '-w',
  ]);
});

test('usage credential lookup keeps file fast path and Keychain failures secret', async () => {
  let keychainCalls = 0;
  const fromFile = await readClaudeCredentials({
    profile: '/profiles/selected',
    platform: 'darwin',
    readFile: async () => claudeCredentialsFixture,
    runSecurity: async () => { keychainCalls += 1; throw new Error('must not run'); },
  });
  assert.equal(fromFile.account.email, 'user@example.invalid');
  assert.equal(keychainCalls, 0);

  const secret = 'must-never-appear';
  await assert.rejects(readClaudeCredentials({
    profile: '/profiles/selected',
    platform: 'darwin',
    userInfo: () => ({ username: 'fixture-user' }),
    readFile: async () => { throw new Error('unreadable'); },
    runSecurity: async () => {
      const error = new Error(secret);
      error.stdout = secret;
      error.stderr = secret;
      throw error;
    },
  }), (error) => {
    assert.match(error.message, /sign in explicitly before refreshing/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('denied Keychain value read with an existing item reports the Always Allow recovery, not sign-in (issue #98)', async () => {
  const calls = [];
  const secret = 'must-never-appear';
  await assert.rejects(readClaudeCredentials({
    profile: '/profiles/selected',
    platform: 'darwin',
    homeDirectory: '/Users/fixture',
    userInfo: () => ({ username: 'fixture-user' }),
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    runSecurity: async (binary, args) => {
      calls.push(args);
      if (args.includes('-w')) {
        // The dismissed-prompt shape: value read refused by macOS.
        const error = new Error(secret);
        error.stdout = secret;
        error.stderr = secret;
        throw error;
      }
      // Metadata lookup (no ACL gate) still sees the item.
      return { stdout: 'keychain: "/Users/fixture/Library/Keychains/login.keychain-db"' };
    },
  }), (error) => {
    assert.equal(error.message, KEYCHAIN_DENIED_ERROR);
    // The recovery message must never route users to a pointless re-login…
    assert.doesNotMatch(error.message, /sign in explicitly before refreshing/);
    // …and Keychain output stays secret on this path too.
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  // Value read first (with -w), then the metadata-only existence probe.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [
    'find-generic-password', '-s', 'Claude Code-credentials-d2719532',
    '-a', 'fixture-user', '-w',
  ]);
  assert.deepEqual(calls[1], [
    'find-generic-password', '-s', 'Claude Code-credentials-d2719532',
    '-a', 'fixture-user',
  ]);
});

test('missing Keychain item still reports the sign-in state (issue #98)', async () => {
  await assert.rejects(readClaudeCredentials({
    profile: '/profiles/selected',
    platform: 'darwin',
    userInfo: () => ({ username: 'fixture-user' }),
    readFile: async () => { throw new Error('unreadable'); },
    runSecurity: async () => { throw new Error('item not found'); },
  }), (error) => {
    assert.match(error.message, /sign in explicitly before refreshing/);
    assert.doesNotMatch(error.message, /Keychain blocked/);
    return true;
  });
});

test('readable but unparseable Keychain value is a credential problem, never keychain-denied (issue #98)', async () => {
  let metadataProbes = 0;
  await assert.rejects(readClaudeCredentials({
    profile: '/profiles/selected',
    platform: 'darwin',
    userInfo: () => ({ username: 'fixture-user' }),
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    runSecurity: async (binary, args) => {
      if (!args.includes('-w')) metadataProbes += 1;
      return { stdout: 'not json at all' };
    },
  }), /sign in explicitly before refreshing/);
  assert.equal(metadataProbes, 0);
});

// Issue #114: the SEA daemon dispatches the probe through src/server.mjs's
// main(); a probe failure that fell through to the generic entry catch was
// stamped "ModelDeck failed to start:", which read as a daemon crash in
// every recorded per-account refresh error on Tim's machine. Both launch
// modes now share runProbeCli, so the error shape is identical everywhere.
test('probe CLI failure keeps the probe error prefix, never a daemon-start shape (issue #114)', async () => {
  const written = [];
  const code = await runProbeCli({
    stderr: { write: (chunk) => written.push(chunk) },
    probe: async () => { throw new Error('stored OAuth credentials have expired; sign in explicitly before refreshing'); },
  });
  assert.equal(code, 1);
  assert.equal(written.length, 1);
  assert.match(written[0], /^Claude usage probe failed: stored OAuth credentials have expired/);
  assert.doesNotMatch(written[0], /failed to start/i);
});

test('probe CLI success writes nothing to stderr and exits 0 (issue #114)', async () => {
  const written = [];
  const code = await runProbeCli({
    stderr: { write: (chunk) => written.push(chunk) },
    probe: async () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(written, []);
});

test('probe CLI keeps the keychain-denied phrase intact for the service-layer pattern (issue #114)', async () => {
  const written = [];
  await runProbeCli({
    stderr: { write: (chunk) => written.push(chunk) },
    probe: async () => { throw new Error(KEYCHAIN_DENIED_ERROR); },
  });
  // KEYCHAIN_DENIED_ERROR_PATTERN (src/service.mjs) must still match after
  // the CLI wrapping, whichever launch mode produced it.
  assert.match(written[0], /keychain blocked modeldeck/i);
});

test('darwin usage refresh lets the isolated probe resolve an absent credential file', async (t) => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'keychain-backed');
  fs.mkdirSync(profile, { mode: 0o700 });
  let invocation;
  const snapshots = await fetchClaudeUsage({
    claudeConfigDir: profile,
    platform: 'darwin',
    run: async (...args) => {
      invocation = args;
      return { stdout: JSON.stringify(claudeUsageFixture) };
    },
  });
  assert.equal(snapshots.length, 4);
  assert.match(invocation[1][0], /claude-usage-probe\.mjs$/);

  const unreadableSnapshots = await fetchClaudeUsage({
    claudeConfigDir: profile,
    platform: 'darwin',
    lstat: async () => { const error = new Error('unreadable'); error.code = 'EACCES'; throw error; },
    run: async () => ({ stdout: JSON.stringify(claudeUsageFixture) }),
  });
  assert.equal(unreadableSnapshots.length, 4);

  await assert.rejects(fetchClaudeUsage({
    claudeConfigDir: profile,
    platform: 'linux',
    run: async () => { throw new Error('must not spawn'); },
  }), /sign in explicitly before refreshing/);
});

test('darwin usage refresh still rejects a present credential symlink before spawning', async (t) => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'selected');
  const outside = path.join(root, 'outside-credentials.json');
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(outside, claudeCredentialsFixture, { mode: 0o600 });
  fs.symlinkSync(outside, path.join(profile, '.credentials.json'));
  let spawned = 0;
  await assert.rejects(fetchClaudeUsage({
    claudeConfigDir: profile,
    platform: 'darwin',
    run: async () => { spawned += 1; return { stdout: JSON.stringify(claudeUsageFixture) }; },
  }), /regular file inside the selected profile home/);
  assert.equal(spawned, 0);
});

test('Claude usage probe environment is an explicit allowlist', () => {
  const env = claudeProfileEnv('/profiles/selected', {
    HOME: '/Users/fixture',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'must-not-pass',
    CLAUDE_CODE_OAUTH_TOKEN: 'must-not-pass',
    MODELDECK_MUTATION_TOKEN: 'must-not-pass',
  });
  assert.deepEqual(env, {
    HOME: '/Users/fixture',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: '/profiles/selected',
    // Issue #66: the secure-storage scope always equals the config dir so
    // storage and credential scope can never point at different profiles.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/profiles/selected',
  });
});

test('Claude probe env pins the secure-storage scope even over an ambient value', () => {
  const env = claudeProfileEnv('/profiles/selected', {
    HOME: '/Users/fixture',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/profiles/other',
  });
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/profiles/selected');
});

test('pinned env file exports both variables with one identical quoted path', () => {
  const content = claudePinnedEnvFileContent("/profiles/o'brien");
  const lines = content.split('\n');
  const expected = `'/profiles/o'\\''brien'`;
  assert.ok(lines.includes(`export CLAUDE_CONFIG_DIR=${expected}`));
  assert.ok(lines.includes(`export CLAUDE_SECURESTORAGE_CONFIG_DIR=${expected}`));
  // Both vars must carry the exact same string (issue #66 spike caveat).
  const values = lines.filter((line) => line.startsWith('export ')).map((line) => line.split('=').slice(1).join('='));
  assert.equal(values.length, 2);
  assert.equal(values[0], values[1]);
  assert.ok(content.endsWith('\n'));
  assert.throws(() => claudePinnedEnvFileContent(), /real path is required/);
});

test('shared profile helpers preserve provider-specific required and invalid-name errors', async (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => claudeProfileEnv(), { message: 'CLAUDE_CONFIG_DIR is required' });
  await assert.rejects(createClaudeProfileHome(), { message: 'ModelDeck Claude profiles directory is required' });
  await assert.rejects(createCodexProfileHome(), { message: 'ModelDeck Codex profiles directory is required' });
  await assert.rejects(createClaudeProfileHome({ profilesDir: path.join(root, 'claude'), profileName: '..' }), {
    message: 'migration profile name is invalid',
  });
  await assert.rejects(createCodexProfileHome({ profilesDir: path.join(root, 'codex'), profileName: '..' }), {
    message: 'profile name is invalid',
  });
});

test('shared owner-only assertion retains its injectable stat seam', async () => {
  const calls = [];
  const helpers = createProviderProfileHelpers({ profileHomeLabel: 'Fixture profile home' });
  await helpers.assertOwnerOnlyDirectory('/profiles/fixture', undefined, async (directory) => {
    calls.push(directory);
    return {
      isDirectory: () => true,
      mode: 0o40700,
      uid: process.getuid?.(),
    };
  });
  assert.deepEqual(calls, ['/profiles/fixture']);
});

test('usage refresh never logs in or falls back to ambient credentials', async (t) => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'unsigned');
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, '.credentials.json'), '{}', { mode: 0o600 });
  await assert.rejects(fetchClaudeUsage({
    claudeConfigDir: profile,
  }), /sign in explicitly before refreshing/);
});

test('atomically activates Claude profiles and refuses to clobber real data', async (t) => {
  const root = temporaryRoot(t);
  const first = path.join(root, 'profiles', 'first');
  const second = path.join(root, 'profiles', 'second');
  const active = path.join(root, 'active', '.claude');
  fs.mkdirSync(first, { recursive: true, mode: 0o700 });
  fs.mkdirSync(second, { recursive: true, mode: 0o700 });

  await activateClaudeProfile({ profileRef: first, activeLink: active });
  assert.equal(fs.readlinkSync(active), fs.realpathSync(first));
  await activateClaudeProfile({ profileRef: second, activeLink: active });
  assert.equal(fs.readlinkSync(active), fs.realpathSync(second));

  fs.unlinkSync(active);
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, 'settings.json'), '{}');
  await assert.rejects(activateClaudeProfile({ profileRef: first, activeLink: active }), (error) => {
    assert.equal(error.code, 'active-link-blocked');
    assert.match(error.message, /one-time migration/);
    assert.match(error.message, /move the existing directory aside at a quiet moment/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(active, 'settings.json'), 'utf8'), '{}');
});

test('creates owner-only Claude profile homes below the ModelDeck profiles directory', async (t) => {
  const root = temporaryRoot(t);
  const profilesDir = path.join(root, 'Application Support', 'ModelDeck', 'claude-profiles');
  const profileRef = await createClaudeProfileHome({ profilesDir, profileName: 'Work Profile' });
  assert.equal(profileRef, path.join(fs.realpathSync(profilesDir), 'work-profile'));
  assert.equal(fs.statSync(profileRef).mode & 0o777, 0o700);
  assert.equal(fs.statSync(profilesDir).mode & 0o777, 0o700);
  assert.equal(await validateClaudeProfileHome({ profileRef, profilesDir }), profileRef);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  await assert.rejects(validateClaudeProfileHome({ profileRef: outside, profilesDir }), {
    message: `Claude profile home must be inside ModelDeck's profiles directory: ${fs.realpathSync(profilesDir)}`,
  });
  await assert.rejects(createClaudeProfileHome({ profilesDir, profileName: 'Work Profile' }), {
    message: `Claude profile destination already exists: ${profileRef}`,
  });
});

test('imports only explicitly selected cswap profile homes into owner-only native homes', async (t) => {
  const root = temporaryRoot(t);
  const sourceRoot = path.join(root, 'cswap');
  const selected = path.join(sourceRoot, 'selected');
  const unselected = path.join(sourceRoot, 'unselected');
  const profilesDir = path.join(root, 'Application Support', 'ModelDeck', 'claude-profiles');
  fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
  fs.mkdirSync(unselected, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(selected, '.credentials.json'), '{"fixture":"selected"}', { mode: 0o600 });
  fs.writeFileSync(path.join(unselected, '.credentials.json'), '{"fixture":"unselected"}', { mode: 0o600 });

  const imported = await importClaudeSwapProfiles({
    profilesDir,
    selections: [{ sourceDir: selected, profileName: 'Work Profile', label: 'Work' }],
  });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].profileRef, path.join(fs.realpathSync(profilesDir), 'work-profile'));
  assert.equal(fs.readFileSync(path.join(imported[0].profileRef, '.credentials.json'), 'utf8'), '{"fixture":"selected"}');
  assert.equal(fs.statSync(imported[0].profileRef).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(unselected, '.credentials.json')));
  assert.equal(fs.readdirSync(profilesDir).length, 1);
});

test('migration tightens permissive legacy modes to owner-only in the imported home', async (t) => {
  const root = temporaryRoot(t);
  const source = path.join(root, 'cswap', 'loose');
  const nested = path.join(source, 'projects');
  const profilesDir = path.join(root, 'claude-profiles');
  fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(source, '.credentials.json'), '{"fixture":true}', { mode: 0o644 });
  fs.writeFileSync(path.join(nested, 'settings.json'), '{}', { mode: 0o664 });
  fs.chmodSync(source, 0o700);

  const [imported] = await importClaudeSwapProfiles({
    profilesDir,
    selections: [{ sourceDir: source, profileName: 'loose', label: 'Loose' }],
  });
  assert.equal(fs.statSync(imported.profileRef).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(imported.profileRef, '.credentials.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(imported.profileRef, 'projects')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(imported.profileRef, 'projects', 'settings.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(source, '.credentials.json')).mode & 0o777, 0o644);
});

test('migration refuses existing destinations and rolls back partial imports', async (t) => {
  const root = temporaryRoot(t);
  const source = path.join(root, 'source');
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(profilesDir, 'existing'), { recursive: true, mode: 0o700 });
  await assert.rejects(importClaudeSwapProfiles({
    profilesDir,
    selections: [{ sourceDir: source, profileName: 'existing' }],
  }), /destination already exists/);

  await assert.rejects(importClaudeSwapProfiles({
    profilesDir,
    selections: [
      { sourceDir: source, profileName: 'first' },
      { sourceDir: path.join(root, 'missing'), profileName: 'second' },
    ],
  }), /migration failed/);
  assert.equal(fs.existsSync(path.join(profilesDir, 'first')), false);
});

test('migration rejects symlinks that could escape an approved profile home', async (t) => {
  const root = temporaryRoot(t);
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside-credentials.json');
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, path.join(source, '.credentials.json'));
  await assert.rejects(importClaudeSwapProfiles({
    profilesDir: path.join(root, 'profiles'),
    selections: [{ sourceDir: source, profileName: 'selected' }],
  }), /contains a symbolic link/);
});

test('parses Codex multi-bucket rate limits', () => {
  const snapshots = parseCodexRateLimits({
    rateLimits: { planType: 'pro', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1780000000 }, secondary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: 1780100000 } },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', limitName: 'Codex', planType: 'pro', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1780000000 }, secondary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: 1780100000 } },
      spark: { limitId: 'spark', limitName: 'Spark', planType: 'pro', secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1780200000 } },
    },
  });
  assert.deepEqual(snapshots.map((row) => [row.scope, row.usedPercent]), [
    ['5-hour', 12],
    ['weekly', 44],
    ['Spark weekly', 5],
  ]);
  assert.equal(snapshots[0].resetsAt, new Date(1780000000 * 1000).toISOString());
  assert.equal(snapshots[1].resetsAt, new Date(1780100000 * 1000).toISOString());
});

test('preserves an upstream weekly-only Codex response without inventing a 5-hour window', () => {
  const snapshots = parseCodexRateLimits({
    rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1784950179 }, secondary: null },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1784950179 }, secondary: null },
    },
  });
  assert.deepEqual(snapshots.map((row) => [row.scope, row.usedPercent]), [['weekly', 64]]);
  assert.equal(snapshots[0].resetsAt, '2026-07-25T03:29:39.000Z');
});

test('reads the ChatGPT plan type from the Codex id_token payload', async (t) => {
  const root = temporaryRoot(t);
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { mode: 0o700 });
  const payload = {
    email: 'dev@example.com',
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'pro',
      // An expired display-metadata claim must still be surfaced.
      chatgpt_subscription_active_until: '2020-01-01T00:00:00Z',
    },
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: `header.${encoded}.signature` } }));
  assert.deepEqual(await readCodexPlan({ codexHome: home }), { planType: 'pro' });
});

test('Codex plan reading treats missing claims and malformed local auth as absent', async (t) => {
  const root = temporaryRoot(t);
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { mode: 0o700 });

  assert.deepEqual(await readCodexPlan({ codexHome: home }), { planType: null });
  fs.writeFileSync(path.join(home, 'auth.json'), 'not json');
  assert.deepEqual(await readCodexPlan({ codexHome: home }), { planType: null });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: 'malformed' } }));
  assert.deepEqual(await readCodexPlan({ codexHome: home }), { planType: null });

  const encoded = Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString('base64url');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: `header.${encoded}.signature` } }));
  assert.deepEqual(await readCodexPlan({ codexHome: home }), { planType: null });
});

// --------------------------------------------------------------------------
// Issue #8 — add-account flow adapters. All fixture identities are
// placeholders (user@example.invalid), per the repo privacy rule.

test('extracts identities from JSON and plain text status output, never inventing one', () => {
  assert.equal(extractIdentity(JSON.stringify({ account: { email: 'user@example.invalid' } })), 'user@example.invalid');
  assert.equal(extractIdentity('Logged in as user@example.invalid (ChatGPT plan)'), 'user@example.invalid');
  assert.equal(extractIdentity('Signed in.'), null);
  assert.equal(extractIdentity(''), null);
});

test('creates owner-only Codex profile homes and refuses duplicates', async (t) => {
  const root = temporaryRoot(t);
  const profilesDir = path.join(root, 'codex-profiles');
  const profileRef = await createCodexProfileHome({ profilesDir, profileName: 'Work Codex' });
  assert.equal(path.basename(profileRef), 'work-codex');
  assert.equal(fs.statSync(profileRef).mode & 0o777, 0o700);
  assert.equal(fs.statSync(profilesDir).mode & 0o777, 0o700);
  await assert.rejects(createCodexProfileHome({ profilesDir, profileName: 'Work Codex' }), {
    message: `Codex profile destination already exists: ${profileRef}`,
  });
  await assert.rejects(createCodexProfileHome({ profilesDir, profileName: '..' }), {
    message: 'profile name is invalid',
  });
});

test('codex login status reads identity without ever running logout', async (t) => {
  const root = temporaryRoot(t);
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { mode: 0o700 });
  const encoded = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
  })).toString('base64url');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: `header.${encoded}.signature` } }));
  const calls = [];
  const status = await readCodexLoginStatus({
    codexHome: home,
    run: async (binary, args, options) => {
      calls.push({ binary, args, env: options.env });
      return { stdout: 'Logged in as user@example.invalid\n', stderr: '' };
    },
  });
  assert.deepEqual(status, { authenticated: true, identity: 'user@example.invalid', plan: { planType: 'plus' } });
  assert.deepEqual(calls[0].args, ['login', 'status']);
  assert.ok(!calls[0].args.includes('logout'));
  assert.equal(calls[0].env.CODEX_HOME, home);

  const signedOut = await readCodexLoginStatus({
    codexHome: home,
    run: async () => { const error = new Error('exit 1'); error.stderr = 'Not logged in'; throw error; },
  });
  assert.equal(signedOut.authenticated, false);
  assert.equal(signedOut.identity, null);
  assert.deepEqual(signedOut.plan, { planType: 'plus' });

  await assert.rejects(readCodexLoginStatus({
    codexHome: home,
    run: async () => { const error = new Error('spawn codex ENOENT'); error.code = 'ENOENT'; throw error; },
  }), /not installed/);
});

test('codex login status refuses group-readable homes', async (t) => {
  const root = temporaryRoot(t);
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { mode: 0o750 });
  await assert.rejects(readCodexLoginStatus({ codexHome: home, run: async () => ({ stdout: '' }) }), /owner-only/);
});

test('claude auth status reads identity under the managed profile home only', async (t) => {
  const root = temporaryRoot(t);
  const profilesDir = path.join(root, 'claude-profiles');
  fs.mkdirSync(profilesDir, { mode: 0o700 });
  const profileRef = path.join(profilesDir, 'work');
  fs.mkdirSync(profileRef, { mode: 0o700 });
  const calls = [];
  const status = await readClaudeAuthStatus({
    claudeConfigDir: profileRef,
    profilesDir,
    platform: 'linux',
    userInfo: () => ({ username: 'fixture-user' }),
    run: async (binary, args, options) => {
      calls.push({ binary, args, env: options.env });
      return { stdout: JSON.stringify({ signedInAs: 'user@example.invalid' }), stderr: '' };
    },
  });
  assert.deepEqual(status, {
    authenticated: true,
    identity: 'user@example.invalid',
    plan: { subscriptionType: null, rateLimitTier: null },
  });
  assert.deepEqual(calls[0].args, ['auth', 'status']);
  assert.ok(!calls[0].args.includes('logout'));
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, profileRef);
  assert.equal(calls[0].env.USER, 'fixture-user');

  // Outside the managed profiles directory: refused before any spawn.
  const stray = path.join(root, 'stray');
  fs.mkdirSync(stray, { mode: 0o700 });
  await assert.rejects(readClaudeAuthStatus({ claudeConfigDir: stray, profilesDir, run: async () => ({ stdout: '' }) }), /inside ModelDeck/);
});

test('claude auth status falls back to file or Keychain credential presence when the command fails', async (t) => {
  const root = temporaryRoot(t);
  const profilesDir = path.join(root, 'claude-profiles');
  fs.mkdirSync(profilesDir, { mode: 0o700 });
  const profileRef = path.join(profilesDir, 'work');
  fs.mkdirSync(profileRef, { mode: 0o700 });
  const failingRun = async () => { const error = new Error('exit 1'); error.stderr = 'unknown command'; throw error; };

  const common = {
    claudeConfigDir: profileRef,
    profilesDir,
    run: failingRun,
    platform: 'darwin',
    homeDirectory: '/Users/fixture',
    userInfo: () => ({ username: 'fixture-user' }),
  };
  const securityCalls = [];
  const withoutCredentials = await readClaudeAuthStatus({
    ...common,
    securityRun: async (...args) => { securityCalls.push(args); throw new Error('not found'); },
  });
  assert.equal(withoutCredentials.authenticated, false);
  assert.deepEqual(securityCalls[0][0], '/usr/bin/security');
  assert.deepEqual(securityCalls[0][1], [
    'find-generic-password', '-s', claudeCredentialServiceName(profileRef, '/Users/fixture'),
    '-a', 'fixture-user',
  ]);
  assert.ok(!securityCalls[0][1].includes('-w'));

  const withKeychainCredentials = await readClaudeAuthStatus({
    ...common,
    securityRun: async () => ({ stdout: 'metadata only' }),
  });
  assert.equal(withKeychainCredentials.authenticated, true);

  fs.writeFileSync(path.join(profileRef, '.credentials.json'), '{}', { mode: 0o600 });
  const withCredentials = await readClaudeAuthStatus({
    ...common,
    securityRun: async () => { throw new Error('Keychain miss'); },
  });
  assert.equal(withCredentials.authenticated, true);

  await assert.rejects(readClaudeAuthStatus({
    claudeConfigDir: profileRef,
    profilesDir,
    platform: 'linux',
    userInfo: () => ({ username: 'fixture-user' }),
    run: async () => { const error = new Error('spawn claude ENOENT'); error.code = 'ENOENT'; throw error; },
  }), /not installed/);
});

test('codex profile home containment mirrors the Claude validator', async (t) => {
  const root = temporaryRoot(t);
  const profilesDir = path.join(root, 'codex-profiles');
  const inside = await createCodexProfileHome({ profilesDir, profileName: 'work' });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });

  assert.equal(await validateCodexProfileHome({ profileRef: inside, profilesDir }), inside);
  await assert.rejects(validateCodexProfileHome({ profileRef: outside, profilesDir }), /inside ModelDeck/);
  await assert.rejects(validateCodexProfileHome({ profileRef: profilesDir, profilesDir }), /inside ModelDeck/);

  // readCodexLoginStatus enforces the same containment when profilesDir is
  // provided — the stray home is refused before any process spawn.
  let spawned = 0;
  await assert.rejects(readCodexLoginStatus({
    codexHome: outside,
    profilesDir,
    run: async () => { spawned += 1; return { stdout: '' }; },
  }), /inside ModelDeck/);
  assert.equal(spawned, 0);
  const status = await readCodexLoginStatus({
    codexHome: inside,
    profilesDir,
    run: async () => ({ stdout: 'Logged in as user@example.invalid', stderr: '' }),
  });
  assert.deepEqual(status, { authenticated: true, identity: 'user@example.invalid', plan: { planType: null } });
});
