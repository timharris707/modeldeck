import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';

const cli = fileURLToPath(new URL('../bin/modeldeck.mjs', import.meta.url));
const launchctlFixture = fileURLToPath(new URL('./fixtures/config-linter/launchctl-fixture.sh', import.meta.url));

function treeState(root) {
  const rootStat = fs.lstatSync(root);
  const state = [{ path: '.', kind: 'directory', mode: rootStat.mode, mtimeMs: rootStat.mtimeMs }];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      const relative = path.relative(root, file);
      if (stat.isDirectory()) {
        state.push({ path: relative, kind: 'directory', mode: stat.mode, mtimeMs: stat.mtimeMs });
        visit(file);
      } else if (stat.isSymbolicLink()) {
        state.push({ path: relative, kind: 'symlink', target: fs.readlinkSync(file), mtimeMs: stat.mtimeMs });
      } else {
        state.push({ path: relative, kind: 'file', mode: stat.mode, mtimeMs: stat.mtimeMs, content: fs.readFileSync(file, 'base64') });
      }
    }
  };
  visit(root);
  return state;
}

function runLint(estate, args = ['--json']) {
  return spawnSync(process.execPath, [cli, 'lint', ...args], {
    cwd: estate.root,
    env: estate.env,
    encoding: 'utf8',
  });
}

function tracerEstate(t, { keepStoreOpen = false, configLintFacts = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-lint-tracer-'));
  const claudeProfilesDir = path.join(root, 'claude-profiles');
  const codexProfilesDir = path.join(root, 'codex-profiles');
  const claudeHome = path.join(claudeProfilesDir, 'work-claude');
  const codexHome = path.join(codexProfilesDir, 'work-codex');
  for (const directory of [claudeProfilesDir, codexProfilesDir, claudeHome, codexHome]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"tokens":{"account_id":"acct-placeholder-work"}}\n', { mode: 0o600 });

  const dbPath = path.join(root, 'modeldeck.sqlite');
  const store = new Store(dbPath);
  const claudeAccount = store.saveAccount({
    id: 'claude-placeholder-work',
    provider: 'claude',
    label: 'Work Claude',
    identity: 'work@example.invalid',
    profileRef: claudeHome,
  });
  const codexAccount = store.saveAccount({
    id: 'codex-placeholder-work',
    provider: 'codex',
    label: 'Work Codex',
    identity: 'work@example.invalid',
    profileRef: codexHome,
  });
  if (configLintFacts) store.saveConfigLintFacts(configLintFacts);
  if (!keepStoreOpen) store.close();

  t.after(() => {
    if (keepStoreOpen) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    writer: keepStoreOpen ? store : null,
    accounts: { claude: claudeAccount, codex: codexAccount },
    env: {
      ...process.env,
      PATH: path.join(root, 'fixture-bin'),
      MODELDECK_DB_PATH: dbPath,
      MODELDECK_DATA_DIR: root,
      MODELDECK_CLAUDE_PROFILES_DIR: claudeProfilesDir,
      MODELDECK_CLAUDE_ACTIVE_LINK: path.join(root, 'missing-active-claude'),
      MODELDECK_CLAUDE_SHELL_ENV_FILE: path.join(root, 'missing-claude-env.sh'),
      MODELDECK_ZSHENV_PATH: path.join(root, 'missing-zshenv'),
      MODELDECK_CODEX_PROFILES_DIR: codexProfilesDir,
      MODELDECK_CODEX_ACTIVE_LINK: path.join(root, 'missing-active-codex'),
      MODELDECK_CLIPROXY_CONFIG_DIR: path.join(root, 'missing-cliproxyapi'),
      MODELDECK_CLIPROXY_AUTH_DIR: path.join(root, 'missing-cliproxyapi', 'auth'),
      MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH: path.join(root, 'missing-cliproxyapi', '.mgmt-key'),
      MODELDECK_LAUNCHCTL_PATH: launchctlFixture,
    },
  };
}

test('MD-L04 tracer reaches the JSON CLI for missing activation links', (t) => {
  const estate = tracerEstate(t);
  const result = runLint(estate);

  assert.notEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const findings = report.findings.filter((finding) => finding.ruleId === 'MD-L04');
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.severity === 'error'));
  assert.deepEqual(findings.map((finding) => finding.scope).sort(), ['machine:claude', 'machine:codex']);
  assert.ok(findings.every((finding) => finding.fingerprint));
});

test('CLI launchctl override reaches the collector without touching the live daemon', (t) => {
  const estate = tracerEstate(t);
  estate.env.MODELDECK_LAUNCHCTL_FIXTURE_STATE = 'cli-sentinel';

  const result = runLint(estate);
  const finding = JSON.parse(result.stdout).findings.find((item) => item.ruleId === 'MD-L12');

  assert.equal(finding?.severity, 'error');
  assert.ok(finding.evidence.some((item) => item.lastExitCode === 77 && item.needsLwcrUpdate === true));
});

