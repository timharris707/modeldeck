// Issue #522 — per-profile helper wiring: settings, shell env, launch
// preview, the proven-ownership foreign-helper guard, and the legacy→
// per-profile migration.
//
// Every fixture lives in a mkdtemp root: no shell profile outside it is
// written, no live Keychain is read (the darwin cases inject the `exec`
// seam), no proxy port is contacted, and no key material exists here at all —
// this half of the design never sees a raw key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import {
  LEGACY_CLIENT_KEY_HELPER,
  LEGACY_CLIENT_KEY_SERVICE,
  assertClientKeyService,
  classifyClaudeHelper,
  clientKeyHelperCommand,
  clientKeyService,
} from '../src/client-key-helper.mjs';
import { claudePinnedEnvFileContent, claudeProxyPointerShellSnippet } from '../src/adapters/claude.mjs';

const BASE_URL = 'http://127.0.0.1:8317';
// Per-profile Keychain items exist only on macOS; elsewhere they are refused (#808).
const macOnly = { skip: process.platform !== 'darwin' && 'per-profile client keys are macOS-only' };

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-522-'));
  const profilesDir = path.join(root, 'profiles');
  const firstHome = path.join(profilesDir, 'first');
  const secondHome = path.join(profilesDir, 'second');
  for (const home of [firstHome, secondHome]) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
  }
  const store = new Store(':memory:');
  store.saveSettings({ claudeManaged: true, codexManaged: true });
  const service = new ModelDeckService(store, {
    claudeActiveLink: path.join(root, 'active', '.claude'),
    codexActiveLink: path.join(root, 'active', '.codex'),
    claudeProfilesDir: profilesDir,
    cliproxyBaseUrl: BASE_URL,
    platform: 'linux',
    listProviderProcesses: async () => [],
    ...options,
  });
  return {
    root,
    firstHome,
    secondHome,
    store,
    service,
    envFile: path.join(root, 'claude-env.sh'),
    settingsOf: (home) => path.join(home, 'settings.json'),
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function readSettings(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * TRIPWIRE (never-compromise #4, extending the #278/#301 shell-env writer
 * guard class into the per-profile world): the slug is the ONLY value #522
 * interpolates into a generated shell command, and every writer refuses a
 * service name ModelDeck did not derive rather than escaping it. If this test
 * ever has to be relaxed, a profile identifier has become a shell injection
 * vector in the pinned env file, the preview a user pastes, and settings.json
 * all at once.
 */
test('TRIPWIRE #522 helper-service-shape: only a derived, charset-restricted service reaches a command string', () => {
  assert.equal(clientKeyService('7f3c9e21-4a0b-4d55-9f8e-2c1b0a9d7e64'),
    'cli-proxy-api-client.7f3c9e21-4a0b-4d55-9f8e-2c1b0a9d7e64');
  assert.equal(assertClientKeyService(LEGACY_CLIENT_KEY_SERVICE), LEGACY_CLIENT_KEY_SERVICE);

  const hostileSlugs = [
    'Work',                       // uppercase
    'a b',                        // space
    'a"b',                        // quote
    'a$(id)',                     // command substitution
    'a\nadd-generic-password',    // second command
    '../etc',                     // traversal
    '',                           // empty
  ];
  for (const slug of hostileSlugs) {
    assert.throws(() => clientKeyService(slug), /\[a-z0-9-\]/, `slug refused: ${JSON.stringify(slug)}`);
  }
  // The bare legacy name is reserved: it can never be produced as a
  // per-profile service, and an empty slug cannot smuggle it back.
  assert.throws(() => assertClientKeyService("cli-proxy-api-client."), /\[a-z0-9-\]/);
  assert.throws(() => assertClientKeyService('other-service'), /client-key service/);

  // Both generated shell surfaces validate before quoting.
  assert.throws(() => claudeProxyPointerShellSnippet('cli-proxy-api-client.A'), /\[a-z0-9-\]/);
  assert.throws(() => claudePinnedEnvFileContent('/profiles/one', true, 'evil; rm -rf /'), /client-key service/);
  // …and validate even when the credential block is not emitted, so a bad
  // resolution cannot lie dormant until the next routing change.
  assert.throws(() => claudePinnedEnvFileContent('/profiles/one', false, 'evil'), /client-key service/);
});

/**
 * The named acceptance case from issue #522 / design §2.5 / security-review
 * should-fix 7: recognition is proven ownership, never pattern inference.
 */
test('#522 guard: a helper matching the per-profile pattern with a real slug, but no ownership record, is foreign', macOnly, () => {
  const knownSlug = '7f3c9e21-4a0b-4d55-9f8e-2c1b0a9d7e64';
  const otherSlug = '0b1d4c88-2e6f-4a17-b3c5-9d8e7f6a5b40';
  const looksGenerated = clientKeyHelperCommand(clientKeyService(knownSlug));

  // No record at all — the shape and the real slug prove nothing.
  assert.equal(classifyClaudeHelper(looksGenerated, null), 'foreign');
  // A record exists, but names a different string: still foreign, because
  // ownership is byte-equality against what WE wrote, not family resemblance.
  assert.equal(classifyClaudeHelper(looksGenerated, {
    mode: 'per-profile',
    service: clientKeyService(otherSlug),
    helper: clientKeyHelperCommand(clientKeyService(otherSlug)),
  }), 'foreign');
  // Byte-identical to the record: ours.
  assert.equal(classifyClaudeHelper(looksGenerated, {
    mode: 'per-profile', service: clientKeyService(knownSlug), helper: looksGenerated,
  }), 'recorded');
});

test('#522 guard: the legacy shared helper is ours only while no per-profile record exists', macOnly, () => {
  assert.equal(classifyClaudeHelper(LEGACY_CLIENT_KEY_HELPER, null), 'legacy');
  assert.equal(classifyClaudeHelper(LEGACY_CLIENT_KEY_HELPER, { mode: 'legacy', helper: null }), 'legacy');
  // Once the profile is migrated and recorded, the legacy string in
  // settings.json is no longer what ModelDeck wrote there.
  assert.equal(classifyClaudeHelper(LEGACY_CLIENT_KEY_HELPER, {
    mode: 'per-profile',
    service: clientKeyService('7f3c9e21-4a0b-4d55-9f8e-2c1b0a9d7e64'),
    helper: clientKeyHelperCommand(clientKeyService('7f3c9e21-4a0b-4d55-9f8e-2c1b0a9d7e64')),
  }), 'foreign');
  assert.equal(classifyClaudeHelper(undefined, null), 'absent');
  assert.equal(classifyClaudeHelper('   ', null), 'absent');
  assert.equal(classifyClaudeHelper('printf sk-mine', null), 'foreign');
});

test('#522 wire on an un-migrated install writes the legacy helper and records it verbatim', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);

  assert.equal(readSettings(data.settingsOf(data.firstHome)).apiKeyHelper, LEGACY_CLIENT_KEY_HELPER);
  const record = data.store.getAccount(account.id).metadata.clientKeyHelper;
  assert.equal(record.mode, 'legacy');
  assert.equal(record.service, LEGACY_CLIENT_KEY_SERVICE);
  assert.equal(record.helper, LEGACY_CLIENT_KEY_HELPER);
  assert.ok(fs.readFileSync(data.envFile, 'utf8')
    .includes(`find-generic-password -s ${LEGACY_CLIENT_KEY_SERVICE} -w`));

  const wiring = await data.service.claudeClientKeyWiring(account.id);
  assert.equal(wiring.mode, 'legacy');
  assert.equal(wiring.settingsWired, true);
  assert.equal(wiring.shellEnvWired, true);
  assert.equal(wiring.complete, false);
});

