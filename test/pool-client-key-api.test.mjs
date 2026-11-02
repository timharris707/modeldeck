import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';
import { clientKeyService, clientKeyHelperCommand } from '../src/client-key-helper.mjs';

const TOKEN = 'pool-key-placeholder-token';
const HASH = 'a'.repeat(64);
const ENTRY = { keySha256: HASH, machine: 'client-one', profileSlug: 'work', profileLabel: 'Work' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-pool-keys-'));
  const profiles = path.join(root, 'profiles');
  const home = path.join(profiles, 'work');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:43279' } }));
  const store = new Store(':memory:');
  store.saveSettings({ claudeManaged: true, autoRenewEnabled: false });
  const calls = [];
  const service = new ModelDeckService(store, {
    dataDir: root, claudeProfilesDir: profiles,
    claudeActiveLink: path.join(root, 'active'), codexActiveLink: path.join(root, 'codex-active'),
    cliproxyConfigDir: path.join(root, 'proxy'), claudeShellEnvFile: path.join(root, 'env.sh'),
    platform: 'darwin', exec: async (...args) => { calls.push(args); return { stdout: '' }; },
    listProviderProcesses: async () => [],
  });
  const account = store.saveAccount({ provider: 'claude', label: 'Work', profileRef: home });
  const app = createApp({ store, service, port: 43290, mutationToken: TOKEN });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, service, app, account, calls, home };
}

async function request(data, route = '/api/pool-client-keys', { method = 'GET', body, auth = true, headers = {} } = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url: route, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:43290', 'content-type': 'application/json',
      ...(auth ? { 'x-modeldeck-token': TOKEN, cookie: `modeldeck_session=${TOKEN}` } : {}), ...headers },
  });
  let status;
  let result;
  await data.app.server.listeners('request')[0](req, {
    writeHead(value) { status = value; }, end(value) { result = JSON.parse(String(value)); },
  });
  return { status, body: result };
}

test('#786 pool-key API requires mutation auth, validates whole batches, and exposes only hash prefixes', async (t) => {
  const data = fixture(t);
  for (const headers of [{}, { 'x-modeldeck-token': TOKEN }, { cookie: `modeldeck_session=${TOKEN}` }]) {
    assert.equal((await request(data, undefined, { method: 'POST', body: { add: [ENTRY] }, auth: false, headers })).status, 403);
  }
  assert.equal((await request(data, undefined, { method: 'POST', body: { add: [ENTRY] }, headers: { origin: 'https://foreign.invalid' } })).status, 403);
  const invalid = [null, {}, { add: [], revoke: [] }, { add: 'bad' }, { revoke: ['short'] },
    { revoke: ['A'.repeat(64)] },
    ...[
      { keySha256: 'A'.repeat(64) }, { keySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      { keySha256: 'raw-placeholder' }, { machine: '' }, { machine: 'bad label' }, { machine: 'a'.repeat(65) },
      { profileSlug: 'work;false' }, { profileLabel: 'bad\nlabel' }, { profileLabel: 42 },
      { profileLabel: 'bad\u202elabel' }, { profileLabel: 'bad\u200blabel' }, { profileLabel: 'x'.repeat(129) },
    ].map((patch) => ({ add: [ENTRY, { ...ENTRY, ...patch }] })),
  ];
  for (const body of invalid) {
    assert.equal((await request(data, undefined, { method: 'POST', body })).status, 400);
    assert.equal(data.store.poolClientKeys().length, 0);
  }
  assert.equal((await request(data, undefined, { method: 'POST', body: { add: [ENTRY] } })).status, 200);
  const listed = await request(data, undefined, { auth: false });
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.body.keys[0]).sort(), ['machine', 'profileSlug', 'profileLabel', 'createdAt', 'revokedAt', 'hashPrefix'].sort());
  assert.equal(listed.body.keys[0].hashPrefix, 'aaaaaaaa');
  assert.equal(JSON.stringify(listed).includes(HASH), false);
  const revoked = await request(data, undefined, { method: 'POST', body: { revoke: [HASH] } });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.keys[0].revokedAt);
});

test('#786 pool-key endpoints refuse remote role with 409', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ proxyRole: 'remote' });
  for (const options of [{}, { method: 'POST', body: { add: [ENTRY] } }, { method: 'POST', body: { revoke: [HASH] } },
    { method: 'POST', body: { revokeWhere: { machine: 'client-one' } } }]) {
    const response = await request(data, undefined, options);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'proxy-role-remote');
  }
  assert.equal(data.store.poolClientKeys().length, 0);
});

