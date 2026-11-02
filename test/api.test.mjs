import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import {
  CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT,
  CLAUDE_MANAGED_KEY_UNSET_FRAGMENT,
  ModelDeckService,
} from '../src/service.mjs';
import { createApp } from '../src/server.mjs';

const API_MUTATION_TOKEN = 'api-mutation-token-placeholder';

async function startFixture(serviceOptions = {}, { listen = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-api-'));
  const projectsRoot = path.join(root, 'projects');
  const codexHome = path.join(root, 'profiles', 'work');
  const claudeHome = path.join(root, 'claude-profiles', 'work');
  const grokHome = path.join(root, '.grok');
  const codexActiveLink = path.join(root, 'active', '.codex');
  const claudeActiveLink = path.join(root, 'active', '.claude');
  fs.mkdirSync(path.join(projectsRoot, 'loanmeld'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(codexHome, 0o700);
  fs.chmodSync(path.dirname(codexHome), 0o700);
  fs.writeFileSync(path.join(projectsRoot, 'loanmeld', 'package.json'), JSON.stringify({ name: 'loanmeld' }));
  const store = new Store(':memory:');
  store.saveSettings({ claudeManaged: true, codexManaged: true });
  store.saveAccount({ provider: 'claude', label: 'Business', profileRef: claudeHome, isDefault: true });
  const service = new ModelDeckService(store, {
    projectsRoot,
    codexActiveLink,
    claudeActiveLink,
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    codexProfilesDir: path.join(root, 'profiles'),
    grokSessionsDir: path.join(grokHome, 'sessions'),
    fetchClaude: async () => [{ scope: 'Fable weekly', usedPercent: 20, source: 'fixture' }],
    fetchCodex: async () => [],
    // Inert timer: listen() must never arm a real auto-refresh in the API
    // fixture (scheduler behavior is covered by test/auto-refresh.test.mjs
    // with an injected clock); stored settings stay at their defaults.
    setTimeout: () => 0,
    clearTimeout: () => {},
    platform: 'linux',
    // Deterministic: never let the fixture shell out to /bin/ps for the
    // issue #66 pre-flip running-session warning.
    listProviderProcesses: async () => [],
    // The usage-queue guard is launchd-only production plumbing; API tests
    // inject the confirmed-absent result and never inspect the user's domain.
    detectForeignUsageConsumers: async () => ({ checked: true, consumers: [], probe: 'ok' }),
    ...serviceOptions,
  });
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: 0,
    mutationToken: API_MUTATION_TOKEN,
  });
  if (!listen) {
    return {
      root,
      claudeHome,
      claudeActiveLink,
      codexHome,
      codexActiveLink,
      grokHome,
      store,
      service,
      app,
      base: null,
      token: API_MUTATION_TOKEN,
      cookie: `modeldeck_session=${API_MUTATION_TOKEN}`,
    };
  }
  await new Promise((resolve) => app.listen(resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(`${base}/api/session`);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  return { root, claudeHome, claudeActiveLink, codexHome, codexActiveLink, grokHome, store, service, app, base, token: session.token, cookie };
}

async function request(fixture, route, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(`${fixture.base}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-ModelDeck-Token': fixture.token, Cookie: fixture.cookie } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

async function directRequest(fixture, route, {
  method = 'GET',
  body: input,
  authenticated = true,
} = {}) {
  const requestPayload = input === undefined ? '' : JSON.stringify(input);
  const req = Object.assign(Readable.from(requestPayload ? [Buffer.from(requestPayload)] : []), {
    method,
    url: route,
    headers: {
      host: 'localhost:0',
      ...(requestPayload ? { 'content-type': 'application/json' } : {}),
      ...(authenticated ? {
        'x-modeldeck-token': fixture.token,
        cookie: fixture.cookie,
      } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let headers;
  let responsePayload = '';
  const finished = new Promise((resolve) => {
    req.res = {
      writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
      end(chunk = '') { responsePayload += chunk; resolve(); },
    };
  });
  await Promise.all([fixture.app.server.listeners('request')[0](req, req.res), finished]);
  return {
    response: { status, headers },
    body: JSON.parse(responsePayload),
  };
}

async function directGet(fixture, route, options) {
  return directRequest(fixture, route, options);
}

for (const provider of ['claude', 'codex']) {
  test(`profile-exists: ${provider} asks before reattaching an unregistered base folder`, async (t) => {
    const fixture = await startFixture({
      exec: async () => ({ stdout: '2.1.215' }),
      readClaudeTier: async () => null,
      readClaudeIdentity: async () => null,
    }, { listen: false });
    t.after(() => { fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
    const profilesDir = provider === 'claude' ? fixture.service.claudeProfilesDir : fixture.service.codexProfilesDir;
    const profileRef = path.join(fs.realpathSync(profilesDir), 'sample-work');
    const transcript = path.join(profileRef, 'projects', 'sample', 'nested', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
    fs.writeFileSync(transcript, 'original transcript\n');
    fs.writeFileSync(path.join(profileRef, 'auth.json'), 'not a credential');
    fs.writeFileSync(path.join(profileRef, 'CLAUDE.md'), 'User instructions\n');
    const modifiedAt = new Date('2026-09-10T12:00:00.000Z');
    fs.utimesSync(profileRef, modifiedAt, modifiedAt);
    const before = treeMetadata(profileRef);
    const input = { provider, label: 'Sample Work', purpose: 'fixture' };
    const accountsBefore = fixture.store.listAccounts().length;

    // Discovery can list names and metadata, but must never open user files.
    const reads = t.mock.method(fs.promises, 'readFile', async () => { throw new Error('profile discovery opened a file'); });
    const blocked = await directRequest(fixture, '/api/accounts', { method: 'POST', body: input });
    reads.mock.restore();
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.code, 'profile-exists');
    assert.equal(blocked.body.profile.path, profileRef);
    assert.equal(blocked.body.profile.name, 'sample-work');
    assert.equal(blocked.body.profile.transcripts, provider === 'claude' ? 1 : 0);
    assert.equal(blocked.body.profile.lastModified, modifiedAt.toISOString());
    if (provider === 'codex') assert.equal(blocked.body.profile.hasCredential, true);
    assert.equal(reads.mock.callCount(), 0);
    assert.deepEqual(treeMetadata(profileRef), before);
    assert.equal(fixture.store.listAccounts().length, accountsBefore);
    assert.equal(fs.existsSync(`${profileRef}-2`), false);

    const fresh = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { ...input, existingProfile: 'fresh' } });
    assert.equal(fresh.response.status, 201);
    assert.equal(fresh.body.account.profileRef, `${profileRef}-2`);
    assert.ok(fresh.body.profileNote.includes(profileRef));
    assert.deepEqual(treeMetadata(profileRef), before);

    fs.chmodSync(profileRef, 0o755);
    const adopted = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { ...input, existingProfile: 'adopt' } });
    assert.equal(adopted.response.status, 201);
    assert.equal(adopted.body.account.profileRef, profileRef);
    assert.equal(fs.statSync(profileRef).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(transcript, 'utf8'), 'original transcript\n');
    assert.ok(fs.readFileSync(path.join(profileRef, 'CLAUDE.md'), 'utf8').endsWith('User instructions\n'));

    const second = await directRequest(fixture, '/api/accounts', { method: 'POST', body: input });
    assert.equal(second.response.status, 201, 'a registered base is a genuine second account, without a prompt');
    assert.equal(second.body.account.profileRef, `${profileRef}-3`);
    const taken = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { ...input, existingProfile: 'adopt' } });
    assert.equal(taken.response.status, 409, 'an explicit adoption cannot share a registered home');
  });

  test(`profile-exists: ${provider} refuses unsafe adoption and preserves an orphan on failure`, async (t) => {
    const fixture = await startFixture({
      exec: async () => ({ stdout: '2.1.215' }),
      readClaudeTier: async () => null,
      readClaudeIdentity: async () => null,
    }, { listen: false });
    t.after(() => { fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
    const profilesDir = provider === 'claude' ? fixture.service.claudeProfilesDir : fixture.service.codexProfilesDir;
    const profileRef = path.join(fs.realpathSync(profilesDir), 'sample');
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.writeFileSync(path.join(outside, 'session.jsonl'), 'preserve me');
    const beforeOutside = treeMetadata(outside);
    const input = { provider, label: 'Sample', existingProfile: 'adopt' };

    fs.symlinkSync(outside, profileRef);
    let result = await directRequest(fixture, '/api/accounts', { method: 'POST', body: input });
    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /real directory/);
    assert.deepEqual(treeMetadata(outside), beforeOutside);
    fs.unlinkSync(profileRef);
    fs.mkdirSync(profileRef, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(profileRef, 'projects'));
    result = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { provider, label: 'Sample' } });
    assert.equal(result.body.profile.transcripts, 0, 'discovery never traverses a linked projects folder');
    result = await directRequest(fixture, '/api/accounts', { method: 'POST', body: input });
    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /symbolic link/);
    assert.deepEqual(treeMetadata(outside), beforeOutside);
    fs.unlinkSync(path.join(profileRef, 'projects'));

    result = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { ...input, existingProfile: 'invalid' } });
    assert.equal(result.response.status, 400);
    assert.equal(fs.existsSync(`${profileRef}-2`), false);

    const transcript = path.join(profileRef, 'session.jsonl');
    fs.writeFileSync(transcript, 'original history');
    const originalCount = fixture.store.listAccounts().length;
    const failure = t.mock.method(fixture.service, 'setDefaultAccount', () => { throw new Error('injected save failure'); });
    result = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { ...input, isDefault: true } });
    failure.mock.restore();
    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /injected save failure/);
    assert.equal(fixture.store.listAccounts().length, originalCount);
    assert.equal(fs.readFileSync(transcript, 'utf8'), 'original history');
  });

  test(`profile-exists: ${provider} checks only the exact base name and serializes competing adoptions`, async (t) => {
    const fixture = await startFixture({
      exec: async () => ({ stdout: '2.1.215' }),
      readClaudeTier: async () => null,
      readClaudeIdentity: async () => null,
    }, { listen: false });
    t.after(() => { fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
    const profilesDir = provider === 'claude' ? fixture.service.claudeProfilesDir : fixture.service.codexProfilesDir;
    const profileRef = path.join(fs.realpathSync(profilesDir), 'sample');
    fs.mkdirSync(`${profileRef}-2`, { mode: 0o700 });
    let result = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { provider, label: 'Sample' } });
    assert.equal(result.response.status, 201, 'numbered orphans alone do not cause a prompt');
    assert.equal(result.body.account.profileRef, profileRef);
    fixture.store.deleteAccount(result.body.account.id);

    const results = await Promise.all([0, 1].map(() => directRequest(fixture, '/api/accounts', {
      method: 'POST', body: { provider, label: 'Sample', existingProfile: 'adopt' },
    })));
    assert.deepEqual(results.map((entry) => entry.response.status).sort(), [201, 409]);
    assert.equal(fixture.store.listAccounts().filter((account) => account.profileRef === profileRef).length, 1);
    assert.equal(fs.existsSync(profileRef), true);
  });

  test(`profile-exists: ${provider} recognizes registered folders with different capitalization`, async (t) => {
    const fixture = await startFixture({
      exec: async () => ({ stdout: '2.1.215' }),
      readClaudeTier: async () => null,
      readClaudeIdentity: async () => null,
    }, { listen: false });
    t.after(() => { fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
    const profilesDir = provider === 'claude' ? fixture.service.claudeProfilesDir : fixture.service.codexProfilesDir;
    const profileRef = path.join(fs.realpathSync(profilesDir), 'Sample-Work');
    fs.mkdirSync(profileRef, { mode: 0o700 });
    if (!fs.existsSync(path.join(profilesDir, 'sample-work'))) return t.skip('requires a case-insensitive filesystem');
    fixture.store.saveAccount({ provider, label: 'First', profileRef });
    const input = { provider, label: 'Sample Work' };
    const refused = await directRequest(fixture, '/api/accounts', { method: 'POST', body: { ...input, existingProfile: 'adopt' } });
    assert.equal(refused.response.status, 409);
    const second = await directRequest(fixture, '/api/accounts', { method: 'POST', body: input });
    assert.equal(second.response.status, 201);
    assert.equal(path.basename(second.body.account.profileRef), 'sample-work-2');
  });
}

for (const suffix of [false, true]) {
  test(`profile-exists: a ${suffix ? 'numbered' : 'base'} folder still being created cannot be adopted before failure cleanup`, async (t) => {
    let releaseCreation;
    let reachedExplainer;
    const paused = new Promise((resolve) => { reachedExplainer = resolve; });
    const release = new Promise((resolve) => { releaseCreation = resolve; });
    let calls = 0;
    const fixture = await startFixture({
      exec: async () => ({ stdout: '2.1.215' }),
      readClaudeTier: async () => null,
      readClaudeIdentity: async () => null,
      reconcileClaudeProfileExplainer: async () => { if (++calls === 1) { reachedExplainer(); await release; } },
    }, { listen: false });
    const originalProfileChanged = fixture.service.accountProfileSetChanged.bind(fixture.service);
    fixture.service.accountProfileSetChanged = async () => {
      if (calls === 1) throw new Error('injected profile reconciliation failure');
      return originalProfileChanged();
    };
    t.after(() => { fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
    const input = { provider: 'claude', label: 'Pending', ...(suffix ? { existingProfile: 'fresh' } : {}) };
    if (suffix) fs.mkdirSync(path.join(fixture.service.claudeProfilesDir, 'pending'), { mode: 0o700 });
    const creating = directRequest(fixture, '/api/accounts', { method: 'POST', body: input });
    await paused;
    let adopting;
    try {
      adopting = await directRequest(fixture, '/api/accounts', {
        method: 'POST', body: { ...input, label: suffix ? 'Pending-2' : 'Pending', existingProfile: 'adopt' },
      });
    } finally { releaseCreation(); }
    await creating;
    assert.equal(adopting.response.status, 409);
    assert.match(adopting.body.error, /being added/);
    fixture.service.accountProfileSetChanged = originalProfileChanged;
    const retried = await directRequest(fixture, '/api/accounts', { method: 'POST', body: input });
    assert.equal(retried.response.status, 201, 'failed creation releases the reservation');
  });
}

function claudeSnapshotsExpiringAt(expiresAt) {
  const snapshots = [{ scope: 'Fable weekly', usedPercent: 20, source: 'fixture' }];
  Object.defineProperty(snapshots, 'expiresAt', { value: expiresAt, enumerable: false });
  return snapshots;
}

function requestWithHost(fixture, host) {
  const url = new URL(fixture.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: '/api/health', headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function createGrokHome(home, { lastSessionAt = null, mode = 0o700 } = {}) {
  fs.mkdirSync(home, { recursive: true, mode });
  fs.chmodSync(home, mode);
  fs.writeFileSync(path.join(home, 'auth.json'), '{}', { mode: 0o600 });
  if (lastSessionAt) createGrokSession(path.join(home, 'sessions'), lastSessionAt);
}

function createGrokSession(sessionsRoot, lastSessionAt) {
  const updates = path.join(sessionsRoot, 'fixture-cwd', 'fixture-session', 'updates.jsonl');
  fs.mkdirSync(path.dirname(updates), { recursive: true, mode: 0o700 });
  fs.writeFileSync(updates, '{"type":"fixture"}\n', { mode: 0o600 });
  const at = new Date(lastSessionAt);
  fs.utimesSync(updates, at, at);
}

function treeMetadata(root) {
  const result = {};
  const visit = (target, relative) => {
    const stat = fs.lstatSync(target);
    result[relative || '.'] = {
      type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
      mode: stat.mode & 0o777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      link: stat.isSymbolicLink() ? fs.readlinkSync(target) : null,
    };
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(target).sort()) {
      visit(path.join(target, name), relative ? path.join(relative, name) : name);
    }
  };
  visit(root, '');
  return result;
}

test('retired dashboard paths return JSON 404 responses', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  assert.equal(fixture.service.usageSnapshotPruneStarted, true,
    'daemon listen starts retention after Store migration');

  for (const route of ['/', '/app.js']) {
    const result = await request(fixture, route);
    assert.equal(result.response.status, 404);
    assert.match(result.response.headers.get('content-type'), /^application\/json\b/);
    assert.deepEqual(result.body, { error: 'not found' });
  }
});

test('health, scan, account, mapping, launch, and refresh APIs work together', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  let result = await request(fixture, '/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.name, 'ModelDeck');
  // Source-mode daemons have no inlined build commit; the field is still
  // present so the app's stale-daemon verification has an explicit answer.
  assert.ok('MDGitCommit' in result.body);
  assert.strictEqual(result.body.MDGitCommit, null);

  result = await request(fixture, '/api/scan', { method: 'POST', body: '{}' });
  assert.equal(result.body.projects.length, 1);
  const project = result.body.projects[0];

  result = await request(fixture, '/api/accounts', { method: 'POST', body: JSON.stringify({ provider: 'codex', label: 'Business Codex', identity: 'business@example.com', profileRef: fixture.codexHome, isDefault: true }) });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.account.identity, 'business@example.com');
  const codex = result.body.account;

  result = await request(fixture, '/api/refresh', { method: 'POST', body: '{}' });
  assert.equal(result.body.claude.ok, true);

  const state = (await request(fixture, '/api/state')).body;
  const claude = state.accounts.find((account) => account.provider === 'claude');
  assert.equal(state.usage[0].scope, 'Fable weekly');

  result = await request(fixture, `/api/projects/${project.id}`, { method: 'PUT', body: JSON.stringify({ purpose: 'Business', claudeAccountId: claude.id, codexAccountId: codex.id }) });
  assert.equal(result.body.project.purpose, 'Business');

  result = await request(fixture, `/api/launch?provider=codex&project=${encodeURIComponent(path.join(project.path, 'apps', 'web'))}`);
  assert.equal(result.body.account.profileRef, fs.realpathSync(fixture.codexHome));
  assert.ok(result.body.command.includes(`CODEX_HOME='${fs.realpathSync(fixture.codexHome)}'`));
});

test('Grok home discovery reports readiness and refusals without changing the candidate', async (t) => {
  const fixture = await startFixture({}, { listen: false });
  t.after(() => { fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  await t.test('happy path uses the configured default and derives the last session time', async () => {
    const lastSessionAt = '2026-08-23T19:20:21.000Z';
    createGrokHome(fixture.grokHome, { lastSessionAt });
    const canonical = fs.realpathSync(fixture.grokHome);
    const untokened = await directGet(fixture, '/api/grok/home-candidate', { authenticated: false });
    assert.equal(untokened.response.status, 403);
    assert.deepEqual(untokened.body, { error: 'mutation token or origin rejected' });

    const result = await directGet(fixture, '/api/grok/home-candidate');

    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      path: canonical,
      exists: true,
      isDirectory: true,
      ownedByCurrentUser: true,
      writableByOthers: false,
      permissionsOk: true,
      hasCredentials: true,
      alreadyRegisteredAs: null,
      lastSessionAt,
      hint: null,
      readFiles: [
        path.join(canonical, 'auth.json'),
        path.join(canonical, 'sessions', '*', '*', 'updates.jsonl'),
      ],
    });
  });

  await t.test('missing home is reported instead of raised as an endpoint error', async () => {
    const missing = path.join(fixture.root, 'missing-grok-home');
    const result = await directGet(fixture, `/api/grok/home-candidate?path=${encodeURIComponent(missing)}`);

    assert.equal(result.response.status, 200);
    assert.equal(result.body.path, missing);
    assert.equal(result.body.exists, false);
    assert.equal(result.body.isDirectory, false);
    assert.equal(result.body.permissionsOk, false);
    assert.equal(result.body.hasCredentials, false);
    assert.equal(result.body.lastSessionAt, null);
    assert.match(result.body.hint, /Run grok/);
  });

  await t.test('a permission error during canonicalization uses the ordinary unavailable shape', async (subtest) => {
    const isolated = await startFixture({
      realpath: async (target) => {
        if (target.endsWith(`${path.sep}unreadable-grok-home`)) {
          const error = new Error('fixture permission denied');
          error.code = 'EACCES';
          throw error;
        }
        return fs.promises.realpath(target);
      },
    }, { listen: false });
    subtest.after(() => { isolated.store.close(); fs.rmSync(isolated.root, { recursive: true, force: true }); });
    const unreadable = path.join(isolated.root, 'unreadable-grok-home');
    createGrokHome(unreadable);

    const result = await directGet(isolated, `/api/grok/home-candidate?path=${encodeURIComponent(unreadable)}`);

    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      path: unreadable,
      exists: false,
      isDirectory: false,
      ownedByCurrentUser: false,
      writableByOthers: false,
      permissionsOk: false,
      hasCredentials: false,
      alreadyRegisteredAs: null,
      lastSessionAt: null,
      hint: `No Grok home found at ${unreadable}. Run grok to create it and sign in.`,
      readFiles: [
        path.join(unreadable, 'auth.json'),
        path.join(unreadable, 'sessions', '*', '*', 'updates.jsonl'),
      ],
    });
  });

  await t.test('home writable by other users carries the exact chmod refusal', async () => {
    const writable = path.join(fixture.root, 'shared-grok-home');
    createGrokHome(writable, { mode: 0o722 });
    const result = await directGet(fixture, `/api/grok/home-candidate?path=${encodeURIComponent(writable)}`);

    assert.equal(result.response.status, 200);
    assert.equal(result.body.writableByOthers, true);
    assert.equal(result.body.permissionsOk, false);
    assert.equal(result.body.hint, `Grok profile home must not be writable by anyone else (chmod g-w,o-w ${fs.realpathSync(writable)})`);
  });

  await t.test('a home registered to another provider is named by the shared guard', async () => {
    const result = await directGet(fixture, `/api/grok/home-candidate?path=${encodeURIComponent(fixture.claudeHome)}`);

    assert.equal(result.response.status, 200);
    assert.equal(result.body.alreadyRegisteredAs, 'claude');
    assert.match(result.body.hint, /already registered as a claude subscription's home/);
  });

  await t.test('a home registered to Grok is reported and refused for a second Grok account', async () => {
    const sharedHome = path.join(fixture.root, 'registered-grok-home');
    createGrokHome(sharedHome);
    fixture.store.saveAccount({
      provider: 'grok',
      label: 'Existing Grok placeholder',
      profileRef: fs.realpathSync(sharedHome),
    });
    const hint = "this directory is already registered as a grok subscription's home; a Grok subscription needs its own";

    const discovery = await directGet(fixture, `/api/grok/home-candidate?path=${encodeURIComponent(sharedHome)}`);

    assert.equal(discovery.response.status, 200);
    assert.equal(discovery.body.alreadyRegisteredAs, 'grok');
    assert.equal(discovery.body.hint, hint);

    const registration = await directRequest(fixture, '/api/accounts', {
      method: 'POST',
      body: {
        provider: 'grok',
        label: 'Second Grok placeholder',
        profileRef: sharedHome,
      },
    });

    assert.equal(registration.response.status, 400);
    assert.deepEqual(registration.body, { error: hint });
    assert.equal(fixture.store.listAccounts().filter((account) => account.provider === 'grok').length, 1);
  });

  await t.test('a home owned by another uid has a stable refusal shape', async (subtest) => {
    const isolated = await startFixture({ uid: (process.getuid?.() ?? 0) + 1 }, { listen: false });
    subtest.after(() => { isolated.store.close(); fs.rmSync(isolated.root, { recursive: true, force: true }); });
    createGrokHome(isolated.grokHome);
    const canonical = fs.realpathSync(isolated.grokHome);

    const result = await directGet(isolated, '/api/grok/home-candidate');

    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      path: canonical,
      exists: true,
      isDirectory: true,
      ownedByCurrentUser: false,
      writableByOthers: false,
      permissionsOk: false,
      hasCredentials: true,
      alreadyRegisteredAs: null,
      lastSessionAt: null,
      hint: 'Grok profile home must be owned by the current user',
      readFiles: [
        path.join(canonical, 'auth.json'),
        path.join(canonical, 'sessions', '*', '*', 'updates.jsonl'),
      ],
    });
  });

  await t.test('an explicit path override is resolved through realpath', async () => {
    const alternate = path.join(fixture.root, 'alternate-grok-home');
    const selected = path.join(fixture.root, 'selected-grok-home');
    createGrokHome(alternate);
    fs.symlinkSync(alternate, selected, 'dir');
    const result = await directGet(fixture, `/api/grok/home-candidate?path=${encodeURIComponent(selected)}`);

    assert.equal(result.response.status, 200);
    assert.equal(result.body.path, fs.realpathSync(alternate));
    assert.equal(result.body.permissionsOk, true);
    assert.equal(result.body.hasCredentials, true);
  });

  await t.test('a symlink to the default home still uses the configured sessions root', async (subtest) => {
    const isolated = await startFixture({}, { listen: false });
    subtest.after(() => { isolated.store.close(); fs.rmSync(isolated.root, { recursive: true, force: true }); });
    createGrokHome(isolated.grokHome);
    const configuredSessions = path.join(isolated.root, 'configured-grok-sessions');
    const lastSessionAt = '2026-08-24T08:09:10.000Z';
    createGrokSession(configuredSessions, lastSessionAt);
    isolated.service.grokSessionsDir = configuredSessions;
    const selected = path.join(isolated.root, 'selected-default-grok-home');
    fs.symlinkSync(isolated.grokHome, selected, 'dir');

    const result = await directGet(isolated, `/api/grok/home-candidate?path=${encodeURIComponent(selected)}`);

    assert.equal(result.response.status, 200);
    assert.equal(result.body.lastSessionAt, lastSessionAt);
    assert.equal(
      result.body.readFiles[1],
      path.join(fs.realpathSync(configuredSessions), '*', '*', 'updates.jsonl'),
    );
  });

  await t.test('timestamp discovery returns unknown when its metadata-entry cap is reached', async (subtest) => {
    const isolated = await startFixture({ grokHomeDiscoveryEntryLimit: 1 }, { listen: false });
    subtest.after(() => { isolated.store.close(); fs.rmSync(isolated.root, { recursive: true, force: true }); });
    createGrokHome(isolated.grokHome, { lastSessionAt: '2026-08-24T09:10:11.000Z' });

    const result = await directGet(isolated, '/api/grok/home-candidate');

    assert.equal(result.response.status, 200);
    assert.equal(result.body.lastSessionAt, null);
  });

  await t.test('the endpoint performs zero writes and never needs to open auth.json', async () => {
    const readOnly = path.join(fixture.root, 'read-only-grok-home');
    createGrokHome(readOnly, { lastSessionAt: '2026-08-22T10:00:00.000Z' });
    const credential = path.join(readOnly, 'auth.json');
    fs.chmodSync(credential, 0o000);
    const before = treeMetadata(readOnly);

    const result = await directGet(fixture, `/api/grok/home-candidate?path=${encodeURIComponent(readOnly)}`);

    assert.equal(result.response.status, 200);
    assert.equal(result.body.hasCredentials, true);
    assert.deepEqual(treeMetadata(readOnly), before);
    fs.chmodSync(credential, 0o600);
  });
});

test('rejects missing mutation token, cross-origin mutations, and hostile Host headers', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  let response = await fetch(`${fixture.base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);

  response = await fetch(`${fixture.base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example', 'X-ModelDeck-Token': fixture.token, Cookie: fixture.cookie },
    body: '{}',
  });
  assert.equal(response.status, 403);

  assert.equal(await requestWithHost(fixture, 'attacker.example'), 403);
});

// Tripwire for issue #436: every route refuses non-loopback peers, so a
// spoofed "Host: localhost:<port>" from a remote client can never reach the
// GET surface (or /api/session's token handout) on a non-loopback bind.
test('rejects non-loopback peers on GET routes despite a spoofed local Host header', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  const port = fixture.app.server.address().port;
  for (const route of ['/api/state', '/api/session']) {
    const req = Object.assign(Readable.from([]), {
      method: 'GET',
      url: route,
      headers: { host: `localhost:${port}` },
      socket: { remoteAddress: '192.0.2.10' },
    });
    let status;
    let payload = '';
    const finished = new Promise((resolve) => {
      req.res = {
        writeHead(nextStatus) { status = nextStatus; },
        end(chunk = '') { payload += chunk; resolve(); },
      };
    });
    await Promise.all([fixture.app.server.listeners('request')[0](req, req.res), finished]);
    assert.equal(status, 403, route);
    assert.deepEqual(JSON.parse(payload), { error: 'loopback connections only' });
  }
});

test('Claude renewal endpoint returns decided outcomes, 404 unknown, and 409 concurrent', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const at = '2026-07-31T12:00:00.000Z';

  for (const outcome of ['renewed', 'busy', 'signin-required', 'auth-overridden', 'rate-limited', 'failed']) {
    const renew = {
      outcome,
      mechanism: outcome === 'renewed' ? 'auth-status' : null,
      at,
      detail: `fixture ${outcome}`,
    };
    fixture.service.renewClaudeAccount = async () => renew;
    const result = await request(fixture, `/api/accounts/${claude.id}/renew`, { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { renew });
  }

  let result = await request(fixture, '/api/accounts/missing/renew', { method: 'POST' });
  assert.equal(result.response.status, 404);
  assert.deepEqual(result.body, { error: 'account not found' });

  fixture.service.renewClaudeAccount = async () => {
    const error = new Error('a Claude account renewal is already in progress');
    error.statusCode = 409;
    throw error;
  };
  result = await request(fixture, `/api/accounts/${claude.id}/renew`, { method: 'POST' });
  assert.equal(result.response.status, 409);
});

test('Claude identity reset clears provenance and can re-seed; other providers and unauthenticated calls are rejected', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(fixture.claudeHome, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'fresh@example.invalid', accountUuid: 'uuid-fresh' },
  }));
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  fixture.store.saveAccount({
    ...claude,
    identity: 'stale@example.invalid',
    metadata: { claudeAccountUuid: 'uuid-stale', identitySource: 'seed' },
  });

  let response = await fetch(`${fixture.base}/api/accounts/${claude.id}/reset-identity`, { method: 'POST' });
  assert.equal(response.status, 403);
  assert.equal(fixture.store.getAccount(claude.id).identity, 'stale@example.invalid');

  let result = await request(fixture, `/api/accounts/${claude.id}/reset-identity`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.account.identity, '');
  assert.equal(result.body.account.metadata.claudeAccountUuid, undefined);
  assert.equal(result.body.account.metadata.identitySource, undefined);

  await fixture.service.backfillClaudeIdentities();
  const reseeded = fixture.store.getAccount(claude.id);
  assert.equal(reseeded.identity, 'fresh@example.invalid');
  assert.equal(reseeded.metadata.claudeAccountUuid, 'uuid-fresh');
  assert.equal(reseeded.metadata.identitySource, 'seed');

  const codex = fixture.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: fixture.codexHome });
  result = await request(fixture, `/api/accounts/${codex.id}/reset-identity`, { method: 'POST' });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /only supported for claude/);
});

test('account responses never expose the internal Claude post-expiry guard', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  const postExpiryGuardUntil = '2026-08-08T13:45:00.000Z';
  const profileRef = path.join(fixture.service.claudeProfilesDir, 'guarded-response');
  fs.mkdirSync(profileRef, { recursive: true, mode: 0o700 });

  const storedAccount = fixture.store.saveAccount({
    provider: 'claude',
    label: 'Guarded response',
    identity: 'guarded@example.invalid',
    profileRef,
    metadata: {
      claudeRenewal: {
        attempts: [],
        postExpiryGuardUntil,
      },
    },
  });
  const responses = [];
  let result = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      id: storedAccount.id,
      provider: 'claude',
      label: 'Guarded response',
      identity: 'guarded@example.invalid',
      profileRef,
      metadata: {},
    }),
  });
  assert.equal(result.response.status, 201);
  responses.push(result.body.account);
  const accountId = result.body.account.id;
  assert.equal(
    fixture.store.getAccount(accountId).metadata.claudeRenewal.postExpiryGuardUntil,
    postExpiryGuardUntil,
  );

  result = await request(fixture, `/api/accounts/${accountId}/default`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  responses.push(result.body.account);

  result = await request(fixture, `/api/accounts/${accountId}/reset-identity`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  responses.push(result.body.account);

  const guardedAccount = () => fixture.store.getAccount(accountId);
  fixture.service.loginSpec = async () => ({
    provider: 'claude',
    account: guardedAccount(),
    preview: 'claude auth login',
  });
  result = await request(fixture, `/api/accounts/${accountId}/login`);
  assert.equal(result.response.status, 200);
  responses.push(result.body.account);

  fixture.service.verifyAccount = async () => ({
    account: guardedAccount(),
    authenticated: true,
    identity: 'guarded@example.invalid',
  });
  result = await request(fixture, `/api/accounts/${accountId}/verify`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  responses.push(result.body.account);

  fixture.service.activateAccount = async () => ({ account: guardedAccount(), warnings: [] });
  fixture.service.state = async () => ({
    activation: { claude: { state: 'identity-unverified' } },
    claudeSecureStorage: { status: 'not-applicable' },
  });
  result = await request(fixture, `/api/accounts/${accountId}/activate`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  responses.push(result.body.account);

  fixture.service.launchSpec = async () => ({
    provider: 'claude',
    project: null,
    account: guardedAccount(),
    preview: 'claude',
  });
  result = await request(fixture, '/api/launch?provider=claude&project=%2Ffixture');
  assert.equal(result.response.status, 200);
  responses.push(result.body.account);

  assert.equal(responses.length, 7);
  for (const account of responses) {
    assert.equal(Object.hasOwn(account.metadata.claudeRenewal, 'postExpiryGuardUntil'), false);
  }
  assert.equal(
    fixture.store.getAccount(accountId).metadata.claudeRenewal.postExpiryGuardUntil,
    postExpiryGuardUntil,
  );
});

test('activates Claude and Codex accounts without changing defaults when provider switching fails', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const secondClaudeHome = path.join(fixture.root, 'claude-profiles', 'second');
  fs.mkdirSync(secondClaudeHome, { recursive: true, mode: 0o700 });
  const firstClaude = fixture.store.saveAccount({ provider: 'claude', label: 'Claude One', profileRef: fixture.claudeHome, isDefault: true });
  const secondClaude = fixture.store.saveAccount({ provider: 'claude', label: 'Claude Two', profileRef: secondClaudeHome });
  let result = await request(fixture, `/api/accounts/${secondClaude.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.account.isDefault, true);
  assert.deepEqual(result.body.warnings, []);
  assert.equal(result.body.activation.state, 'identity-unverified');
  assert.equal(result.body.claudeSecureStorage.value, fs.realpathSync(secondClaudeHome));
  assert.equal(result.body.claudeSecureStorage.status, 'not-applicable');
  assert.equal(fs.readlinkSync(fixture.claudeActiveLink), fs.realpathSync(secondClaudeHome));

  fs.unlinkSync(fixture.claudeActiveLink);
  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true });
  result = await request(fixture, `/api/accounts/${firstClaude.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'active-link-blocked');
  assert.match(result.body.error, /one-time migration/);
  assert.match(result.body.error, /move the existing directory aside at a quiet moment/);
  assert.equal(fixture.store.getAccount(secondClaude.id).isDefault, true);

  const secondHome = path.join(fixture.root, 'profiles', 'second');
  fs.mkdirSync(secondHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(secondHome, 0o700);
  const firstCodex = fixture.store.saveAccount({ provider: 'codex', label: 'Codex One', profileRef: fixture.codexHome, isDefault: true });
  const secondCodex = fixture.store.saveAccount({ provider: 'codex', label: 'Codex Two', profileRef: secondHome });
  result = await request(fixture, `/api/accounts/${firstCodex.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(fs.readlinkSync(fixture.codexActiveLink), fs.realpathSync(fixture.codexHome));
  result = await request(fixture, `/api/accounts/${secondCodex.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(fs.readlinkSync(fixture.codexActiveLink), fs.realpathSync(secondHome));

  fs.unlinkSync(fixture.codexActiveLink);
  fs.mkdirSync(fixture.codexActiveLink, { recursive: true });
  result = await request(fixture, `/api/accounts/${firstCodex.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'active-link-blocked');
  assert.match(result.body.error, /one-time migration/);
  assert.match(result.body.error, /move the existing directory aside at a quiet moment/);
  assert.equal(fixture.store.getAccount(secondCodex.id).isDefault, true);

  result = await request(fixture, '/api/accounts/missing/activate', { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 404);
  assert.deepEqual(result.body, { error: 'account not found' });
  const disabled = fixture.store.saveAccount({ provider: 'claude', label: 'Disabled', profileRef: 'disabled', enabled: false });
  result = await request(fixture, `/api/accounts/${disabled.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 400);
  assert.deepEqual(result.body, { error: 'account is disabled' });

  const response = await fetch(`${fixture.base}/api/accounts/${secondClaude.id}/activate`, { method: 'POST' });
  assert.equal(response.status, 403);
});

// TRIPWIRE #586: the first-run dead end. A real legacy ~/.claude blocks
// activation (clobber guard), and the daemon must offer a working in-app
// resolution: adopt copies the legacy home into the profile, moves the
// original to a backup (never deleted), and activates — all in one call.
test('adopt-legacy-home resolves the first-run active-link-blocked dead end', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // The field state: ~/.claude is a real directory from prior Claude use.
  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  let result = await request(fixture, `/api/accounts/${claude.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'active-link-blocked');

  result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.account.isDefault, true);
  assert.deepEqual(result.body.warnings, []);
  assert.match(result.body.backupPath, /\.claude\.pre-modeldeck-/);
  // The active link is now a symlink to the profile, which carries the
  // legacy contents; the original survives at the reported backup path.
  assert.equal(fs.readlinkSync(fixture.claudeActiveLink), fs.realpathSync(fixture.claudeHome));
  assert.equal(fs.readFileSync(path.join(fixture.claudeHome, '.claude.json'), 'utf8'), '{"fixture":"legacy"}');
  assert.equal(fs.readFileSync(path.join(result.body.backupPath, '.claude.json'), 'utf8'), '{"fixture":"legacy"}');
  assert.equal(fixture.store.getAccount(claude.id).metadata.adoptedLegacyHome, true);

  // Once managed, a second adoption has nothing to adopt.
  result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /already managed/);
});

test('adopt-legacy-home mode fresh moves the legacy directory aside without importing it', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"fresh"}' });
  assert.equal(result.response.status, 200);
  assert.equal(fs.readlinkSync(fixture.claudeActiveLink), fs.realpathSync(fixture.claudeHome));
  // Fresh mode: the profile stays empty and the legacy content lives only in
  // the backup.
  assert.equal(fs.existsSync(path.join(fixture.claudeHome, '.claude.json')), false);
  assert.equal(fs.readFileSync(path.join(result.body.backupPath, '.claude.json'), 'utf8'), '{"fixture":"legacy"}');
  assert.notEqual(fixture.store.getAccount(claude.id).metadata.adoptedLegacyHome, true);

  const bad = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"sideways"}' });
  assert.equal(bad.response.status, 400);
  assert.match(bad.body.error, /unknown legacy adoption mode/);
});

// TRIPWIRE #590 review MAJOR (delete race): an account removed while its
// adoption is mid-copy must abort cleanly — no zombie row under a fresh id,
// no backup rename, ~/.claude untouched.
test('adopt-legacy-home aborts when the account is deleted mid-adoption', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const realAdopt = fixture.service.adoptClaudeLegacy;
  fixture.service.adoptClaudeLegacy = async (options) => {
    const copied = await realAdopt(options);
    fixture.store.deleteAccount(claude.id);
    return copied;
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /removed or disabled while the adoption was running/);
  // No resurrection under a new id, no backup rename, active link untouched.
  assert.equal(fixture.store.listAccounts().filter((a) => a.provider === 'claude').length, 0);
  assert.ok(fs.lstatSync(fixture.claudeActiveLink).isDirectory());
  assert.equal(fs.readdirSync(path.dirname(fixture.claudeActiveLink)).filter((name) => name.includes('pre-modeldeck')).length, 0);
});

// TRIPWIRE #590 round 2 (verify lane): a delete landing AFTER the flip must
// UNDO the flip. The old undo was a bare rename(dir → symlink) — ENOTDIR
// unconditionally, swallowed by .catch — which left ~/.claude a symlink to
// the deleted account's home and the real home stranded at the backup path.
test('adopt-legacy-home undoes the flip when the account is deleted after activation', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  // The race window: metadata refresh runs after the flip; the delete lands
  // inside it.
  fixture.service.refreshClaudeProfileMetadata = async (account) => {
    fixture.store.deleteAccount(claude.id);
    return account;
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /removed or disabled while the adoption was running/);
  assert.match(result.body.error, /previous Claude setup was restored/);
  // The flip was undone: the active link is the real legacy directory again,
  // never a symlink into a dead account's profile home.
  assert.equal(fs.lstatSync(fixture.claudeActiveLink).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), 'utf8'), '{"fixture":"legacy"}');
  // The backup slot was consumed by the restore — nothing stranded.
  assert.deepEqual(fs.readdirSync(path.dirname(fixture.claudeActiveLink)), ['.claude']);
  assert.deepEqual(fixture.store.listAccounts().filter((a) => a.provider === 'claude'), []);
});