test('#522 guard: an unrecorded per-profile-shaped helper gets the existing 409 and is never overwritten', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  // A helper carrying THIS account's own real slug — the strongest possible
  // pattern match — hand-written by the user, with no ownership record.
  const handAuthored = `${JSON.stringify({
    apiKeyHelper: clientKeyHelperCommand(clientKeyService(account.id)),
  }, null, 2)}\n`;
  fs.writeFileSync(data.settingsOf(data.firstHome), handAuthored, { mode: 0o600 });

  await assert.rejects(data.service.wireProxyRouting(account.id), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /apiKeyHelper that ModelDeck did not write/);
    return true;
  });
  await assert.rejects(data.service.unwireProxyRouting(account.id), { statusCode: 409 });
  // Refusal means untouched, on both paths (the #282 class).
  assert.equal(fs.readFileSync(data.settingsOf(data.firstHome), 'utf8'), handAuthored);

  // The same string is accepted the moment it IS the recorded written state.
  const migrated = data.store.getAccount(account.id);
  data.service.saveClaudeClientKeyRecord(account.id, {
    mode: 'per-profile',
    service: clientKeyService(migrated.id),
    helper: clientKeyHelperCommand(clientKeyService(migrated.id)),
    writtenAt: new Date().toISOString(),
  });
  const routing = await data.service.wireProxyRouting(account.id);
  assert.equal(routing.cliproxyRouted, true);
  assert.equal(
    readSettings(data.settingsOf(data.firstHome)).apiKeyHelper,
    clientKeyHelperCommand(clientKeyService(account.id)),
  );
});

