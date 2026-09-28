import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelDeckService } from '../src/service.mjs';
import { readCLIProxyPin } from '../scripts/cliproxyapi-pin.mjs';
import {
  assertProxyAuthFilesShape,
  assertProxyAuthStatusShape,
  assertProxyAuthUrlShape,
} from '../src/proxy-relogin.mjs';
import {
  assertExecutableCLIProxyBinary,
  assertManagementConfigShape,
  assertUsageQueueResponse,
  CLIPROXY_COMPATIBILITY_TRIPWIRES,
  CLIPROXY_PROBE_OAUTH_STATE,
  discoverCLIProxyBinary,
  isolatedCLIProxyConfig,
  parseCLIProxyTestPort,
  verifyCLIProxyCompatibilityEvidence,
  writeCLIProxyCompatibilityEvidence,
} from '../scripts/cliproxyapi-compat.mjs';

const fixtureAuthDir = fileURLToPath(new URL('./fixtures/cliproxyapi-auth/', import.meta.url));
const pin = readCLIProxyPin();
const liveBinary = discoverCLIProxyBinary();
const MANAGEMENT_KEY = 'modeldeck-pin-bump-management-placeholder';

function compatibilityCapture(overrides = {}) {
  return {
    usageQueueShape: 'bare-array',
    management: {
      unauthenticatedStatus: 401,
      wrongTokenStatus: 401,
      authenticatedStatus: 200,
      responseShape: 'object',
    },
    authFileProviders: ['claude', 'codex'],
    ...overrides,
  };
}

// PR #428 review: a foreign service answering the test port between spawn
// and readiness could be validated in place of our binary. The port must be
// free BEFORE we spawn, and the spawned child must still own it at every
// capture.
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`test port ${port} is already occupied — refusing: the suite would validate a foreign listener instead of the pinned binary`));
      } else {
        reject(error);
      }
    });
    probe.listen({ port, host: '127.0.0.1' }, () => probe.close(resolve));
  });
}

function assertSpawnedProcessOwnsListener(launched, when) {
  if (launched.spawnError()) {
    throw new Error(`spawned CLIProxyAPI failed to start (${when}): ${launched.spawnError().message}`);
  }
  if (launched.child.exitCode !== null || launched.child.signalCode !== null) {
    throw new Error(`spawned CLIProxyAPI is no longer running ${when} — refusing to validate a listener it does not own`);
  }
}

function temporaryDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function assertFixtureAuthFormat(authDir) {
  const claude = JSON.parse(fs.readFileSync(path.join(authDir, 'claude-pin-bump-fixture.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(authDir, 'codex-pin-bump-fixture.json'), 'utf8'));

  assert.equal(claude.type, 'claude');
  assert.equal(claude.email, 'pin-bump-claude@example.invalid');
  assert.equal(claude.weight, 7);
  // The fixture is written with the legacy `excluded-models` key; CLIProxyAPI
  // >= v7.2.140 canonicalizes it to `excluded_models` on load and rewrites the
  // file (found live at the v7.2.149 bump). Either spelling must still carry
  // the bench, and ModelDeck's reader below must see it either way.
  assert.deepEqual(
    claude['excluded_models'] ?? claude['excluded-models'],
    ['claude-fable-fixture'],
  );
  assert.match(claude.access_token, /placeholder-not-a-credential$/);
  // Upstream v7.2.158+ names Claude credentials `claude-<org hash>-<email>.json`
  // (org-hashed; legacy `claude-<email>.json` still loads). ModelDeck joins on
  // the email INSIDE the file, so the hashed name must change nothing.
  const hashed = JSON.parse(fs.readFileSync(path.join(authDir, 'claude-525d4af1-pin-bump-hashed@example.invalid.json'), 'utf8'));
  assert.equal(hashed.type, 'claude');
  assert.equal(hashed.email, 'pin-bump-hashed@example.invalid');
  assert.match(hashed.access_token, /placeholder-not-a-credential$/);
  assert.equal(codex.type, 'codex');
  assert.equal(codex.account_id, 'acct-pin-bump-placeholder');
  assert.equal(codex.weight, 3);
  assert.match(codex.access_token, /placeholder-not-a-credential$/);

  // Exercise ModelDeck's real auth-directory reader instead of duplicating
  // its field list in the compatibility harness.
  const weights = await ModelDeckService.prototype.readProxyWeights.call({ cliproxyAuthDir: authDir });
  assert.deepEqual(
    weights.byClaudeEmail.get('pin-bump-claude@example.invalid'),
    { weight: 7, fableExcluded: true },
  );
  assert.deepEqual(
    weights.byClaudeEmail.get('pin-bump-hashed@example.invalid'),
    { weight: 5, fableExcluded: false },
  );
  assert.deepEqual(
    weights.byCodexAccountId.get('acct-pin-bump-placeholder'),
    { weight: 3, fableExcluded: false },
  );
  return ['claude', 'codex'];
}

function copyAuthFixtures(destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(fixtureAuthDir)) {
    const target = path.join(destination, name);
    fs.copyFileSync(path.join(fixtureAuthDir, name), target);
    fs.chmodSync(target, 0o600);
  }
}

function launchProxy(binaryPath, root, configPath) {
  const child = spawn(binaryPath, ['-config', configPath, '-local-model'], {
    cwd: root,
    env: {
      HOME: path.join(root, 'home'),
      PATH: '/usr/bin:/bin',
      TMPDIR: path.join(root, 'tmp'),
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError = null;
  const append = (chunk) => { output = `${output}${chunk}`.slice(-16_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  return {
    child,
    closed,
    output: () => output,
    spawnError: () => spawnError,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchTestURL(url, options = {}) {
  return fetch(url, {
    redirect: 'error',
    ...options,
    signal: AbortSignal.timeout(2_000),
  });
}

async function discard(response) {
  try { await response?.body?.cancel(); } catch { /* Nothing sensitive is read from error bodies. */ }
}

async function waitForHealth(launched, baseURL) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (launched.spawnError()) throw launched.spawnError();
    if (launched.child.exitCode !== null || launched.child.signalCode !== null) {
      throw new Error(`CLIProxyAPI exited before readiness\n${launched.output()}`);
    }
    try {
      const response = await fetchTestURL(`${baseURL}/healthz`);
      if (response.status === 200) {
        await discard(response);
        return;
      }
      await discard(response);
    } catch { /* The process may still be starting. */ }
    await delay(100);
  }
  throw new Error(`CLIProxyAPI timed out before readiness\n${launched.output()}`);
}

async function waitForClose(launched, milliseconds) {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); });
  const closed = launched.closed.then(() => true);
  try { return await Promise.race([closed, timedOut]); }
  finally { clearTimeout(timer); }
}

async function stopProxy(launched) {
  if (!launched || launched.child.exitCode !== null || launched.child.signalCode !== null) return;
  launched.child.kill('SIGTERM');
  if (await waitForClose(launched, 2_000)) return;
  launched.child.kill('SIGKILL');
  if (!await waitForClose(launched, 2_000)) {
    throw new Error('isolated CLIProxyAPI did not stop after SIGKILL');
  }
}

function listenerDeniedBySandbox(output) {
  return /(?:listen|bind)[^\n]*(?:operation not permitted|permission denied|\bEPERM\b)/i.test(output);
}

test('pin-bump contracts accept only the queue and management shapes ModelDeck parses', () => {
  // TRIPWIRE pin-bump-queue-shape: the 0.4.6 live endpoint returned a bare
  // array while fixtures returned an envelope. Both stay valid; a third root
  // shape must stop the pin bump.
  assert.equal(assertUsageQueueResponse('[]').shape, 'bare-array');
  assert.equal(assertUsageQueueResponse('{"usage":[]}').shape, 'usage-envelope');
  const usageRecord = {
    request_id: 'pin-bump-request-placeholder',
    timestamp: '2026-08-14T00:00:00.000Z',
    source: 'pin-bump-source@example.invalid',
    provider: 'claude',
    model: 'claude-pin-bump-fixture',
  };
  assert.equal(assertUsageQueueResponse(JSON.stringify([usageRecord])).parsed.records.length, 1);
  assert.throws(
    () => assertUsageQueueResponse('{"usage":[{"provider":"claude"}]}'),
    /contains 1 malformed record/,
  );
  assert.throws(
    () => assertUsageQueueResponse('{"records":[]}'),
    /must be a bare array or a usage envelope/,
  );
  assert.throws(
    () => assertUsageQueueResponse('{"instances":[]}'),
    /must be a bare array or a usage envelope/,
  );

  assert.deepEqual(assertManagementConfigShape('{"port":18319}'), { port: 18319 });
  assert.throws(() => assertManagementConfigShape('[]'), /must be a JSON object/);
  assert.throws(() => assertManagementConfigShape('not-json'), /not valid JSON/);
});

test('pin-bump fixture auth files stay inside ModelDeck reader format', async () => {
  // TRIPWIRE pin-bump-auth-format: fixture-only and live runs both call the
  // production reader for type, identity, weight, credential presence, and
  // excluded-models. Values are explicit non-credentials and .invalid IDs.
  assert.deepEqual(await assertFixtureAuthFormat(fixtureAuthDir), ['claude', 'codex']);
});

test('live harness refuses the proxy and daemon production ports', () => {
  assert.equal(parseCLIProxyTestPort('18319'), 18319);
  assert.throws(() => parseCLIProxyTestPort('8317'), /reserved for a live service/);
  assert.throws(() => parseCLIProxyTestPort('3867'), /reserved for a live service/);
  assert.throws(() => parseCLIProxyTestPort('0'), /integer from 1024 to 65535/);
  assert.throws(() => parseCLIProxyTestPort('not-a-port'), /integer from 1024 to 65535/);

  const config = isolatedCLIProxyConfig({ port: 18319, authDir: '/tmp/modeldeck-pin-bump-auth' });
  assert.match(config, /^host: "127\.0\.0\.1"/);
  assert.match(config, /port: 18319/);
  assert.match(config, /modeldeck-pin-bump-management-placeholder/);
  assert.match(config, /auth-dir: "\/tmp\/modeldeck-pin-bump-auth"/);
  assert.match(config, /usage-statistics-enabled: true/);
  assert.doesNotMatch(config, /8317|3867/);
});

test('binary discovery names the build-first skip and honors the environment override', (t) => {
  const root = temporaryDirectory(t, 'modeldeck-cliproxy-discovery-');
  let discovered = discoverCLIProxyBinary({ env: {}, root, cwd: root });
  assert.equal(discovered.available, false);
  assert.match(discovered.skipReason, /build first with scripts\/build-cliproxyapi\.sh --fetch-go/);

  const binaryPath = path.join(root, 'fixture-cliproxyapi');
  fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  discovered = discoverCLIProxyBinary({
    env: { MD_CLIPROXYAPI_BINARY: './fixture-cliproxyapi' },
    root,
    cwd: root,
  });
  assert.equal(discovered.available, true);
  assert.equal(discovered.binaryPath, binaryPath);
  assert.equal(assertExecutableCLIProxyBinary(discovered.binaryPath), binaryPath);
});

test('release evidence binds all tripwires to the current pin and exact binary', (t) => {
  const root = temporaryDirectory(t, 'modeldeck-cliproxy-evidence-');
  const binaryPath = path.join(root, 'cliproxyapi');
  const evidencePath = path.join(root, 'compatibility.json');
  fs.writeFileSync(binaryPath, 'fixture binary bytes', { mode: 0o755 });
  const fixturePin = { tag: 'v1.2.3', commit: 'a'.repeat(40) };
  assert.throws(
    () => verifyCLIProxyCompatibilityEvidence({ binaryPath, evidencePath, pin: fixturePin }),
    /evidence is missing or invalid/,
  );
  const fixtureBodies = {
    managementConfig: { endpoint: '/v0/management/config', body: '{"fixture":true}' },
    usageQueue: { endpoint: '/v0/management/usage-queue?count=1', body: '[]' },
    // Issue #396 — the credential-repair surfaces are captures too, so
    // evidence without them is refused exactly like the other two.
    authFiles: { endpoint: '/v0/management/auth-files', body: '{"files":[]}' },
    anthropicAuthUrl: {
      endpoint: '/v0/management/anthropic-auth-url',
      body: '{"status":"ok","url":"https://fixture.invalid/authorize","state":"pin-bump-fixture-state"}',
    },
    codexAuthUrl: {
      endpoint: '/v0/management/codex-auth-url',
      body: '{"status":"ok","url":"https://fixture.invalid/authorize","state":"pin-bump-fixture-state"}',
    },
    authStatusUnknown: {
      endpoint: `/v0/management/get-auth-status?state=${CLIPROXY_PROBE_OAUTH_STATE}`,
      body: '{"status":"error","error":"unknown or expired state"}',
    },
  };
  // Bodies are mandatory (#403d): the writer refuses evidence without them.
  assert.throws(
    () => writeCLIProxyCompatibilityEvidence({
      binaryPath, evidencePath, pin: fixturePin, capture: compatibilityCapture(),
    }),
    /live captured managementConfig response body from .* is required/,
  );
  const evidence = writeCLIProxyCompatibilityEvidence({
    binaryPath,
    evidencePath,
    pin: fixturePin,
    capture: compatibilityCapture(),
    capturedBodies: fixtureBodies,
    passedAt: '2026-08-14T00:00:00.000Z',
  });
  // A captured body that no longer matches its digest must fail verification.
  const managementCapturePath = path.join(root, 'captures', 'management-config.json');
  // Owner-only permissions (PR #428 review): a management config body can
  // carry provider keys.
  assert.equal(fs.statSync(managementCapturePath).mode & 0o777, 0o600);
  const original = fs.readFileSync(managementCapturePath);
  fs.appendFileSync(managementCapturePath, 'tampered');
  assert.throws(
    () => verifyCLIProxyCompatibilityEvidence({ binaryPath, evidencePath, pin: fixturePin }),
    /captured managementConfig response body does not match the evidence digest/,
  );
  fs.writeFileSync(managementCapturePath, original);
  assert.deepEqual(Object.keys(evidence.tripwires), CLIPROXY_COMPATIBILITY_TRIPWIRES);
  assert.deepEqual(
    verifyCLIProxyCompatibilityEvidence({ binaryPath, evidencePath, pin: fixturePin }),
    evidence,
  );
  assert.throws(
    () => verifyCLIProxyCompatibilityEvidence({
      binaryPath,
      evidencePath,
      pin: { tag: 'v1.2.4', commit: 'b'.repeat(40) },
    }),
    /evidence is stale/,
  );

  fs.appendFileSync(binaryPath, 'changed');
  assert.throws(
    () => verifyCLIProxyCompatibilityEvidence({ binaryPath, evidencePath, pin: fixturePin }),
    /does not match the binary being released/,
  );
});

test(
  'LIVE CLIProxyAPI pin compatibility — build first with scripts/build-cliproxyapi.sh --fetch-go',
  {
    skip: liveBinary.available ? false : `SKIP LOUDLY: ${liveBinary.skipReason}`,
    timeout: 30_000,
  },
  async (t) => {
    const binaryPath = assertExecutableCLIProxyBinary(liveBinary.binaryPath);
    const port = parseCLIProxyTestPort(process.env.MD_CLIPROXYAPI_TEST_PORT || undefined);
    const root = temporaryDirectory(t, 'modeldeck-cliproxy-live-');
    const authDir = path.join(root, 'auth');
    const configPath = path.join(root, 'config.yaml');
    fs.mkdirSync(path.join(root, 'home'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'tmp'), { mode: 0o700 });
    copyAuthFixtures(authDir);
    fs.writeFileSync(configPath, isolatedCLIProxyConfig({ port, authDir }), { mode: 0o600 });

    const baseURL = `http://127.0.0.1:${port}`;
    try { await assertPortFree(port); }
    catch (error) {
      if (error.code === 'EPERM') {
        t.skip('SKIP LOUDLY: sandbox denied the isolated listener; rerun npm run test:cliproxyapi-pin outside the sandbox');
        return;
      }
      throw error;
    }
    const launched = launchProxy(binaryPath, root, configPath);
    let capture;
    let capturedBodies;
    try {
      try { await waitForHealth(launched, baseURL); }
      catch (error) {
        if (listenerDeniedBySandbox(launched.output())) {
          t.skip('SKIP LOUDLY: sandbox denied the isolated listener; rerun npm run test:cliproxyapi-pin outside the sandbox');
          return;
        }
        throw error;
      }
      assertSpawnedProcessOwnsListener(launched, 'after readiness');

      // TRIPWIRE pin-bump-mgmt-api: scripts and the daemon depend on this
      // exact authentication boundary, object response, and build headers.
      const unauthenticated = await fetchTestURL(`${baseURL}/v0/management/config`);
      assert.equal(unauthenticated.status, 401);
      await discard(unauthenticated);
      const wrongToken = await fetchTestURL(`${baseURL}/v0/management/config`, {
        headers: { Authorization: 'Bearer modeldeck-pin-bump-wrong-placeholder' },
      });
      assert.equal(wrongToken.status, 401);
      await discard(wrongToken);
      assertSpawnedProcessOwnsListener(launched, 'before the authenticated management read');
      const authenticated = await fetchTestURL(`${baseURL}/v0/management/config`, {
        headers: { Authorization: `Bearer ${MANAGEMENT_KEY}` },
      });
      assert.equal(authenticated.status, 200);
      const managementBody = await authenticated.text();
      assertManagementConfigShape(managementBody);
      assert.equal(authenticated.headers.get('x-cpa-commit'), pin.commit);
      assert.equal(authenticated.headers.get('x-cpa-version'), pin.version);

      // This is the suite's only destructive queue read. baseURL is derived
      // solely from the guarded port of the process created above.
      assertSpawnedProcessOwnsListener(launched, 'before the queue read');
      const queueResponse = await fetchTestURL(
        `${baseURL}/v0/management/usage-queue?count=1`,
        { headers: { Authorization: `Bearer ${MANAGEMENT_KEY}` } },
      );
      assert.equal(queueResponse.status, 200);
      const queueBody = await queueResponse.text();
      const queue = assertUsageQueueResponse(queueBody);
      // TRIPWIRE pin-bump-relogin-api (#396): the four management surfaces
      // the in-app credential repair drives. Nothing here contacts a
      // provider — the auth-url routes build a PKCE authorize URL locally,
      // and the status probes are answered from the proxy's own memory.
      assertSpawnedProcessOwnsListener(launched, 'before the relogin captures');
      const management = { headers: { Authorization: `Bearer ${MANAGEMENT_KEY}` } };
      const authFilesResponse = await fetchTestURL(`${baseURL}/v0/management/auth-files`, management);
      assert.equal(authFilesResponse.status, 200);
      const authFilesBody = await authFilesResponse.text();
      const authFileEntries = assertProxyAuthFilesShape(authFilesBody);
      // The join key the daemon uses for Claude members must actually be
      // present in the LIVE answer — a shape that parses but carries no
      // identity would silently never match a pool member.
      assert.ok(
        authFileEntries.some((entry) => entry.email === 'pin-bump-claude@example.invalid'),
        'the live auth-files answer must carry the claude fixture identity the daemon joins on',
      );
      assert.ok(
        authFileEntries.some((entry) => entry.email === 'pin-bump-hashed@example.invalid'),
        'the live auth-files answer must carry the email of an org-hashed claude file name too',
      );

      const anthropicResponse = await fetchTestURL(`${baseURL}/v0/management/anthropic-auth-url`, management);
      assert.equal(anthropicResponse.status, 200);
      const anthropicBody = await anthropicResponse.text();
      const anthropicStart = assertProxyAuthUrlShape(anthropicBody);
      const codexResponse = await fetchTestURL(`${baseURL}/v0/management/codex-auth-url`, management);
      assert.equal(codexResponse.status, 200);
      const codexBody = await codexResponse.text();
      const codexStart = assertProxyAuthUrlShape(codexBody);

      // A real pending session answers `wait`. Its endpoint carries a random
      // state, so it is asserted live rather than file-captured.
      const pendingResponse = await fetchTestURL(
        `${baseURL}/v0/management/get-auth-status?state=${encodeURIComponent(anthropicStart.state)}`,
        management,
      );
      assert.equal(pendingResponse.status, 200);
      assert.deepEqual(assertProxyAuthStatusShape(await pendingResponse.text()), { status: 'wait', error: null });

      // Cancel both, which is also how ModelDeck's "Stop" works — and it
      // stops the proxy's own five-minute waiters before this test ends.
      for (const state of [anthropicStart.state, codexStart.state]) {
        const cancelResponse = await fetchTestURL(
          `${baseURL}/v0/management/oauth-session?state=${encodeURIComponent(state)}`,
          { ...management, method: 'DELETE' },
        );
        assert.equal(cancelResponse.status, 200);
        assert.equal(JSON.parse(await cancelResponse.text()).cancelled, true);
      }

      // The stale-poll branch, on a fixed state the proxy cannot know.
      const unknownResponse = await fetchTestURL(
        `${baseURL}/v0/management/get-auth-status?state=${CLIPROXY_PROBE_OAUTH_STATE}`,
        management,
      );
      assert.equal(unknownResponse.status, 200);
      const unknownBody = await unknownResponse.text();
      assert.equal(assertProxyAuthStatusShape(unknownBody).status, 'error');

      assertSpawnedProcessOwnsListener(launched, 'after the captures');
      capturedBodies = {
        managementConfig: { endpoint: '/v0/management/config', body: managementBody },
        usageQueue: { endpoint: '/v0/management/usage-queue?count=1', body: queueBody },
        authFiles: { endpoint: '/v0/management/auth-files', body: authFilesBody },
        anthropicAuthUrl: { endpoint: '/v0/management/anthropic-auth-url', body: anthropicBody },
        codexAuthUrl: { endpoint: '/v0/management/codex-auth-url', body: codexBody },
        authStatusUnknown: {
          endpoint: `/v0/management/get-auth-status?state=${CLIPROXY_PROBE_OAUTH_STATE}`,
          body: unknownBody,
        },
      };

      // TRIPWIRE pin-bump-auth-format: assert the exact fixture directory
      // supplied to this running process through ModelDeck's production reader.
      const authFileProviders = await assertFixtureAuthFormat(authDir);
      capture = compatibilityCapture({
        usageQueueShape: queue.shape,
        authFileProviders,
      });
    } finally {
      await stopProxy(launched);
    }
    const evidence = writeCLIProxyCompatibilityEvidence({ binaryPath, pin, capture, capturedBodies });
    verifyCLIProxyCompatibilityEvidence({ binaryPath, pin });
    t.diagnostic(
      `live capture: queue=${capture.usageQueueShape} management=401/401/200 auth=${capture.authFileProviders.join(',')} sha256=${evidence.binarySha256}`,
    );
  },
);