// TRIPWIRE #590 round 2 (CodeRabbit stale-account finding): an update that
// repoints the account's profile home while the adoption copy runs must
// abort — the flow would otherwise activate a profile the record no longer
// names.
test('adopt-legacy-home aborts when the profile home is repointed mid-adoption', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const otherHome = path.join(fixture.root, 'claude-profiles', 'elsewhere');
  fs.mkdirSync(otherHome, { recursive: true, mode: 0o700 });
  const realAdopt = fixture.service.adoptClaudeLegacy;
  fixture.service.adoptClaudeLegacy = async (options) => {
    const copied = await realAdopt(options);
    fixture.store.saveAccount({ ...claude, profileRef: otherHome });
    return copied;
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /profile home was repointed while the adoption was running/);
  // No flip, no backup rename — the legacy home is untouched.
  assert.ok(fs.lstatSync(fixture.claudeActiveLink).isDirectory());
  assert.equal(fs.readFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), 'utf8'), '{"fixture":"legacy"}');
  assert.equal(fs.readdirSync(path.dirname(fixture.claudeActiveLink)).filter((name) => name.includes('pre-modeldeck')).length, 0);
  // The repointed record survives exactly as the update wrote it.
  assert.equal(fixture.store.getAccount(claude.id).profileRef, otherHome);
});