test('#522 migration points settings, the pinned shell env and the launch preview at the profile\'s own item', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);

  const wiring = await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });
  const service = clientKeyService(account.id);
  assert.equal(wiring.mode, 'per-profile');
  assert.equal(wiring.service, service);
  assert.equal(wiring.stage, 'complete');
  assert.equal(wiring.complete, true);
  assert.equal(wiring.settingsWired, true);
  assert.equal(wiring.shellEnvWired, true);
  // D6/§2.5: the shared item and its config entry stay, so shells that read
  // the legacy key at startup keep working and attribute as honest NULL.
  assert.equal(wiring.legacySharedKeyStillAdmitted, true);

  assert.equal(readSettings(data.settingsOf(data.firstHome)).apiKeyHelper, clientKeyHelperCommand(service));
  const env = fs.readFileSync(data.envFile, 'utf8');
  assert.ok(env.includes(`find-generic-password -s ${service} -w`));
  assert.ok(!env.includes(`-s ${LEGACY_CLIENT_KEY_SERVICE} -w`));
  // The pointer-only property is unchanged: no key value on disk, xtrace
  // still suspended around the credential lines.
  assert.ok(env.includes('case $- in *x*) __modeldeck_xtrace=1; set +x;; esac'));
  assert.ok(env.includes('export ANTHROPIC_API_KEY="$__modeldeck_key"'));

  const spec = await data.service.launchSpec('claude', data.root);
  assert.equal(spec.credential, 'cliproxy-pointer');
  assert.ok(spec.preview.includes(`find-generic-password -s ${service} -w`));
  assert.ok(!spec.preview.includes(`-s ${LEGACY_CLIENT_KEY_SERVICE} -w`));
  // `modeldeck launch` resolves the pointer itself at spawn: it must be given
  // the SAME item the preview names, or a pasted preview and a real launch
  // would fetch different keys. A directive, never a credential value.
  assert.equal(spec.keychainService, service);
  assert.equal(Object.hasOwn(spec.env, 'ANTHROPIC_API_KEY'), false);

  // Idempotent: a second call reports, it does not rewrite.
  const before = fs.readFileSync(data.settingsOf(data.firstHome), 'utf8');
  const again = await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });
  assert.equal(again.complete, true);
  assert.equal(fs.readFileSync(data.settingsOf(data.firstHome), 'utf8'), before);
});

test('#522 migration refuses before the consented config write and before the key is provisioned', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.wireProxyRouting(account.id);

  // #521's consented append must have landed, or the proxy 401s every
  // request the new helper authenticates.
  await assert.rejects(data.service.migrateClaudeClientKeyHelper(account.id, {}), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /consented config write/);
    return true;
  });
  assert.equal(readSettings(data.settingsOf(data.firstHome)).apiKeyHelper, LEGACY_CLIENT_KEY_HELPER);

  // …and the Keychain item #520 provisions must actually be there. The
  // presence probe is metadata-only: never `-w`, so no key value can enter
  // the daemon process.
  const calls = [];
  const darwin = fixture({
    platform: 'darwin',
    exec: async (binary, args) => { calls.push([binary, args]); throw new Error('item not found'); },
  });
  t.after(() => darwin.close());
  const other = darwin.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: darwin.firstHome, isDefault: true });
  await assert.rejects(
    darwin.service.migrateClaudeClientKeyHelper(other.id, { configWriteVerified: true }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /not in the Keychain/);
      return true;
    },
  );
  // An unrouted profile is refused outright: an apiKeyHelper outranks its
  // stored OAuth, so wiring one there would break the profile.
  const unrouted = fixture();
  t.after(() => unrouted.close());
  const idle = unrouted.store.saveAccount({ provider: 'claude', label: 'Direct', profileRef: unrouted.firstHome, isDefault: true });
  await assert.rejects(
    unrouted.service.migrateClaudeClientKeyHelper(idle.id, { configWriteVerified: true }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /routed through the local proxy/);
      return true;
    },
  );
  assert.equal(fs.existsSync(unrouted.settingsOf(unrouted.firstHome)), false);

  const probe = calls.find(([binary]) => binary === '/usr/bin/security');
  assert.deepEqual(probe, ['/usr/bin/security', ['find-generic-password', '-s', clientKeyService(other.id)]]);
  assert.ok(!probe[1].includes('-w'), 'presence probe never reads a value');
});