test('CLI JSON carries the full finding shape and stable fingerprints across reruns', (t) => {
  const estate = tracerEstate(t);
  const first = runLint(estate);
  const second = runLint(estate);
  assert.notEqual(first.status, 0, first.stderr);
  assert.notEqual(second.status, 0, second.stderr);
  const firstReport = JSON.parse(first.stdout);
  const secondReport = JSON.parse(second.stdout);
  assert.deepEqual(
    firstReport.findings.map((finding) => finding.fingerprint),
    secondReport.findings.map((finding) => finding.fingerprint),
  );
  for (const finding of firstReport.findings) {
    assert.deepEqual(Object.keys(finding).sort(), [
      'evidence', 'fingerprint', 'message', 'provenance', 'ruleId', 'scope', 'severity', 'suggestedFix',
    ]);
  }
});

test('human output is a readable table and errors alone make the command nonzero', (t) => {
  const estate = tracerEstate(t);
  const result = runLint(estate, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^SEVERITY\s+RULE\s+SCOPE\s+MESSAGE/m);
  assert.match(result.stdout, /ERROR\s+MD-L04\s+machine:claude/);
  assert.match(result.stdout, /EVIDENCE/);
  assert.match(result.stdout, /SUGGESTED FIX/);
});

test('warnings and info findings leave the CLI exit code at zero', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-lint-empty-'));
  const dbPath = path.join(root, 'modeldeck.sqlite');
  const store = new Store(dbPath);
  store.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runLint({
    root,
    env: {
      ...process.env,
      PATH: path.join(root, 'fixture-bin'),
      MODELDECK_DB_PATH: dbPath,
      MODELDECK_DATA_DIR: root,
      MODELDECK_CLAUDE_PROFILES_DIR: path.join(root, 'missing-claude-profiles'),
      MODELDECK_CLAUDE_ACTIVE_LINK: path.join(root, 'missing-active-claude'),
      MODELDECK_CLAUDE_SHELL_ENV_FILE: path.join(root, 'missing-claude-env.sh'),
      MODELDECK_ZSHENV_PATH: path.join(root, 'missing-zshenv'),
      MODELDECK_CODEX_PROFILES_DIR: path.join(root, 'missing-codex-profiles'),
      MODELDECK_CODEX_ACTIVE_LINK: path.join(root, 'missing-active-codex'),
      MODELDECK_CLIPROXY_CONFIG_DIR: path.join(root, 'missing-proxy'),
      MODELDECK_CLIPROXY_AUTH_DIR: path.join(root, 'missing-proxy', 'auth'),
      MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH: path.join(root, 'missing-proxy', '.mgmt-key'),
      MODELDECK_LAUNCHCTL_PATH: launchctlFixture,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).findings.every((finding) => finding.severity !== 'error'));
});

test('unreadable settings reach the CLI as could-not-evaluate findings', (t) => {
  const estate = tracerEstate(t);
  const settings = path.join(estate.env.MODELDECK_CLAUDE_PROFILES_DIR, 'work-claude', 'settings.json');
  fs.unlinkSync(settings);
  fs.mkdirSync(settings, { mode: 0o700 });
  const report = JSON.parse(runLint(estate).stdout);
  for (const ruleId of ['MD-L01', 'MD-L02', 'MD-L03']) {
    const finding = report.findings.find((item) => item.ruleId === ruleId);
    assert.match(finding.message, /could not evaluate/i, ruleId);
    assert.notEqual(finding.severity, 'error', ruleId);
  }
});

test('CLI consumes the daemon store version fact for version-gated error rules', (t) => {
  const estate = tracerEstate(t, {
    configLintFacts: {
      installedCliVersions: { claude: '2.1.223', codex: '0.87.0' },
      claudeWeeklyFingerprints: { 'claude-placeholder-work': 1_000 },
    },
  });
  const settings = path.join(estate.env.MODELDECK_CLAUDE_PROFILES_DIR, 'work-claude', 'settings.json');
  fs.writeFileSync(settings, '{"apiKeyHelper":"placeholder-helper"}\n', { mode: 0o600 });

  const result = runLint(estate);
  const finding = JSON.parse(result.stdout).findings.find((item) => item.ruleId === 'MD-L01');
  assert.equal(finding?.severity, 'error');
  assert.doesNotMatch(finding?.message || '', /could not evaluate/i);
});