// TRIPWIRE #590 review MAJOR (live-session race): a rollback that fails must
// name the backup path in the error instead of swallowing it.
test('adopt-legacy-home names the backup path when the rollback cannot run', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, 'history.jsonl'), '{}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  // A live session recreates a non-empty ~/.claude in the window between the
  // backup rename and the flip; activation then refuses and the rollback
  // rename lands on the occupied path (ENOTEMPTY).
  fixture.service.activateClaude = async () => {
    fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fixture.claudeActiveLink, 'session-scratch.json'), '{}', { mode: 0o600 });
    throw new Error('Claude activation requires a one-time migration: move the existing directory aside at a quiet moment before activating: (fixture)');
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"fresh"}' });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /preserved at .*\.claude\.pre-modeldeck-/);
  assert.match(result.body.error, /could not move it back automatically/);
  // The named backup really holds the user's data.
  const backup = result.body.error.match(/preserved at (\S+);/)[1];
  assert.equal(fs.readFileSync(path.join(backup, 'history.jsonl'), 'utf8'), '{}');
});

// TRIPWIRE #590 round 2 (N1): shared scope writes .claude.json + a memory
// symlink into a brand-new profile home before the adoption offer runs —
// verified-ModelDeck artifacts must not dead-end adoption, while a recorded
// identity in .claude.json still refuses it.
test('adopt-legacy-home tolerates shared-scope artifacts but refuses a recorded identity', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  // The shared-scope shape of a just-created home: reconciled mcp document +
  // memory symlink at ModelDeck's own shared memory dir + explainer.
  const sharedMemory = fs.mkdtempSync(path.join(fixture.root, 'shared-memory-'));
  fixture.service.sharedScope.sharedMemoryDir = sharedMemory;
  fs.writeFileSync(path.join(fixture.claudeHome, '.claude.json'), '{"mcpServers":{}}', { mode: 0o600 });
  fs.writeFileSync(path.join(fixture.claudeHome, 'CLAUDE.md'), 'explainer', { mode: 0o600 });
  fs.symlinkSync(sharedMemory, path.join(fixture.claudeHome, 'memory'));

  const adopted = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(adopted.response.status, 200, JSON.stringify(adopted.body));
  assert.equal(fs.readFileSync(path.join(fixture.claudeHome, '.claude.json'), 'utf8'), '{"fixture":"legacy"}');

  // Same artifacts plus a recorded identity: refused, nothing destroyed.
  const secondHome = path.join(fixture.root, 'claude-profiles', 'second');
  fs.mkdirSync(secondHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(secondHome, '.claude.json'), '{"mcpServers":{},"oauthAccount":{"emailAddress":"kept@example.invalid"}}', { mode: 0o600 });
  const second = fixture.store.saveAccount({ provider: 'claude', label: 'Established', profileRef: secondHome });
  fs.unlinkSync(fixture.claudeActiveLink);
  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  const refused = await request(fixture, `/api/accounts/${second.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(refused.response.status, 400);
  assert.match(refused.body.error, /profile home is not empty/);
  assert.match(fs.readFileSync(path.join(secondHome, '.claude.json'), 'utf8'), /kept@example.invalid/);
});

// TRIPWIRE #590 round 2 (N2): a delete landing AFTER the flip must actually
// restore ~/.claude (unlink the symlink first — a directory cannot rename
// over one), never leave it pointing at a dead account's home.
test('adopt-legacy-home restores the real home when the account vanishes after the flip', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, 'history.jsonl'), '{}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  // The narrowest window: scopeClaudeSecureStorage runs right after the
  // flip; a delete landing there exercises the post-flip restore.
  const realScope = fixture.service.scopeClaudeSecureStorage.bind(fixture.service);
  fixture.service.scopeClaudeSecureStorage = async (profileRef) => {
    fixture.store.deleteAccount(claude.id);
    return realScope(profileRef);
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"fresh"}' });
  assert.equal(result.response.status, 409);
  const restored = fs.lstatSync(fixture.claudeActiveLink);
  assert.ok(restored.isDirectory() && !restored.isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(fixture.claudeActiveLink, 'history.jsonl'), 'utf8'), '{}');
  assert.equal(fixture.store.listAccounts().filter((a) => a.provider === 'claude').length, 0);
});

// TRIPWIRE #590 round 2 (N3): a MISSING ~/.claude is not "already managed" —
// the endpoint degenerates to a plain activation instead of letting the
// client skip the flip and recreate the original trap.
test('adopt-legacy-home with no legacy directory activates instead of claiming managed', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.backupPath, null);
  assert.equal(fs.readlinkSync(fixture.claudeActiveLink), fs.realpathSync(fixture.claudeHome));
});

// TRIPWIRE #590 round 3 (R3-A): in the no-legacy-directory branch, an
// account vanishing mid-activation must not leave ~/.claude pointing at the
// dead account's home — pre-call state was "no link", so restore is unlink.
test('adopt-legacy-home ENOENT branch unlinks the flip when the account vanishes', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const realScope = fixture.service.scopeClaudeSecureStorage.bind(fixture.service);
  fixture.service.scopeClaudeSecureStorage = async (profileRef) => {
    fixture.store.deleteAccount(claude.id);
    return realScope(profileRef);
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 409);
  assert.equal(fs.existsSync(fixture.claudeActiveLink), false);
});

// TRIPWIRE #590 round 3 (R3-B): adoption forgets the pre-adoption home's
// memory-merge bookkeeping so the reconcile treats the adopted home as new.
test('adoption resets the shared-scope memory-merge record for the account', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const manifestFile = fixture.service.sharedScope.manifestFile;
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifestFile, JSON.stringify({ memoryEnabled: true, mergedProfiles: [claude.id, 'other-account'] }), { mode: 0o600 });

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.deepEqual(manifest.mergedProfiles, ['other-account']);
});

// TRIPWIRE #590 round 3 (R3-C): a reconcile throw after the copy restores an
// empty profile home (retry never bricked by the emptiness guard), stamps no
// adoption metadata, and surfaces a plain-language error.
test('a failed post-adoption reconcile restores the empty home and keeps retry alive', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const realReconcile = fixture.service.accountProfileSetChanged.bind(fixture.service);
  fixture.service.accountProfileSetChanged = async () => { throw new Error('top-level user-memory path is not a directory'); };

  const failed = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(failed.response.status, 400);
  assert.match(failed.body.error, /shared settings were being reapplied/);
  assert.match(failed.body.error, /Start Fresh is still available/);
  assert.deepEqual(fs.readdirSync(claude.profileRef), []);
  assert.notEqual(fixture.store.getAccount(claude.id).metadata.adoptedLegacyHome, true);
  assert.ok(fs.lstatSync(fixture.claudeActiveLink).isDirectory());

  // With the reconcile healthy again the retry adopts cleanly.
  fixture.service.accountProfileSetChanged = realReconcile;
  const retried = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
  assert.equal(fs.readlinkSync(fixture.claudeActiveLink), fs.realpathSync(claude.profileRef));
});

// TRIPWIRE #590 round 4 (CodeRabbit major): a reconcile that dies AFTER the
// adopted memory reached the shared directory must not strand those copies —
// the retry re-copies the same items and collisionName would mint renamed
// duplicates of every one of them. The rollback removes exactly what the
// failed attach copied and nothing else.
test('a failed post-adoption reconcile removes the items it copied into shared memory', async (t) => {
  const fixture = await startFixture({
    // Inert engine timers: no watcher-scheduled reconcile may race the
    // deterministic fail-then-retry sequence below.
    sharedScopeSetTimeout: () => 0,
    sharedScopeClearTimeout: () => {},
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // Shared scope live before adoption, with one pre-existing shared item.
  fs.mkdirSync(path.join(fixture.claudeHome, 'memory'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeHome, 'memory', 'seed.md'), 'pre-adoption seed', { mode: 0o600 });
  const scope = fixture.service.sharedScope;
  await scope.enable();

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  fs.mkdirSync(path.join(fixture.claudeActiveLink, 'memory'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, 'memory', 'notes.md'), 'adopted memory', { mode: 0o600 });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  // Fail AFTER attachMemoryProfiles copied the adopted items into shared
  // memory: linkMemory is the step right behind the copy loop.
  const realLink = scope.linkMemory.bind(scope);
  scope.linkMemory = async () => { throw new Error('injected link failure'); };

  const failed = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(failed.response.status, 400);
  assert.match(failed.body.error, /shared settings were being reapplied/);
  assert.equal(fs.existsSync(path.join(scope.sharedMemoryDir, 'notes.md')), false);
  // The pre-existing shared item is untouched by the rollback.
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, 'seed.md'), 'utf8'), 'pre-adoption seed');

  scope.linkMemory = realLink;
  const retried = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
  // Exactly one copy of each item — no collision-renamed duplicates.
  assert.deepEqual(fs.readdirSync(scope.sharedMemoryDir).sort(), ['notes.md', 'seed.md']);
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, 'notes.md'), 'utf8'), 'adopted memory');
});

// TRIPWIRE #590 round 5 (CodeRabbit residual): other managed profiles stay
// symlinked at the shared memory directory while the adoption reconcile
// runs, so a live session can replace a just-copied item inside the failure
// window. The rollback must recognize the item is no longer the copy it made
// and keep the newer content — never delete by name alone.
test('the rollback keeps a shared-memory item another session replaced in the failure window', async (t) => {
  const fixture = await startFixture({
    sharedScopeSetTimeout: () => 0,
    sharedScopeClearTimeout: () => {},
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(path.join(fixture.claudeHome, 'memory'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeHome, 'memory', 'seed.md'), 'pre-adoption seed', { mode: 0o600 });
  const scope = fixture.service.sharedScope;
  await scope.enable();

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  fs.mkdirSync(path.join(fixture.claudeActiveLink, 'memory'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, 'memory', 'notes.md'), 'adopted memory', { mode: 0o600 });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  // linkMemory runs right after the copy loop: replace the copied item the
  // way a concurrently linked session would, then fail the reconcile.
  const realLink = scope.linkMemory.bind(scope);
  scope.linkMemory = async () => {
    fs.writeFileSync(path.join(scope.sharedMemoryDir, 'notes.md'), 'newer session write', { mode: 0o600 });
    throw new Error('injected link failure');
  };

  const failed = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(failed.response.status, 400);
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, 'notes.md'), 'utf8'), 'newer session write');

  scope.linkMemory = realLink;
  const retried = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
  // The session's write survives under its own name; the adopted copy lands
  // under a collision name instead of clobbering it.
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, 'notes.md'), 'utf8'), 'newer session write');
  const entries = fs.readdirSync(scope.sharedMemoryDir).sort();
  const collision = entries.find((name) => /^notes\.modeldeck-.+\.md$/.test(name));
  assert.ok(collision, JSON.stringify(entries));
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, collision), 'utf8'), 'adopted memory');
  assert.deepEqual(entries, [collision, 'notes.md', 'seed.md'].sort());
});

// TRIPWIRE #590 round 6 (CodeRabbit residual): checking identity and then
// deleting by path leaves a window where a linked session's replacement
// lands between the two and the delete destroys it. The rollback now renames
// the item to a quarantine path first, examines THAT path, and deletes only
// the quarantined inode — a replacement arriving at the original name at any
// moment survives. The afterUndoQuarantine hook injects the replacement
// deterministically inside the equivalent window.
test('the rollback preserves a replacement landing between identity check and delete', async (t) => {
  let onQuarantine = null;
  const fixture = await startFixture({
    sharedScopeSetTimeout: () => 0,
    sharedScopeClearTimeout: () => {},
    sharedScopeAfterUndoQuarantine: async (context) => { if (onQuarantine) await onQuarantine(context); },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(path.join(fixture.claudeHome, 'memory'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeHome, 'memory', 'seed.md'), 'pre-adoption seed', { mode: 0o600 });
  const scope = fixture.service.sharedScope;
  await scope.enable();

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  fs.mkdirSync(path.join(fixture.claudeActiveLink, 'memory'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, 'memory', 'notes.md'), 'adopted memory', { mode: 0o600 });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const realLink = scope.linkMemory.bind(scope);
  scope.linkMemory = async () => { throw new Error('injected link failure'); };
  // The copied item's identity matches its record, so without quarantine the
  // rollback would proceed to delete — this replacement lands exactly in the
  // window between the identity examination and the removal.
  onQuarantine = async ({ name }) => {
    if (name !== 'notes.md') return;
    fs.writeFileSync(path.join(scope.sharedMemoryDir, 'notes.md'), 'replacement inside the delete window', { mode: 0o600 });
  };

  const failed = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(failed.response.status, 400);
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, 'notes.md'), 'utf8'), 'replacement inside the delete window');
  // The quarantined stale copy was removed; no leftover quarantine entries.
  assert.deepEqual(fs.readdirSync(scope.sharedMemoryDir).sort(), ['notes.md', 'seed.md']);

  scope.linkMemory = realLink;
  onQuarantine = null;
  const retried = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, 'notes.md'), 'utf8'), 'replacement inside the delete window');
  const entries = fs.readdirSync(scope.sharedMemoryDir).sort();
  const collision = entries.find((name) => /^notes\.modeldeck-.+\.md$/.test(name));
  assert.ok(collision, JSON.stringify(entries));
  assert.equal(fs.readFileSync(path.join(scope.sharedMemoryDir, collision), 'utf8'), 'adopted memory');
});

// TRIPWIRE #590 (CodeRabbit thread, .claude.json replaceability): a missing
// oauthAccount proves nothing about authorship — a user's own .claude.json
// (theme, customApiKeyResponses, hand-written servers) has no signed-in
// identity either, and the presence-only test let adoption destroy it with a
// 200. Only the exact shared-scope-generated shape (an object holding
// nothing but an mcpServers object) is replaceable.
test('adoption refuses a user-authored .claude.json that merely lacks oauthAccount', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const userOwned = '{"mcpServers":{"mine":{"command":"placeholder"}},"theme":"dark","customApiKeyResponses":{"approved":[]}}';
  fs.writeFileSync(path.join(fixture.claudeHome, '.claude.json'), userOwned, { mode: 0o600 });

  const refused = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(refused.response.status, 400);
  assert.match(refused.body.error, /profile home is not empty/);
  // The user's file survives byte for byte, and nothing was activated.
  assert.equal(fs.readFileSync(path.join(fixture.claudeHome, '.claude.json'), 'utf8'), userOwned);
  assert.ok(fs.lstatSync(fixture.claudeActiveLink).isDirectory());
});

// TRIPWIRE #590 (CodeRabbit follow-up on the same thread): writeMcpDocument
// always emits the mcpServers key, so a bare {} is not provably
// ModelDeck-authored — it blocks adoption like any other unrecognized
// content instead of being guessed replaceable.
test('adoption refuses a destination .claude.json containing a bare empty object', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  fs.writeFileSync(path.join(fixture.claudeHome, '.claude.json'), '{}', { mode: 0o600 });

  const refused = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(refused.response.status, 400);
  assert.match(refused.body.error, /profile home is not empty/);
  assert.equal(fs.readFileSync(path.join(fixture.claudeHome, '.claude.json'), 'utf8'), '{}');
  assert.ok(fs.lstatSync(fixture.claudeActiveLink).isDirectory());
});

// TRIPWIRE #590 (CodeRabbit thread, pin rollback — post-flip race): the
// scope call after the flip re-aims the shell pin at the new profile home;
// a delete landing right after it used to roll back only ~/.claude, leaving
// the pin pointing at the profile home the rollback itself just deleted.
test('the post-flip rollback restores the previous shell pin state', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const previousPin = '# previous pin content\n';
  fs.writeFileSync(fixture.service.claudeShellEnvFile, previousPin, { mode: 0o600 });
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const realScope = fixture.service.scopeClaudeSecureStorage.bind(fixture.service);
  fixture.service.scopeClaudeSecureStorage = async (profileRef) => {
    fixture.store.deleteAccount(claude.id);
    return realScope(profileRef);
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 409);
  // Filesystem rollback held (legacy home back in place, copy removed) …
  assert.ok(fs.lstatSync(fixture.claudeActiveLink).isDirectory());
  // … and the pin is the pre-operation one — it must not reference the
  // deleted profile home.
  assert.equal(fs.readFileSync(fixture.service.claudeShellEnvFile, 'utf8'), previousPin);
});

// TRIPWIRE #590 (CodeRabbit thread, pin rollback — no-legacy branch): with
// no pin before the call, the rollback removes the one the scope call wrote
// instead of leaving it aimed at the dead account's home.
test('the no-legacy rollback clears the shell pin the scope call wrote', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const realScope = fixture.service.scopeClaudeSecureStorage.bind(fixture.service);
  fixture.service.scopeClaudeSecureStorage = async (profileRef) => {
    fixture.store.deleteAccount(claude.id);
    return realScope(profileRef);
  };

  const result = await request(fixture, `/api/accounts/${claude.id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(result.response.status, 409);
  assert.equal(fs.existsSync(fixture.claudeActiveLink), false);
  assert.equal(fs.existsSync(fixture.service.claudeShellEnvFile), false);
});

// TRIPWIRE #586 (recorded comment: retry-pileup): repeated blocked attempts
// must never clobber anything or collide profile homes, and the orphans they
// leave are individually removable without touching the survivor.
test('repeated blocked add attempts accumulate no damage and clean up account by account', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture.claudeActiveLink, '.claude.json'), '{"fixture":"legacy"}', { mode: 0o600 });
  const seeded = fixture.store.listAccounts().find((account) => account.provider === 'claude');

  const created = [seeded];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const home = path.join(fixture.root, 'claude-profiles', `retry-${attempt}`);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    created.push(fixture.store.saveAccount({ provider: 'claude', label: 'Insight', profileRef: home }));
    const blocked = await request(fixture, `/api/accounts/${created.at(-1).id}/activate`, { method: 'POST', body: '{}' });
    assert.equal(blocked.body.code, 'active-link-blocked');
  }
  assert.equal(new Set(created.map((account) => account.profileRef)).size, 3);
  assert.ok(fs.lstatSync(fixture.claudeActiveLink).isDirectory());

  const adopted = await request(fixture, `/api/accounts/${created[2].id}/adopt-legacy-home`, { method: 'POST', body: '{"mode":"adopt"}' });
  assert.equal(adopted.response.status, 200);
  for (const orphan of created.slice(0, 2)) {
    const gone = await request(fixture, `/api/accounts/${orphan.id}`, { method: 'DELETE' });
    assert.equal(gone.response.status, 200);
  }
  assert.equal(fixture.store.listAccounts().filter((a) => a.provider === 'claude').length, 1);
  assert.equal(fs.readlinkSync(fixture.claudeActiveLink), fs.realpathSync(created[2].profileRef));
});