test('#522 migration is resumable and reports partial state honestly', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);

  // Crash between the two files: settings.json is written, the shell env is
  // not. The operation is NOT rolled back — settings already points at the
  // per-profile item — so it must be reported for what it is.
  const realWrite = data.service.writeClaudeShellEnvFile.bind(data.service);
  let failed = false;
  data.service.writeClaudeShellEnvFile = async (...args) => {
    if (!failed) { failed = true; throw new Error('disk gone'); }
    return realWrite(...args);
  };
  await assert.rejects(
    data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true }),
    /could not refresh the shell environment/,
  );

  const service = clientKeyService(account.id);
  const partial = await data.service.claudeClientKeyWiring(account.id);
  assert.equal(partial.stage, 'settings');
  assert.equal(partial.complete, false);
  assert.equal(partial.settingsWired, true, 'settings.json really is on the per-profile item');
  assert.equal(partial.shellEnvWired, false, 'and the shell env really is not');
  assert.equal(readSettings(data.settingsOf(data.firstHome)).apiKeyHelper, clientKeyHelperCommand(service));

  // Resume: the recorded stage is picked up, the remaining file is written,
  // and nothing is done twice.
  const resumed = await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });
  assert.equal(resumed.stage, 'complete');
  assert.equal(resumed.shellEnvWired, true);
  assert.ok(fs.readFileSync(data.envFile, 'utf8').includes(`find-generic-password -s ${service} -w`));
  const record = data.store.getAccount(account.id).metadata.clientKeyHelper;
  assert.equal(record.migration.from, 'legacy');
  assert.ok(record.migration.startedAt <= record.migration.updatedAt);
});

test('#522 unwire removes the recorded helper and clears the record', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);
  await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });

  await data.service.unwireProxyRouting(account.id);
  const settings = readSettings(data.settingsOf(data.firstHome));
  assert.equal(Object.hasOwn(settings, 'apiKeyHelper'), false);
  const record = data.store.getAccount(account.id).metadata.clientKeyHelper;
  // The provisioning survives the unwire; the WIRING does not.
  assert.equal(record.mode, 'per-profile');
  assert.equal(record.helper, null);
  // A helper reappearing with no recorded string is nobody's but the user's.
  assert.equal(classifyClaudeHelper(clientKeyHelperCommand(clientKeyService(account.id)), record), 'foreign');
  const wiring = await data.service.claudeClientKeyWiring(account.id);
  assert.equal(wiring.settingsWired, false);
});

/**
 * TRIPWIRE (never-compromise #4; security review of PR #532, blocker 1): the
 * ownership record is daemon-owned in BOTH directions. An account edit that
 * re-sends a stale metadata object must not WIPE it — that would leave
 * settings.json on the per-profile helper while the shell env re-pinned the
 * legacy item (two surfaces fetching different profiles' keys, the exact
 * mis-attribution this PR exists to prevent) and then 409 every wire and
 * unwire. A caller-SUPPLIED record must not be adopted either, or an API
 * client could declare an arbitrary helper "ours" and have ModelDeck
 * overwrite or delete it.
 */