test('CLI consumes persisted Claude duplicate fingerprints', (t) => {
  const estate = tracerEstate(t, { keepStoreOpen: true });
  const secondHome = path.join(estate.env.MODELDECK_CLAUDE_PROFILES_DIR, 'second-claude');
  fs.mkdirSync(secondHome, { mode: 0o700 });
  fs.writeFileSync(path.join(secondHome, 'settings.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(secondHome, '.claude.json'), '{}\n', { mode: 0o600 });
  const second = estate.writer.saveAccount({
    id: 'claude-placeholder-second',
    provider: 'claude',
    label: 'Second Claude',
    identity: 'second@example.invalid',
    profileRef: secondHome,
  });
  estate.writer.saveConfigLintFacts({
    installedCliVersions: { claude: '2.1.223', codex: '0.87.0' },
    claudeWeeklyFingerprints: {
      [estate.accounts.claude.id]: 1_000,
      [second.id]: 1_000,
    },
  });

  const findings = JSON.parse(runLint(estate).stdout).findings.filter((item) => (
    item.ruleId === 'MD-L07' && item.evidence.some((entry) => entry.source === 'daemon weekly-reset fingerprints')
  ));
  assert.deepEqual(findings.map((finding) => finding.scope).sort(), [
    `profile:${estate.accounts.claude.id}`,
    `profile:${second.id}`,
  ].sort());
  assert.ok(findings.every((finding) => finding.severity === 'error'));
});

test('a complete CLI lint makes zero content or mtime changes in its fixture estate', (t) => {
  const estate = tracerEstate(t);
  const before = treeState(estate.root);
  const result = runLint(estate);
  assert.notEqual(result.status, 0, result.stderr);
  const findings = JSON.parse(result.stdout).findings.filter((finding) => finding.ruleId === 'MD-L04');
  assert.deepEqual(findings.map((finding) => finding.scope).sort(), ['machine:claude', 'machine:codex']);
  assert.deepEqual(treeState(estate.root), before);
});

test('CLI read-only store declares the Node 24.16 deserialize floor', () => {
  const metadata = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.engines.node, '>=24.16.0');
});

test('a live WAL roster stays current and read-only during CLI lint', (t) => {
  const estate = tracerEstate(t, { keepStoreOpen: true });
  const before = treeState(estate.root);
  const result = runLint(estate);
  assert.notEqual(result.status, 0, result.stderr);
  const findings = JSON.parse(result.stdout).findings.filter((finding) => finding.ruleId === 'MD-L04');
  assert.deepEqual(findings.map((finding) => finding.scope).sort(), ['machine:claude', 'machine:codex']);
  assert.deepEqual(treeState(estate.root), before);
});

test('a WAL frame with a bad checksum becomes could-not-evaluate without changing the estate', (t) => {
  const estate = tracerEstate(t, { keepStoreOpen: true });
  const walPath = `${estate.env.MODELDECK_DB_PATH}-wal`;
  const wal = fs.readFileSync(walPath);
  assert.ok(wal.length > 52, 'fixture WAL must contain a complete frame');
  wal[48] ^= 0xff;
  fs.writeFileSync(walPath, wal);
  const before = treeState(estate.root);

  const result = runLint(estate);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.findings.length, 16);
  assert.ok(report.findings.every((finding) => /could not evaluate/i.test(finding.message)));
  assert.ok(report.findings.every((finding) => finding.evidence.some((item) => /checksum/i.test(item.reason || ''))));
  assert.deepEqual(treeState(estate.root), before);
});

test('an impossible WAL commit size is refused before allocation', (t) => {
  const estate = tracerEstate(t, { keepStoreOpen: true });
  const walPath = `${estate.env.MODELDECK_DB_PATH}-wal`;
  const wal = fs.readFileSync(walPath);
  const encodedPageSize = wal.readUInt32BE(8);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const frameSize = pageSize + 24;
  let commitOffset = null;
  for (let offset = 32; offset + frameSize <= wal.length; offset += frameSize) {
    if (wal.readUInt32BE(offset + 4) > 0) commitOffset = offset;
  }
  assert.notEqual(commitOffset, null, 'fixture WAL must contain a commit frame');
  wal.writeUInt32BE(0xffff_ffff, commitOffset + 4);
  fs.writeFileSync(walPath, wal);

  const result = runLint(estate);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.findings.length, 16);
  assert.ok(report.findings.every((finding) => finding.evidence.some((item) => /database size/i.test(item.reason || ''))));
});

test('a missing database is reported as could-not-evaluate JSON instead of stderr-only failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-lint-missing-db-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runLint({
    root,
    env: {
      ...process.env,
      PATH: path.join(root, 'fixture-bin'),
      MODELDECK_DB_PATH: path.join(root, 'missing.sqlite'),
      MODELDECK_DATA_DIR: root,
      MODELDECK_CLAUDE_PROFILES_DIR: path.join(root, 'missing-claude-profiles'),
      MODELDECK_CLAUDE_ACTIVE_LINK: path.join(root, 'missing-active-claude'),
      MODELDECK_CLAUDE_SHELL_ENV_FILE: path.join(root, 'missing-claude-env.sh'),
      MODELDECK_ZSHENV_PATH: path.join(root, 'missing-zshenv'),
      MODELDECK_CODEX_PROFILES_DIR: path.join(root, 'missing-codex-profiles'),
      MODELDECK_CODEX_ACTIVE_LINK: path.join(root, 'missing-active-codex'),
      MODELDECK_CLIPROXY_CONFIG_DIR: path.join(root, 'missing-proxy'),
      MODELDECK_CLIPROXY_AUTH_DIR: path.join(root, 'missing-proxy', 'auth'),
      MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH: path.join(root, 'missing-proxy', '.mgmt-key'),
      MODELDECK_LAUNCHCTL_PATH: launchctlFixture,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.findings.length, 16);
  assert.ok(report.findings.every((finding) => /could not evaluate/i.test(finding.message)));
});

test('lint rejects arguments other than --json', (t) => {
  const estate = tracerEstate(t);
  const result = runLint(estate, ['--wat']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown lint option.*--wat/i);
});