test('#786 revokeWhere is token-gated and revokes only explicit hashes and initial absent prefixes', async (t) => {
  const data = fixture(t);
  const rows = [ENTRY,
    { ...ENTRY, keySha256: 'b'.repeat(64), profileSlug: 'other' },
    { ...ENTRY, keySha256: 'c'.repeat(64), machine: 'client-two' },
    { ...ENTRY, keySha256: 'd'.repeat(64), profileSlug: null },
  ];
  await request(data, undefined, { method: 'POST', body: { add: rows } });
  const post = (body, auth = true) => request(data, undefined, { method: 'POST', body, auth });
  const selection = { revokeWhere: { machine: 'client-one', profileSlug: 'work', keySha256s: [HASH], hashPrefixes: [] } };
  assert.equal((await post(selection, false)).status, 403);
  for (const body of [
    { revokeWhere: null }, { revokeWhere: {} }, { revokeWhere: [] },
    { revokeWhere: { machine: 'bad label' } }, { revokeWhere: { machine: 'client-one', profileSlug: '../bad' } },
    { revokeWhere: { machine: 'client-one', exceptKeySha256: 'short' } },
    { revokeWhere: { machine: 'client-one' } },
    ...[
      { keySha256s: null }, { keySha256s: ['short'] }, { keySha256s: Array(1001).fill(HASH) },
      { hashPrefixes: null }, { hashPrefixes: ['abcdefg'] }, { hashPrefixes: ['AAAAAAAA'] },
      { hashPrefixes: [HASH] }, { hashPrefixes: Array(1001).fill('aaaaaaaa') },
      { unknown: true },
    ].map((patch) => ({ revokeWhere: { ...selection.revokeWhere, ...patch } })),
    { ...selection, revoke: [HASH] }, { ...selection, add: [ENTRY] },
  ]) assert.equal((await post(body)).status, 400);
  assert.ok(data.store.poolClientKeys().every((row) => !row.revokedAt));
  const result = await post(selection);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.revokedPrefixes, ['aaaaaaaa']);
  assert.equal(JSON.stringify(result).includes(HASH), false);
  assert.equal(data.store.poolClientKeys().filter((row) => row.revokedAt).length, 1);
  assert.deepEqual((await post(selection)).body.revokedPrefixes, [], 'only newly revoked prefixes are reported');
  assert.deepEqual((await post({ revokeWhere: { machine: 'client-one', profileSlug: null, keySha256s: [], hashPrefixes: ['dddddddd'] } })).body.revokedPrefixes, ['dddddddd']);
  assert.deepEqual((await post({ revokeWhere: { machine: 'client-one', keySha256s: [], hashPrefixes: [] } })).body.revokedPrefixes, []);
  assert.deepEqual((await post({ revokeWhere: { machine: 'client-one', keySha256s: [], hashPrefixes: ['bbbbbbbb'] } })).body.revokedPrefixes, ['bbbbbbbb']);
  assert.equal(data.store.poolClientKeys().find((row) => row.machine === 'client-two').revokedAt, null);
});

test('#786 revokeWhere refuses a broad selection without an explicit set', async (t) => {
  const data = fixture(t);
  data.store.addPoolClientKey(ENTRY);
  const result = await request(data, undefined, { method: 'POST', body: { revokeWhere: { machine: 'client-one' } } });
  assert.equal(result.status, 400);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
});