test('TRIPWIRE #522 helper-record-is-daemon-owned: an account edit can neither wipe nor forge the ownership record', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);
  await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });
  const service = clientKeyService(account.id);
  const recorded = data.store.getAccount(account.id).metadata.clientKeyHelper;
  assert.equal(recorded.helper, clientKeyHelperCommand(service));

  // The PR #29 stale-resend clobber: an edit carrying metadata that predates
  // the migration.
  await data.service.saveAccount({
    id: account.id,
    provider: 'claude',
    label: 'Work renamed',
    profileRef: data.firstHome,
    metadata: { somethingTheAppTracks: true },
  });
  assert.deepEqual(data.store.getAccount(account.id).metadata.clientKeyHelper, recorded);
  // …and the wiring still works, rather than 409-ing forever.
  assert.equal((await data.service.claudeClientKeyWiring(account.id)).complete, true);
  await data.service.unwireProxyRouting(account.id);
  await data.service.wireProxyRouting(account.id);
  assert.equal(readSettings(data.settingsOf(data.firstHome)).apiKeyHelper, clientKeyHelperCommand(service));

  // Forgery in reverse: a caller-supplied record on an account that has none
  // must be dropped, not adopted as proof of ownership.
  const second = data.store.saveAccount({ provider: 'claude', label: 'Two', profileRef: data.secondHome });
  const forged = clientKeyHelperCommand(clientKeyService(second.id));
  await data.service.saveAccount({
    id: second.id,
    provider: 'claude',
    label: 'Two',
    profileRef: data.secondHome,
    metadata: { clientKeyHelper: { mode: 'per-profile', service: clientKeyService(second.id), helper: forged } },
  });
  assert.equal(data.store.getAccount(second.id).metadata.clientKeyHelper, undefined);
  // With no record, the forged helper is exactly what the guard refuses.
  fs.writeFileSync(data.settingsOf(data.secondHome), `${JSON.stringify({ apiKeyHelper: forged }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(data.service.wireProxyRouting(second.id), { statusCode: 409 });
});

/**
 * TRIPWIRE (CodeRabbit, PR #532): the daemon-owned-metadata guard must hold
 * across the AWAITS inside saveAccount, not just against a stale re-send.
 * `saveAccount` awaits profile validation and the explainer install before it
 * persists; a client-key migration landing in that window used to be erased
 * by the pending save committing a snapshot taken before it — the security
 * blocker's exact consequence, arriving by timing instead of by payload.
 *
 * Deterministic, not timing-dependent: the explainer install is held open on
 * a gate the test resolves, so the migration is GUARANTEED to land inside the
 * window rather than racing it.
 */
test('TRIPWIRE #522 helper-record-survives-concurrent-save: a migration landing inside saveAccount\'s awaits is not clobbered', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let reachedWindow;
  const entered = new Promise((resolve) => { reachedWindow = resolve; });
  data.service.ensureClaudeProfileExplainer = async () => {
    reachedWindow();
    await gate;
  };

  // A metadata-carrying edit begins and parks inside its await window.
  const saving = data.service.saveAccount({
    id: account.id,
    provider: 'claude',
    label: 'Work renamed',
    profileRef: data.firstHome,
    metadata: { somethingTheAppTracks: true },
  });
  await entered;

  // The migration lands entirely inside that window.
  await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });
  const migrated = data.store.getAccount(account.id).metadata.clientKeyHelper;
  assert.equal(migrated.helper, clientKeyHelperCommand(clientKeyService(account.id)));

  openGate();
  await saving;

  // The pending save must commit the FRESH record, not the snapshot it took
  // before the migration existed.
  const after = data.store.getAccount(account.id);
  assert.deepEqual(after.metadata.clientKeyHelper, migrated);
  assert.equal(after.metadata.somethingTheAppTracks, true, 'the caller\'s own metadata still lands');
  assert.equal(after.label, 'Work renamed');
  // The whole point: the two surfaces still agree, so no shell fetches a
  // different profile's key than settings.json names.
  const wiring = await data.service.claudeClientKeyWiring(account.id);
  assert.equal(wiring.complete, true);
  assert.equal(wiring.settingsWired, true);
  assert.equal(wiring.shellEnvWired, true);
});

/**
 * The same tripwire, aimed at the OTHER long await window on the account
 * record: `verifyAccount` reads the account, then spawns the provider CLI
 * (seconds), then commits metadata. A routine deck auth refresh overlapping a
 * migration used to roll the ownership record back to legacy — after which
 * unwire 409-wedges and the next shell-env write splits the two surfaces onto
 * different profiles' keys. Verify must still land its OWN plan/identity
 * facts, so this also proves the rebase does not clobber authored keys.
 */
test('TRIPWIRE #522 helper-record-survives-verify: a migration landing inside the auth-probe window is not clobbered', macOnly, async (t) => {
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let reachedWindow;
  const entered = new Promise((resolve) => { reachedWindow = resolve; });
  const data = fixture({
    readClaudeAuth: async () => {
      reachedWindow();
      await gate;
      return {
        authenticated: true,
        identity: 'placeholder@example.test',
        plan: { subscriptionType: 'max', rateLimitTier: 'placeholder-tier' },
      };
    },
  });
  t.after(() => data.close());
  // Empty identity: the #99 mismatch refusal is skipped, so verify reaches
  // its persistence point with both identity and plan changed.
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', identity: '', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);

  const verifying = data.service.verifyAccount(account.id);
  await entered;
  await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });
  const migrated = data.store.getAccount(account.id).metadata.clientKeyHelper;
  openGate();
  await verifying;

  const after = data.store.getAccount(account.id);
  assert.deepEqual(after.metadata.clientKeyHelper, migrated, 'the ownership record survived the probe window');
  // Verify's own authored facts still land — the rebase is scoped to keys
  // this call does not write.
  assert.equal(after.identity, 'placeholder@example.test');
  assert.equal(after.metadata.claudePlan.rateLimitTier, 'placeholder-tier');
  // And the two surfaces still agree: no shell fetches a key settings.json
  // does not name.
  const wiring = await data.service.claudeClientKeyWiring(account.id);
  assert.equal(wiring.complete, true);
  // The unwire path is not 409-wedged.
  await data.service.unwireProxyRouting(account.id);
  assert.equal(Object.hasOwn(readSettings(data.settingsOf(data.firstHome)), 'apiKeyHelper'), false);
});

test('#522 unwire spends the migration: state stays honest and a re-migration still runs', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  await data.service.wireProxyRouting(account.id);
  await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });

  await data.service.unwireProxyRouting(account.id);
  const afterUnwire = await data.service.claudeClientKeyWiring(account.id);
  // A stale `complete` stage must not survive the helper it described.
  assert.equal(afterUnwire.stage, null);
  assert.equal(afterUnwire.complete, false);
  assert.equal(afterUnwire.settingsWired, false);

  // …and re-migrating is a real run, not a permanent no-op.
  await data.service.wireProxyRouting(account.id);
  const remigrated = await data.service.migrateClaudeClientKeyHelper(account.id, { configWriteVerified: true });
  assert.equal(remigrated.complete, true);
  assert.equal(
    readSettings(data.settingsOf(data.firstHome)).apiKeyHelper,
    clientKeyHelperCommand(clientKeyService(account.id)),
  );
});

test('#522 each profile resolves its OWN item: one profile\'s migration never repoints another', macOnly, async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const first = data.store.saveAccount({ provider: 'claude', label: 'One', profileRef: data.firstHome, isDefault: true });
  const second = data.store.saveAccount({ provider: 'claude', label: 'Two', profileRef: data.secondHome });
  for (const account of [first, second]) {
    await data.service.activateAccount(account.id);
    await data.service.wireProxyRouting(account.id);
  }
  await data.service.migrateClaudeClientKeyHelper(first.id, { configWriteVerified: true });

  // `second` is active and un-migrated: its pin must still name the legacy
  // item, never the item that belongs to `first`.
  await data.service.reconcileClaudeShellEnvFile();
  const env = fs.readFileSync(data.envFile, 'utf8');
  assert.ok(env.includes(`find-generic-password -s ${LEGACY_CLIENT_KEY_SERVICE} -w`));
  assert.ok(!env.includes(clientKeyService(first.id)));

  await data.service.activateAccount(first.id);
  assert.ok(fs.readFileSync(data.envFile, 'utf8').includes(clientKeyService(first.id)));
  assert.equal(readSettings(data.settingsOf(data.secondHome)).apiKeyHelper, LEGACY_CLIENT_KEY_HELPER);
});