test('Claude activation response warns about running unpinned sessions (issue #66)', async (t) => {
  const fixture = await startFixture({ listProviderProcesses: async () => ['claude'] });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const result = await request(fixture, `/api/accounts/${claude.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.warnings.length, 1);
  assert.match(result.body.warnings[0], /^1 running Claude session may lose session storage/);
});

test('tool probes compare versions, cache results, force refresh, and contain registry failures', async (t) => {
  let execCalls = 0;
  let registryCalls = 0;
  let failCodexRegistry = false;
  const fixture = await startFixture({
    claudePath: 'claude-fixture',
    codexPath: 'codex-fixture',
    exec: async (binary, args) => {
      execCalls += 1;
      assert.deepEqual(args, ['--version']);
      return { stdout: binary === 'claude-fixture' ? 'Claude Code 1.2.3' : 'codex-cli 2.0.0' };
    },
    registryFetch: async (url) => {
      registryCalls += 1;
      if (failCodexRegistry && url.includes('@openai')) throw new Error('registry unavailable');
      return { ok: true, json: async () => ({ version: url.includes('@anthropic-ai') ? '1.3.0' : '2.0.0' }) };
    },
    toolProbeTtlMs: 60_000,
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(fixture.codexHome, 'auth.json'), '{}');
  fixture.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: fixture.codexHome, isDefault: true });

  let result = await request(fixture, '/api/tools');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.tools.claude.version, '1.2.3');
  assert.equal(result.body.tools.claude.latestVersion, '1.3.0');
  assert.equal(result.body.tools.claude.updateAvailable, true);
  assert.equal(result.body.tools.codex.updateAvailable, false);
  assert.equal(result.body.tools.codex.authState, 'ok');
  assert.equal(execCalls, 2);
  assert.equal(registryCalls, 2);

  await request(fixture, '/api/tools');
  assert.equal(execCalls, 2);
  assert.equal(registryCalls, 2);

  failCodexRegistry = true;
  const unauthorized = await request(fixture, '/api/tools?refresh=1');
  assert.equal(unauthorized.response.status, 403);
  assert.equal(execCalls, 2);

  result = await request(fixture, '/api/tools?refresh=1', {
    headers: { 'X-ModelDeck-Token': fixture.token, Cookie: fixture.cookie },
  });
  assert.equal(execCalls, 4);
  assert.equal(registryCalls, 4);
  assert.equal(result.body.tools.codex.latestVersion, null);
  assert.equal(result.body.tools.codex.updateAvailable, null);
  assert.match(result.body.tools.codex.error, /registry unavailable/);
});

test('state exposes per-account auth and update endpoint returns 409 for an unsupported install method', async (t) => {
  const fixture = await startFixture({
    claudePath: 'claude-fixture',
    claudeCredentialsPresent: async ({ claudeConfigDir }) => claudeConfigDir === fixture.claudeHome,
    migrateClaude: async () => [{
      label: 'Imported', profileRef: path.join(fixture.root, 'claude-profiles', 'imported'),
    }],
    realpath: async () => '/Users/fixture/.local/bin/claude',
    exec: async (command, args) => {
      if (command === '/usr/bin/which') return { stdout: '/Users/fixture/.local/bin/claude\n' };
      if (args[0] === '--version') return { stdout: 'Claude Code 1.0.0' };
      return { stdout: 'codex 1.0.0' };
    },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const state = await request(fixture, '/api/state');
  assert.equal(state.body.accounts[0].authState, 'ok');

  const migrated = await request(fixture, '/api/claude/migrate-cswap', {
    method: 'POST', body: JSON.stringify({ selections: [{ label: 'Imported' }] }),
  });
  assert.equal(migrated.response.status, 201);
  assert.equal(migrated.body.accounts[0].authState, 'signin-required');

  const result = await request(fixture, '/api/tools/claude/update', { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /unsupported direct\/native install method/);
});

test('migrate-cswap succeeds when explainer installation fails', async (t) => {
  const fixture = await startFixture({
    migrateClaude: async () => [{
      label: 'Imported', profileRef: path.join(fixture.root, 'claude-profiles', 'imported'),
    }],
    reconcileClaudeProfileExplainer: async () => { throw new Error('fixture explainer write failure'); },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const migrated = await request(fixture, '/api/claude/migrate-cswap', {
    method: 'POST', body: JSON.stringify({ selections: [{ label: 'Imported' }] }),
  });
  assert.equal(migrated.response.status, 201);
  assert.equal(migrated.body.accounts[0].label, 'Imported');
});

// Issue #89: /api/state carries each account's last refresh failure
// ({message, at}) and flips authState to signin-required when the failure
// means the stored credentials are unusable — even though the presence
// probe still sees the (expired) credentials.
test('state surfaces per-account refresh errors and flips authState on expired stored OAuth', async (t) => {
  const fixture = await startFixture({
    claudeCredentialsPresent: async () => true,
    fetchClaude: async () => {
      throw new Error('Claude usage refresh failed: stored OAuth credentials have expired; sign in explicitly before refreshing');
    },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // Before any refresh: no error field at all, presence says healthy.
  let state = (await request(fixture, '/api/state')).body;
  assert.equal(state.accounts[0].authState, 'ok');
  assert.equal(state.accounts[0].lastRefreshError, undefined);

  const refresh = await request(fixture, '/api/refresh', { method: 'POST', body: '{}' });
  assert.equal(refresh.body.claude.ok, false);

  state = (await request(fixture, '/api/state')).body;
  const account = state.accounts[0];
  assert.equal(account.authState, 'signin-required');
  assert.match(account.lastRefreshError.message, /sign in explicitly before refreshing/);
  assert.ok(!Number.isNaN(Date.parse(account.lastRefreshError.at)));
});

test('credential expiry used by refresh never reaches API payloads (issue #265)', async (t) => {
  const expiresAt = Date.parse('2098-07-06T05:04:03.210Z');
  const fixture = await startFixture({
    fetchClaude: async () => claudeSnapshotsExpiringAt(expiresAt),
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const refresh = await request(fixture, '/api/refresh', { method: 'POST', body: '{}' });
  assert.equal(refresh.response.status, 200);
  const state = await request(fixture, '/api/state');
  assert.equal(state.response.status, 200);

  for (const payload of [refresh.body, state.body]) {
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, new RegExp(String(expiresAt)));
    assert.doesNotMatch(serialized, new RegExp(new Date(expiresAt).toISOString().replaceAll('.', '\\.')));
    assert.doesNotMatch(serialized, /"expiresAt"/);
  }
});

test('settings API validates partial updates and drives worst-capacity thresholds', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  const reschedules = [];
  const rescheduleAutoRefresh = fixture.service.rescheduleAutoRefresh.bind(fixture.service);
  fixture.service.rescheduleAutoRefresh = (settings) => {
    reschedules.push(settings);
    return rescheduleAutoRefresh(settings);
  };

  let result = await request(fixture, '/api/settings');
  assert.deepEqual(result.body, {
    claudeManaged: true,
    codexManaged: true,
    autoRefreshEnabled: true,
    autoRenewEnabled: true,
    otelReceiverEnabled: false,
    autoRefreshIntervalSeconds: 300,
    autoRefreshIntervalCustomized: false,
    // Issue #187: pause-while-active is opt-in — live updates during an
    // active session are the default experience.
    pauseWhileActive: false,
    sharedUserScopeEnabled: false,
    usageQueueConsumerEnabled: false,
    proxyRole: 'host',
    // Issue #788: no pool hub page until the operator sets one.
    poolHubUrl: '',
    layout: 'two-column',
    defaultSort: 'next-reset',
    notificationThresholdPercent: 25,
    menuBarStyle: 'icon-only',
    menuBarAccountId: '',
    menuBarShowWhen: '',
    // Issue #488: shared pool-total format — '' = nothing chosen (sum).
    poolTotalFormat: '',
    // Issue #242: deck chip labels — '' = dot only (default).
    deckHealthLabels: '',
    // TRIPWIRE (#388): 0.4.6 defaults the dashboard ON for a new database.
    usageAnalyticsEnabled: true,
    // Issue #605: extra read-only transcript scan roots — none by default.
    extraClaudeScanRoots: [],
  });
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ layout: 'single-column', notificationThresholdPercent: 30 }) });
  assert.equal(result.body.layout, 'single-column');
  assert.equal(result.body.autoRefreshEnabled, true);
  assert.equal(result.body.autoRenewEnabled, true);
  assert.equal(reschedules.length, 1);

  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ autoRenewEnabled: false }) });
  assert.equal(result.body.autoRenewEnabled, false);
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ autoRenewEnabled: 'yes' }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /autoRenewEnabled/);
  assert.equal(reschedules[0].notificationThresholdPercent, 30);

  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ autoRefreshIntervalSeconds: 30 }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /60 to 3600/);
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ surprise: true }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /unknown setting: surprise/);
  assert.equal(reschedules.length, 2);

  // Menu bar pinned account: any short string round-trips ('' = lowest
  // across accounts); non-strings are rejected.
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ menuBarAccountId: 'acc-42' }) });
  assert.equal(result.body.menuBarAccountId, 'acc-42');
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ menuBarAccountId: 7 }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /menuBarAccountId/);
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ menuBarAccountId: '' }) });
  assert.equal(result.body.menuBarAccountId, '');

  // Issue #238 quiet mode: menuBarShowWhen is a free short string like the
  // pin ('' = always; the app owns the grammar); non-strings are rejected.
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ menuBarShowWhen: 'below:25' }) });
  assert.equal(result.body.menuBarShowWhen, 'below:25');
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ menuBarShowWhen: 9 }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /menuBarShowWhen/);
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ menuBarShowWhen: '' }) });
  assert.equal(result.body.menuBarShowWhen, '');

  // Issue #242 deck chip labels: same free-short-string contract ('' = dot
  // only; the app owns the grammar); non-strings are rejected.
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ deckHealthLabels: 'show' }) });
  assert.equal(result.body.deckHealthLabels, 'show');
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ deckHealthLabels: 9 }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /deckHealthLabels/);
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ deckHealthLabels: '' }) });
  assert.equal(result.body.deckHealthLabels, '');

  const first = fixture.store.saveAccount({ provider: 'claude', label: 'First', profileRef: 'first' });
  const second = fixture.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: 'second' });
  const disabled = fixture.store.saveAccount({ provider: 'claude', label: 'Disabled', profileRef: 'third', enabled: false });
  fixture.store.recordUsage(first.id, { scope: 'weekly', usedPercent: 60, resetsAt: '2026-07-25T20:00:00Z', observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });
  fixture.store.recordUsage(first.id, { scope: '5-hour', usedPercent: null, observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });
  fixture.store.recordUsage(second.id, { scope: 'weekly', usedPercent: 80, observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });
  fixture.store.recordUsage(disabled.id, { scope: 'weekly', usedPercent: 95, observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });

  result = await request(fixture, '/api/capacity/worst');
  assert.equal(result.body.status, 'warn');
  assert.equal(result.body.iconState, 'gold');
  assert.equal(result.body.worst.accountId, second.id);
  assert.equal(result.body.worst.remainingPercent, 20);
  assert.equal(result.body.thresholdPercent, 30);
  assert.equal(result.body.accountsEvaluated, 2);
  assert.equal(result.body.windowsEvaluated, 2);
  assert.deepEqual(result.body.excluded.map((row) => row.reason).sort(), ['account disabled', 'usage unavailable']);
});

test('add-account flow: create, login spec, verify, and reference-only delete', async (t) => {
  const readCalls = { claude: 0, codex: 0 };
  const daemonClaudePath = '/fixture/daemon-bin/claude';
  const canonicalClaudePath = '/fixture/Claude Code/claude';
  const fixture = await startFixture({
    // Issue #99: pin the detected CLI below the resolved-home floor so the
    // login spec deterministically exercises the legacy env-scoped flow
    // (never the machine's real `claude --version`).
    exec: async (binary, args) => {
      if (binary === '/usr/bin/which') return { stdout: `${daemonClaudePath}\n` };
      if (args?.[0] === '--version') return { stdout: 'Claude Code 2.1.215' };
      return { stdout: '' };
    },
    realpath: async (value) => value === daemonClaudePath
      ? canonicalClaudePath
      : fs.promises.realpath(value),
    readClaudeAuth: async ({ claudeConfigDir }) => {
      readCalls.claude += 1;
      readCalls.claudeConfigDir = claudeConfigDir;
      return {
        authenticated: true,
        identity: 'user@example.invalid',
        plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', displayName: 'Ultra' },
      };
    },
    readCodexAuth: async ({ codexHome }) => {
      readCalls.codex += 1;
      readCalls.codexHome = codexHome;
      return { authenticated: true, identity: 'dev@example.com', plan: { planType: 'plus' } };
    },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // Step 1 (codex): no profileRef → the daemon creates the owner-only home.
  let result = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'codex', label: 'Deck Codex', purpose: 'testing', color: '#48a868' }),
  });
  assert.equal(result.response.status, 201);
  const codexAccount = result.body.account;
  assert.ok(codexAccount.profileRef.startsWith(fs.realpathSync(fixture.service.codexProfilesDir)));
  assert.equal(fs.statSync(codexAccount.profileRef).mode & 0o777, 0o700);

  // Step 1 (claude): the #17 seam creates the managed profile home.
  result = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'claude', label: 'Deck Claude', purpose: 'testing', color: '#d97757' }),
  });
  assert.equal(result.response.status, 201);
  const claudeAccount = result.body.account;

  // Step 2: login specs are provider-owned commands, never logouts. On a
  // pre-2.1.216 CLI the Claude spec stays env-scoped (issue #99).
  result = await request(fixture, `/api/accounts/${claudeAccount.id}/login`);
  assert.equal(result.response.status, 200);
  assert.match(result.body.command, /CLAUDE_CONFIG_DIR=.*claude.* auth login$/);
  assert.match(result.body.command, /'\/fixture\/Claude Code\/claude' auth login$/);
  assert.ok(!result.body.command.includes('logout'));
  assert.equal(result.body.flow, 'config-dir');
  assert.equal(result.body.requiresActivation, false);
  result = await request(fixture, `/api/accounts/${codexAccount.id}/login`);
  assert.match(result.body.command, /CODEX_HOME=.*codex.* login$/);
  assert.ok(!result.body.command.includes('logout'));
  // Codex steering is unaffected by #99 — no flow marker.
  assert.equal('flow' in result.body, false);
  assert.equal('requiresActivation' in result.body, false);
  result = await request(fixture, '/api/accounts/nope/login');
  assert.equal(result.response.status, 404);

  // Step 3: verify reads back the identity and persists it on the account.
  result = await request(fixture, `/api/accounts/${claudeAccount.id}/verify`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.authenticated, true);
  assert.equal(result.body.identity, 'user@example.invalid');
  assert.equal(result.body.account.identity, 'user@example.invalid');
  assert.equal(result.body.account.purpose, 'testing');
  assert.equal(result.body.account.color, '#d97757');
  assert.equal(readCalls.claudeConfigDir, claudeAccount.profileRef);
  assert.equal(fixture.store.getAccount(claudeAccount.id).identity, 'user@example.invalid');
  // Issue #26 (Claude half): the same status read persists the plan facts.
  // Issue #825: and the plan display name.
  assert.deepEqual(fixture.store.getAccount(claudeAccount.id).metadata.claudePlan, {
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    displayName: 'Ultra',
  });
  assert.deepEqual(result.body.account.metadata.claudePlan, {
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    displayName: 'Ultra',
  });

  // Codex verify surfaces display-ready plan metadata while retaining the raw
  // JWT claim for future UI mapping changes.
  result = await request(fixture, `/api/accounts/${codexAccount.id}/verify`, { method: 'POST' });
  assert.equal(result.body.authenticated, true);
  assert.equal(result.body.identity, 'dev@example.com');
  assert.deepEqual(result.body.account.metadata.codexPlan, {
    planType: 'plus',
    displayName: 'Plus',
  });
  assert.deepEqual(fixture.store.getAccount(codexAccount.id).metadata.codexPlan, {
    planType: 'plus',
    displayName: 'Plus',
  });
  assert.equal(readCalls.codexHome, codexAccount.profileRef);

  // Verify is a mutation: it must be token-gated.
  const bare = await fetch(`${fixture.base}/api/accounts/${claudeAccount.id}/verify`, { method: 'POST' });
  assert.equal(bare.status, 403);

  // Remove account: reference-only — the profile home stays on disk.
  result = await request(fixture, `/api/accounts/${codexAccount.id}`, { method: 'DELETE' });
  assert.equal(result.body.deleted, true);
  assert.ok(fs.existsSync(codexAccount.profileRef));
});

// Issue #99's historical >=2.1.216 boundary keeps this login spec
// activation-driven, and verify must refuse a read-back identity that
// contradicts the intended account instead of laundering it. Issue #596:
// the served command also carries the profile env pin — activation steers
// the credential on affected releases, the pin steers the .claude.json
// identity write in shells that have no pin of their own.
test('historical-boundary CLI: activation-driven login spec and identity-mismatch refusal', async (t) => {
  const daemonClaudePath = '/fixture/daemon-bin/claude';
  const canonicalClaudePath = '/fixture/Claude Code/claude';
  const fixture = await startFixture({
    exec: async (binary, args) => {
      if (binary === '/usr/bin/which') return { stdout: `${daemonClaudePath}\n` };
      if (args?.[0] === '--version') return { stdout: 'Claude Code 2.1.216' };
      return { stdout: '' };
    },
    realpath: async (value) => value === daemonClaudePath
      ? canonicalClaudePath
      : fs.promises.realpath(value),
    readClaudeAuth: async () => ({
      authenticated: true,
      identity: 'other@example.invalid',
      plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    }),
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const seeded = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  fixture.store.saveAccount({ ...seeded, identity: 'intended@example.invalid' });

  // The spec drives sign-in through activation AND pins the profile env
  // (issue #596 tripwire): the served command must never depend on the
  // invoking shell's environment for where the identity write lands.
  let result = await request(fixture, `/api/accounts/${seeded.id}/login`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.flow, 'activation');
  assert.equal(result.body.requiresActivation, true);
  assert.match(result.body.command, /claude.* \/login$/);
  const realProfile = fs.realpathSync(seeded.profileRef);
  assert.equal(
    result.body.command,
    `${CLAUDE_MANAGED_KEY_UNSET_FRAGMENT}; CLAUDE_CONFIG_DIR='${realProfile}' CLAUDE_SECURESTORAGE_CONFIG_DIR='${realProfile}' '${canonicalClaudePath}' /login`,
  );
  assert.ok(!result.body.command.includes('logout'));

  // Post-login read-back disagrees with the intended account: the response
  // names the mismatch, reports no bare success, and records nothing.
  result = await request(fixture, `/api/accounts/${seeded.id}/verify`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.authenticated, true);
  assert.deepEqual(result.body.identityMismatch, {
    expected: 'intended@example.invalid',
    actual: 'other@example.invalid',
  });
  const stored = fixture.store.getAccount(seeded.id);
  assert.equal(stored.identity, 'intended@example.invalid');
  assert.equal(stored.metadata.claudePlan, undefined);

  // A failed read-back whose credential landed in Claude's unhashed service
  // carries an additive diagnostic on /verify only. No Keychain-derived
  // state is persisted or copied into the ordinary state payload.
  fixture.service.readClaudeAuth = async () => ({ authenticated: false, identity: null });
  fixture.service.claudeCredentialKeychainSlotState = async () => ({
    profileScoped: false,
    unscoped: true,
  });
  result = await request(fixture, `/api/accounts/${seeded.id}/verify`, { method: 'POST' });
  assert.equal(result.body.authenticated, false);
  assert.equal(result.body.verifyHint, CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT);
  const state = await request(fixture, '/api/state');
  assert.equal(JSON.stringify(state.body).includes('verifyHint'), false);
  assert.equal(JSON.stringify(fixture.store.getAccount(seeded.id)).includes('verifyHint'), false);
});

test('codex profile homes outside the managed directory are rejected end to end', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // Caller-supplied out-of-tree CODEX_HOME: refused by the service upsert
  // (PR #20 CodeRabbit review — parity with the Claude containment check).
  const outside = path.join(fixture.root, 'outside-codex');
  fs.mkdirSync(outside, { mode: 0o700 });
  const rejected = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'codex', label: 'Stray Codex', profileRef: outside }),
  });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.error, /must be inside ModelDeck's profiles directory/);

  // An in-tree home passes through the same path unchanged.
  const accepted = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'codex', label: 'Managed Codex', profileRef: fixture.codexHome }),
  });
  assert.equal(accepted.response.status, 201);

  // Legacy/out-of-tree rows (inserted below the service seam) can never leak
  // into a login command either.
  const stray = fixture.store.saveAccount({ provider: 'codex', label: 'Stray Row', profileRef: outside });
  const login = await request(fixture, `/api/accounts/${stray.id}/login`);
  assert.equal(login.response.status, 400);
  assert.match(login.body.error, /must be inside ModelDeck's profiles directory/);
});
