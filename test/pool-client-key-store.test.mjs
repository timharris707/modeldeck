import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/db.mjs';
import { parseUsageRecord } from '../src/usage-ingest.mjs';

const digest = (key) => createHash('sha256').update(key).digest('hex');
const remoteKey = 'remote-client-key-placeholder';
const localKey = 'local-client-key-placeholder';
const entry = { keySha256: digest(remoteKey), machine: 'client-one', profileSlug: 'work', profileLabel: 'Work' };

function record(id, apiKey) {
  return { request_id: id, api_key: apiKey, timestamp: '2026-10-30T12:00:00Z',
    provider: 'claude', source: 'placeholder-source', model: 'placeholder-model' };
}

test('#786 TRIPWIRE remote-key attribution survives revocation and app-map replacement; secrets are discarded', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const parse = (id, key, options = {}) => parseUsageRecord(record(id, key), {
    resolveClientKeyProfile: (hash) => store.clientKeyProfile(hash), ...options,
  });
  const old = parse('historical', remoteKey);
  store.ingestRequestUsage([old]);
  store.addPoolClientKey(entry, '2026-10-30T12:00:00Z');
  store.addPoolClientKey({ ...entry, machine: 'other' }, '2026-10-31T12:00:00Z');
  assert.equal(store.poolClientKeys().length, 1);
  assert.equal(store.poolClientKeys()[0].machine, 'client-one', 'idempotent add cannot reassign a hash');
  assert.deepEqual(store.clientKeyProfile(entry.keySha256), { profileLabel: 'Work', machine: 'client-one' });
  const remote = parse('remote', remoteKey, { machine: 'caller' });
  assert.equal(remote.machine, 'client-one');
  assert.equal(remote.profileLabel, 'Work');
  store.replaceClientKeyMap({ generation: 1, entries: [
    { keySha256: digest(localKey), profileId: 'local', profileLabel: 'Local' },
  ] });
  const local = parse('local', localKey, { machine: 'caller' });
  assert.equal(local.machine, 'caller');
  assert.equal(local.profileLabel, 'Local');
  const unknown = parse('unknown', 'unknown-placeholder');
  assert.equal(unknown.machine, 'studio');
  assert.equal(unknown.profileLabel, null);
  store.revokePoolClientKey(entry.keySha256, '2026-10-30T13:00:00Z');
  store.addPoolClientKey(entry);
  assert.equal(store.poolClientKeys()[0].revokedAt, '2026-10-30T13:00:00Z', 'add never resurrects a revoked key');
  const revoked = parse('revoked', remoteKey);
  assert.equal(revoked.machine, 'client-one');
  assert.equal(revoked.profileLabel, 'Work');
  store.replaceClientKeyMap({ generation: 2, entries: [] });
  assert.equal(store.poolClientKeys().length, 1, 'full app reports leave remote keys alone');
  store.ingestRequestUsage([remote, local, unknown, revoked]);
  const rows = store.db.prepare('SELECT * FROM request_usage ORDER BY request_id').all();
  assert.equal(rows.find((row) => row.request_id === 'historical').machine, 'studio');
  for (const value of [remote, local, unknown, revoked, rows, store.poolClientKeys()]) {
    const serialized = JSON.stringify(value);
    for (const forbidden of [remoteKey, localKey, 'unknown-placeholder', 'api_key']) {
      assert.equal(serialized.includes(forbidden), false, 'raw keys and api_key never cross the ingest boundary');
    }
  }
  // A local mapping takes precedence even when a remote record shares its hash.
  store.replaceClientKeyMap({ generation: 3, entries: [
    { keySha256: entry.keySha256, profileId: 'local', profileLabel: 'Local' },
  ] });
  assert.equal(parse('collision', remoteKey, { machine: 'caller' }).machine, 'caller');
  assert.equal(parse('collision', remoteKey).profileLabel, 'Local');
});