test('#786 revokeWhere leaves mid-run rows active and scopes exact hashes to machine/profile', async (t) => {
  const data = fixture(t);
  const stale = { ...ENTRY, keySha256: 'b'.repeat(64) };
  const concurrent = { ...ENTRY, keySha256: 'c'.repeat(64) };
  const otherProfile = { ...ENTRY, keySha256: 'd'.repeat(64), profileSlug: 'other' };
  const otherMachine = { ...ENTRY, keySha256: 'e'.repeat(64), machine: 'client-two' };
  for (const entry of [ENTRY, stale, otherProfile, otherMachine]) data.store.addPoolClientKey(entry);
  const listed = await request(data);
  const hashPrefixes = listed.body.keys.filter((row) => row.hashPrefix === 'bbbbbbbb').map((row) => row.hashPrefix);
  data.store.addPoolClientKey(concurrent);
  const result = await request(data, undefined, { method: 'POST', body: { revokeWhere: {
    machine: 'client-one', profileSlug: 'work', keySha256s: [HASH, otherProfile.keySha256, otherMachine.keySha256], hashPrefixes,
  } } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.revokedPrefixes.sort(), ['aaaaaaaa', 'bbbbbbbb']);
  for (const entry of [concurrent, otherProfile, otherMachine]) {
    assert.equal(data.store.poolClientKeys().find((row) => row.keySha256 === entry.keySha256).revokedAt, null);
  }
  for (const entry of [ENTRY, stale, concurrent]) assert.equal(JSON.stringify(result).includes(entry.keySha256), false);
});

test('#786 revokeWhere refuses ambiguous absent prefixes atomically, including revoked collisions', async (t) => {
  for (const revoked of [false, true]) {
    const data = fixture(t);
    const collision = { ...ENTRY, keySha256: `aaaaaaaa${'0'.repeat(56)}` };
    const exact = { ...ENTRY, keySha256: 'b'.repeat(64) };
    for (const row of [ENTRY, collision, exact]) data.store.addPoolClientKey(row);
    if (revoked) data.store.revokePoolClientKey(collision.keySha256);
    const before = data.store.poolClientKeys();
    const result = await request(data, undefined, { method: 'POST', body: { revokeWhere: {
      machine: 'client-one', profileSlug: 'work', keySha256s: [exact.keySha256], hashPrefixes: ['aaaaaaaa'],
    } } });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /ambiguous hash prefix aaaaaaaa/);
    assert.deepEqual(data.store.poolClientKeys(), before);
    const precise = await request(data, undefined, { method: 'POST', body: { revokeWhere: {
      machine: 'client-one', profileSlug: 'work', keySha256s: [HASH], hashPrefixes: [],
    } } });
    assert.equal(precise.status, 200);
    assert.deepEqual(precise.body.revokedPrefixes, ['aaaaaaaa']);
  }
});

test('#786 revokeWhere prefix uniqueness is checked within the machine/profile selection', async (t) => {
  const data = fixture(t);
  for (const row of [ENTRY,
    { ...ENTRY, keySha256: `aaaaaaaa${'0'.repeat(56)}`, machine: 'other' },
    { ...ENTRY, keySha256: `aaaaaaaa${'1'.repeat(56)}`, profileSlug: 'other' },
  ]) data.store.addPoolClientKey(row);
  const result = await request(data, undefined, { method: 'POST', body: { revokeWhere: {
    machine: 'client-one', profileSlug: 'work', keySha256s: [], hashPrefixes: ['aaaaaaaa'],
  } } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.revokedPrefixes, ['aaaaaaaa']);
  assert.equal(data.store.poolClientKeys().filter((row) => row.revokedAt).length, 1);
});

test('#786 client helper accepts only consent for its role and still probes Keychain metadata', { skip: process.platform !== 'darwin' && 'per-profile Keychain items are macOS-only' }, async (t) => {
  const data = fixture(t);
  const route = `/api/accounts/${data.account.id}/client-key-helper`;
  const post = (body) => request(data, route, { method: 'POST', body });
  const host = await post({ poolHostVerified: true });
  assert.equal(host.status, 409);
  assert.equal(host.body.code, 'proxy-role-host');
  assert.equal(data.calls.length, 0);
  data.store.saveSettings({ proxyRole: 'remote' });
  for (const body of [{}, { configWriteVerified: true }, { poolHostVerified: true, configWriteVerified: true }]) {
    const response = await post(body);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'proxy-role-remote');
  }
  assert.equal(data.calls.length, 0);
  const exec = data.service.exec;
  data.service.exec = async () => { throw new Error('not found'); };
  assert.equal((await post({ poolHostVerified: true })).status, 409);
  data.service.exec = exec;
  const result = await post({ poolHostVerified: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.clientKeyHelper.complete, true);
  assert.equal(result.body.clientKeyHelper.legacySharedKeyStillAdmitted, false,
    'the pool host installed this profile key, not the client\'s legacy shared key');
  assert.deepEqual(data.calls[0].slice(0, 2), ['/usr/bin/security', ['find-generic-password', '-s', clientKeyService(data.account.id)]]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data.home, 'settings.json'))).apiKeyHelper,
    clientKeyHelperCommand(clientKeyService(data.account.id)));
  data.store.saveSettings({ proxyRole: 'host' });
  assert.equal((await post({ configWriteVerified: true })).status, 200);
});
