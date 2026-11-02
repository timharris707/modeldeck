import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { evaluateConfigLint } from '../src/config-linter.mjs';
import { classifyLaunchdPrint, collectConfigLintSnapshot } from '../src/config-linter-snapshot.mjs';

const estateSource = fileURLToPath(new URL('./fixtures/config-linter/estate/', import.meta.url));
const cleanSnapshotSource = fileURLToPath(new URL('./fixtures/config-linter/clean.json', import.meta.url));
const launchctlFixture = fileURLToPath(new URL('./fixtures/config-linter/launchctl-fixture.sh', import.meta.url));
const healthyLaunchdOutput = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/config-linter/launchctl-healthy.txt', import.meta.url)),
  'utf8',
);
const spawnFailedLaunchdOutput = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/config-linter/launchctl-spawn-failed.txt', import.meta.url)),
  'utf8',
);
const readHealthyLaunchd = async () => ({ exitCode: 0, output: healthyLaunchdOutput });

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

function estate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-lint-estate-'));
  fs.cpSync(estateSource, root, { recursive: true, preserveTimestamps: true });
  const paths = {
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    claudeActiveLink: path.join(root, 'active', '.claude'),
    codexActiveLink: path.join(root, 'active', '.codex'),
    claudeShellEnvFile: path.join(root, 'data', 'claude-env.sh'),
    zshenvPath: path.join(root, 'home', '.zshenv'),
    sharedScopeDir: path.join(root, 'shared'),
    cliproxyConfigDir: path.join(root, 'proxy'),
    cliproxyAuthDir: path.join(root, 'proxy', 'auth'),
    cliproxyManagementKeyPath: path.join(root, 'proxy', '.mgmt-key'),
  };
  for (const directory of [
    paths.claudeProfilesDir,
    paths.codexProfilesDir,
    path.join(paths.claudeProfilesDir, 'a'),
    path.join(paths.claudeProfilesDir, 'b'),
    path.join(paths.codexProfilesDir, 'a'),
    path.join(paths.codexProfilesDir, 'b'),
    paths.cliproxyConfigDir,
    paths.cliproxyAuthDir,
  ]) fs.chmodSync(directory, 0o700);
  for (const file of [
    path.join(paths.claudeProfilesDir, 'a', 'settings.json'),
    path.join(paths.claudeProfilesDir, 'a', '.claude.json'),
    path.join(paths.claudeProfilesDir, 'b', 'settings.json'),
    path.join(paths.claudeProfilesDir, 'b', '.claude.json'),
    path.join(paths.codexProfilesDir, 'a', 'auth.json'),
    path.join(paths.codexProfilesDir, 'b', 'auth.json'),
    paths.cliproxyManagementKeyPath,
  ]) fs.chmodSync(file, 0o600);
  fs.chmodSync(path.join(root, 'bin', 'claude'), 0o700);
  fs.mkdirSync(path.dirname(paths.claudeActiveLink), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(paths.claudeShellEnvFile), { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(paths.claudeProfilesDir, 'a'), paths.claudeActiveLink);
  fs.symlinkSync(path.join(paths.codexProfilesDir, 'a'), paths.codexActiveLink);
  const sharedMemory = path.join(paths.sharedScopeDir, 'memory');
  fs.mkdirSync(sharedMemory, { recursive: true, mode: 0o700 });
  for (const name of ['a', 'b']) fs.symlinkSync(sharedMemory, path.join(paths.claudeProfilesDir, name, 'memory'));
  fs.writeFileSync(paths.claudeShellEnvFile, [
    `export CLAUDE_CONFIG_DIR='${path.join(paths.claudeProfilesDir, 'a')}'`,
    `export CLAUDE_SECURESTORAGE_CONFIG_DIR='${path.join(paths.claudeProfilesDir, 'a')}'`,
    '',
  ].join('\n'), { mode: 0o600 });

  const store = new Store(':memory:');
  const claudeA = store.saveAccount({ provider: 'claude', label: 'Claude A', identity: 'claude-a@example.invalid', profileRef: path.join(paths.claudeProfilesDir, 'a') });
  const claudeB = store.saveAccount({ provider: 'claude', label: 'Claude B', identity: 'claude-b@example.invalid', profileRef: path.join(paths.claudeProfilesDir, 'b') });
  const codexA = store.saveAccount({ provider: 'codex', label: 'Codex A', identity: 'codex-a@example.invalid', profileRef: path.join(paths.codexProfilesDir, 'a') });
  const codexB = store.saveAccount({ provider: 'codex', label: 'Codex B', identity: 'codex-b@example.invalid', profileRef: path.join(paths.codexProfilesDir, 'b') });
  store.saveSettings({ sharedUserScopeEnabled: true });
  store.saveConfigLintFacts({
    installedCliVersions: { claude: '2.1.223', codex: '0.87.0' },
    claudeWeeklyFingerprints: { [claudeA.id]: 1_000, [claudeB.id]: 2_000 },
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.sharedScopeDir, 'manifest.json'), 'utf8'));
  manifest.mergedProfiles = [claudeA.id, claudeB.id];
  fs.writeFileSync(path.join(paths.sharedScopeDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  for (const account of [claudeA, claudeB]) {
    const backup = path.join(paths.sharedScopeDir, 'backups', account.id);
    fs.mkdirSync(path.join(backup, 'memory'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(backup, '.claude.json'), '{}\n', { mode: 0o600 });
  }

  const service = new ModelDeckService(store, {
    ...paths,
    dataDir: root,
    claudePath: path.join(root, 'bin', 'claude'),
    childEnv: {
      PATH: path.join(root, 'bin'),
      MODELDECK_CLIPROXY_CONFIG_DIR: paths.cliproxyConfigDir,
    },
    platform: 'linux',
    listProviderProcesses: async () => [],
  });
  service.lastCompletedRefreshAt = Date.now();
  service.toolProbeCache = {
    value: { tools: { claude: { version: '2.1.223' }, codex: { version: '0.87.0' } } },
    expiresAt: Date.now() + 60_000,
  };
  service.managedProxyAppReport = { managed: true };

  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    paths,
    store,
    service,
    accounts: { claudeA, claudeB, codexA, codexB },
    collectOptions: {
      store,
      service,
      ...paths,
      launchctlPath: launchctlFixture,
      readLaunchd: readHealthyLaunchd,
    },
  };
}

test('collector turns a clean file estate into a no-finding snapshot without exposing secret bytes', async (t) => {
  const data = estate(t);
  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  assert.deepEqual(evaluateConfigLint(snapshot), []);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'placeholder-secret-bytes-must-not-surface',
    'another-placeholder-secret-must-not-surface',
    'placeholder-access-token-must-not-surface',
    'another-placeholder-access-token-must-not-surface',
    'placeholder-proxy-token-must-not-surface',
    'placeholder-management-key-never-read',
  ]) assert.ok(!serialized.includes(forbidden), forbidden);
});

test('MD-L03 keeps URL credentials and query values out of snapshots and findings', async (t) => {
  const data = estate(t);
  const settings = path.join(data.paths.claudeProfilesDir, 'a', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://placeholder-user:placeholder-password@proxy-other.example.invalid/path?token=placeholder-query',
    },
  }), { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L03');
  const serialized = JSON.stringify({ snapshot, finding });
  assert.equal(snapshot.claudeProfiles[0].settings.value.env.ANTHROPIC_BASE_URL, 'https://proxy-other.example.invalid');
  for (const forbidden of ['placeholder-user', 'placeholder-password', 'placeholder-query', '/path']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

test('registered profile symlinks never permit child reads outside managed roots', async (t) => {
  const data = estate(t);
  const outsideClaude = path.join(data.root, 'outside-claude-home');
  const outsideCodex = path.join(data.root, 'outside-codex-home');
  fs.mkdirSync(outsideClaude, { mode: 0o700 });
  fs.mkdirSync(outsideCodex, { mode: 0o700 });
  fs.writeFileSync(path.join(outsideClaude, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://outside-profile-marker.example.invalid' },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(outsideClaude, '.claude.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(outsideCodex, 'auth.json'), JSON.stringify({
    tokens: { account_id: 'outside-profile-account-marker' },
  }), { mode: 0o600 });

  const claudeHome = data.accounts.claudeA.profileRef;
  const codexHome = data.accounts.codexA.profileRef;
  fs.rmSync(claudeHome, { recursive: true });
  fs.rmSync(codexHome, { recursive: true });
  fs.symlinkSync(outsideClaude, claudeHome);
  fs.symlinkSync(outsideCodex, codexHome);
  const childReads = [];
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    readManagedFile: async (handle, file, encoding) => {
      if (file.startsWith(`${claudeHome}${path.sep}`) || file.startsWith(`${codexHome}${path.sep}`)) childReads.push(file);
      return handle.readFile(encoding);
    },
  });

  assert.deepEqual(childReads, []);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('outside-profile-marker'));
  assert.match(snapshot.claudeProfiles.find((profile) => profile.accountId === data.accounts.claudeA.id).settings.reason, /managed profile home/i);
  assert.match(snapshot.codexProfiles.find((profile) => profile.accountId === data.accounts.codexA.id).authAccountId.reason, /managed profile home/i);
});

test('managed profile validation cannot be swapped to an outside directory before child reads', async (t) => {
  const data = estate(t);
  const profile = data.accounts.claudeA.profileRef;
  const held = `${profile}-held`;
  const outside = path.join(data.root, 'outside-swapped-profile');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://outside-read-marker.example.invalid' },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(outside, '.claude.json'), '{}\n', { mode: 0o600 });
  let swapped = false;

  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    realpath: async (file) => {
      const canonical = await fs.promises.realpath(file);
      if (file === profile && !swapped) {
        fs.renameSync(profile, held);
        fs.symlinkSync(outside, profile);
        swapped = true;
      }
      return canonical;
    },
  });

  assert.equal(swapped, true);
  assert.ok(!JSON.stringify(snapshot).includes('outside-read-marker'));
  assert.match(
    snapshot.claudeProfiles.find((item) => item.accountId === data.accounts.claudeA.id).settings.reason,
    /managed profile home/i,
  );
});

test('MD-L05 rejects a marker block that sources the wrong env file', async (t) => {
  const data = estate(t);
  fs.writeFileSync(data.paths.zshenvPath, [
    '# >>> ModelDeck Claude identity switching >>>',
    '. "/fixture/wrong/claude-env.sh"',
    '# <<< ModelDeck Claude identity switching <<<',
    '# >>> ModelDeck Codex identity switching >>>',
    '# <<< ModelDeck Codex identity switching <<<',
    '',
  ].join('\n'), { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L05');
  assert.equal(finding?.severity, 'error');
  assert.match(finding?.message || '', /shell pinning/i);
});

test('MD-L06 rejects a marker-only Codex block that does not pin CODEX_HOME', async (t) => {
  const data = estate(t);
  fs.writeFileSync(data.paths.zshenvPath, [
    '# >>> ModelDeck Claude identity switching >>>',
    '_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"',
    '. "$_modeldeck_claude_env"',
    '# <<< ModelDeck Claude identity switching <<<',
    '# >>> ModelDeck Codex identity switching >>>',
    '# <<< ModelDeck Codex identity switching <<<',
    '',
  ].join('\n'), { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L06');
  assert.equal(finding?.severity, 'warn');
  assert.doesNotMatch(finding?.message || '', /could not evaluate/i);
});

test('shell inspection refuses symlinked zshenv and Claude env files without reading their targets', async (t) => {
  const data = estate(t);
  const outsideZshenv = path.join(data.root, 'outside-zshenv');
  const outsideClaudeEnv = path.join(data.root, 'outside-claude-env.sh');
  const targetMarker = 'never-read-shell-target-marker';
  fs.writeFileSync(outsideZshenv, [
    '# >>> ModelDeck Claude identity switching >>>',
    '_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"',
    '. "$_modeldeck_claude_env"',
    '# <<< ModelDeck Claude identity switching <<<',
    '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(outsideClaudeEnv, [
    `export CLAUDE_CONFIG_DIR='/fixture/${targetMarker}'`,
    `export CLAUDE_SECURESTORAGE_CONFIG_DIR='/fixture/${targetMarker}'`,
    '',
  ].join('\n'), { mode: 0o600 });
  fs.rmSync(data.paths.zshenvPath);
  fs.rmSync(data.paths.claudeShellEnvFile);
  fs.symlinkSync(outsideZshenv, data.paths.zshenvPath);
  fs.symlinkSync(outsideClaudeEnv, data.paths.claudeShellEnvFile);

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);

  assert.equal(snapshot.shell.zshenv.status, 'unknown');
  assert.match(snapshot.shell.zshenv.reason, /regular/i);
  assert.equal(snapshot.shell.claudeEnv.status, 'unknown');
  assert.match(snapshot.shell.claudeEnv.reason, /regular/i);
  assert.ok(!JSON.stringify(snapshot).includes(targetMarker));
});

test('unregistered Codex homes still participate in MD-L06 and MD-L08', async (t) => {
  const data = estate(t);
  data.store.deleteAccount(data.accounts.codexB.id);
  const unregistered = path.join(data.paths.codexProfilesDir, 'b');
  fs.chmodSync(unregistered, 0o755);
  fs.writeFileSync(path.join(unregistered, 'auth.json'), JSON.stringify({
    tokens: { account_id: 'acct-placeholder-a' },
  }), { mode: 0o600 });
  fs.writeFileSync(data.paths.zshenvPath, [
    '# >>> ModelDeck Claude identity switching >>>',
    '_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"',
    '. "$_modeldeck_claude_env"',
    '# <<< ModelDeck Claude identity switching <<<',
    '',
  ].join('\n'), { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  assert.ok(snapshot.codexProfiles.some((profile) => profile.path === unregistered));
  const findings = evaluateConfigLint(snapshot);
  assert.ok(findings.some((finding) => finding.ruleId === 'MD-L06'));
  assert.ok(findings.some((finding) => finding.ruleId === 'MD-L08' && finding.scope === `path:${unregistered}`));
  assert.equal(findings.some((finding) => (
    finding.ruleId === 'MD-L13' && finding.scope.endsWith('/proxy/auth/codex-a.json')
  )), false);
});

test('unreadable settings become could-not-evaluate findings instead of a crash or skip', async (t) => {
  const data = estate(t);
  const unreadable = fs.realpathSync(path.join(data.paths.claudeProfilesDir, 'a', 'settings.json'));
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    readManagedFile: async (handle, file, encoding) => {
      if (file === unreadable) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
      return handle.readFile(encoding);
    },
  });
  const findings = evaluateConfigLint(snapshot).filter((finding) => ['MD-L01', 'MD-L02', 'MD-L03'].includes(finding.ruleId));
  assert.deepEqual([...new Set(findings.map((finding) => finding.ruleId))], ['MD-L01', 'MD-L02', 'MD-L03']);
  assert.ok(findings.every((finding) => /could not evaluate/i.test(finding.message)));
  assert.ok(findings.every((finding) => finding.severity !== 'error'));
});

test('transient .claude.json I/O failure becomes could-not-evaluate MD-L09', async (t) => {
  const data = estate(t);
  const unreadable = fs.realpathSync(path.join(data.paths.claudeProfilesDir, 'a', '.claude.json'));
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    readManagedFile: async (handle, file, encoding) => {
      if (file === unreadable) throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' });
      return handle.readFile(encoding);
    },
  });
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L09');
  assert.match(finding?.message || '', /could not evaluate/i);
  assert.notEqual(finding?.severity, 'error');
});

test('a full lint collection makes zero content or mtime changes anywhere in the fixture estate', async (t) => {
  const data = estate(t);
  const before = treeState(data.root);
  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  evaluateConfigLint(snapshot);
  assert.deepEqual(treeState(data.root), before);
});

test('malformed nested values in .claude.json fire MD-L09 without exposing their bytes', async (t) => {
  const data = estate(t);
  const claudeJson = path.join(data.paths.claudeProfilesDir, 'a', '.claude.json');
  fs.writeFileSync(claudeJson, '{"oauthAccount":{"token":placeholderSecretMalformed}}\n', { mode: 0o600 });
  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L09');
  assert.equal(finding?.severity, 'error');
  assert.ok(!JSON.stringify(snapshot).includes('placeholderSecretMalformed'));
});

test('non-JSON whitespace in .claude.json fires MD-L09', async (t) => {
  const data = estate(t);
  const claudeJson = path.join(data.paths.claudeProfilesDir, 'a', '.claude.json');
  fs.writeFileSync(claudeJson, '\u00a0{}\n', { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L09');
  assert.equal(finding?.severity, 'error');
  assert.doesNotMatch(finding?.message || '', /could not evaluate/i);
});

test('non-JSON trailing whitespace in .claude.json fires MD-L09', async (t) => {
  const data = estate(t);
  const claudeJson = path.join(data.paths.claudeProfilesDir, 'a', '.claude.json');
  fs.writeFileSync(claudeJson, '{}\u00a0\n', { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L09');
  assert.equal(finding?.severity, 'error');
  assert.doesNotMatch(finding?.message || '', /could not evaluate/i);
});

test('non-JSON trailing whitespace in settings becomes could-not-evaluate', async (t) => {
  const data = estate(t);
  const settings = path.join(data.paths.claudeProfilesDir, 'a', 'settings.json');
  fs.writeFileSync(settings, '{"apiKeyHelper":true,"env":{"ANTHROPIC_API_KEY":"placeholder"}}\u00a0\n', { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const findings = evaluateConfigLint(snapshot).filter((finding) => ['MD-L01', 'MD-L02', 'MD-L03'].includes(finding.ruleId));
  assert.deepEqual(findings.map((finding) => finding.ruleId), ['MD-L01', 'MD-L02', 'MD-L03']);
  assert.ok(findings.every((finding) => /could not evaluate/i.test(finding.message)));
  assert.ok(findings.every((finding) => finding.severity !== 'error'));
});

test('non-JSON trailing whitespace in proxy metadata becomes could-not-evaluate', async (t) => {
  const data = estate(t);
  const authFile = path.join(data.paths.cliproxyAuthDir, 'trailing-placeholder.json');
  fs.writeFileSync(authFile, '{"type":"claude","email":"retired@example.invalid","weight":20}\u00a0\n', { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L13' && item.scope === `path:${authFile}`);
  assert.match(finding?.message || '', /could not evaluate/i);
  assert.notEqual(finding?.severity, 'error');
});

test('unreadable shared-scope backup markers become could-not-evaluate', async (t) => {
  const data = estate(t);
  const unreadable = path.join(data.paths.sharedScopeDir, 'backups', data.accounts.claudeA.id, '.claude.json');
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    lstat: async (file) => {
      if (file === unreadable) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
      return fs.promises.lstat(file);
    },
  });
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L10');
  assert.match(finding?.message || '', /could not evaluate/i);
});

test('malformed shared-scope manifest evidence never includes source bytes', async (t) => {
  const data = estate(t);
  const manifestPath = path.join(data.paths.sharedScopeDir, 'manifest.json');
  const sourceMarker = 'never-echo-manifest-marker';
  fs.writeFileSync(manifestPath, `{"mergedProfiles":[${sourceMarker}]}\n`, { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L10');
  const serialized = JSON.stringify({ snapshot, finding });

  assert.match(finding?.message || '', /could not evaluate/i);
  assert.ok(!serialized.includes('never-echo'));
});

test('one malformed proxy auth file cannot hide behind readable peers', async (t) => {
  const data = estate(t);
  fs.writeFileSync(path.join(data.paths.cliproxyAuthDir, 'broken-placeholder.json'), '{not-json\n', { mode: 0o600 });
  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const findings = evaluateConfigLint(snapshot).filter((item) => item.ruleId === 'MD-L13');
  assert.ok(findings.some((finding) => /could not evaluate/i.test(finding.message)));
});

test('proxy auth symlinks are not followed outside the auth directory', async (t) => {
  const data = estate(t);
  const outside = path.join(data.root, 'outside-proxy-auth.json');
  const link = path.join(data.paths.cliproxyAuthDir, 'linked-placeholder.json');
  fs.writeFileSync(outside, JSON.stringify({
    type: 'claude',
    email: 'outside-proxy-marker@example.invalid',
    weight: 25,
    access_token: 'outside-proxy-secret-marker',
  }), { mode: 0o600 });
  fs.symlinkSync(outside, link);

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('outside-proxy-marker'));
  assert.ok(!serialized.includes('outside-proxy-secret-marker'));
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L13' && item.scope === `path:${link}`);
  assert.match(finding?.message || '', /could not evaluate/i);
});

test('proxy auth files cannot be swapped to outside symlinks between metadata and content reads', async (t) => {
  const data = estate(t);
  const target = path.join(data.paths.cliproxyAuthDir, 'claude-a.json');
  const held = `${target}.held`;
  const outside = path.join(data.root, 'outside-swapped-proxy-auth.json');
  fs.writeFileSync(outside, JSON.stringify({
    type: 'claude',
    email: 'outside-proxy-read-marker@example.invalid',
    weight: 25,
    access_token: 'outside-proxy-secret-marker',
  }), { mode: 0o600 });
  let swapped = false;
  data.service.proxyAuthOpen = async (file, flags) => {
    if (file === target && !swapped) {
      fs.renameSync(target, held);
      fs.symlinkSync(outside, target);
      swapped = true;
    }
    return fs.promises.open(file, flags);
  };
  const snapshot = await collectConfigLintSnapshot(data.collectOptions);

  assert.equal(swapped, true);
  assert.ok(!JSON.stringify(snapshot).includes('outside-proxy-read-marker'));
});

test('MD-L13 sees every positive-weight auth file even when credential fields are absent', async (t) => {
  const data = estate(t);
  const retired = path.join(data.paths.cliproxyAuthDir, 'retired-placeholder.json');
  fs.writeFileSync(retired, JSON.stringify({
    type: 'claude', email: 'retired-placeholder@example.invalid', weight: 20,
  }), { mode: 0o600 });

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L13' && item.scope === `path:${retired}`);
  assert.equal(finding?.severity, 'warn');
  assert.doesNotMatch(finding?.message || '', /could not evaluate/i);
});

test('an empty readable proxy auth directory is a deterministic MD-L13 no-fire', async (t) => {
  const data = estate(t);
  for (const name of fs.readdirSync(data.paths.cliproxyAuthDir)) {
    fs.rmSync(path.join(data.paths.cliproxyAuthDir, name), { recursive: true, force: true });
  }

  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  assert.equal(evaluateConfigLint(snapshot).some((finding) => finding.ruleId === 'MD-L13'), false);
});

test('shared-scope manifest IDs cannot drive backup probes outside backups', async (t) => {
  const data = estate(t);
  const manifestPath = path.join(data.paths.sharedScopeDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.mergedProfiles.push('../outside-backup');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const escaped = path.join(data.paths.sharedScopeDir, 'outside-backup');
  const escapedProbes = [];

  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    lstat: async (file) => {
      if (file === escaped || file.startsWith(`${escaped}${path.sep}`)) escapedProbes.push(file);
      return fs.promises.lstat(file);
    },
  });
  assert.deepEqual(escapedProbes, []);
  assert.ok(snapshot.sharedScope.consistency.issues.some((issue) => issue.includes('../outside-backup')));
});

test('missing profile roots are recorded as absent, not permission drift', async (t) => {
  const data = estate(t);
  fs.rmSync(data.paths.codexProfilesDir, { recursive: true });
  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  assert.equal(snapshot.profileRoots.codex.exists, false);
  assert.equal(evaluateConfigLint(snapshot).some((finding) => finding.ruleId === 'MD-L08' && finding.scope.includes('codex')), false);
});

test('launchd parsing never guesses from empty output and recognizes both not-found exits', () => {
  assert.equal(classifyLaunchdPrint({ exitCode: 0, output: '' }).status, 'unknown');
  assert.equal(classifyLaunchdPrint({ exitCode: 3 }).state, 'not-found');
  assert.equal(classifyLaunchdPrint({ exitCode: 113 }).state, 'not-found');
});

test('incident-shaped full launchctl dump reaches MD-L12 despite later nested active states', () => {
  const snapshot = JSON.parse(fs.readFileSync(cleanSnapshotSource, 'utf8'));
  snapshot.launchd.daemon = classifyLaunchdPrint({ exitCode: 0, output: spawnFailedLaunchdOutput });

  assert.deepEqual(snapshot.launchd.daemon, {
    status: 'ok',
    label: 'ai.hermes.modeldeck',
    state: 'spawn-failed',
    lastExitCode: 78,
    needsLwcrUpdate: true,
  });
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L12');
  assert.equal(finding?.severity, 'error');
  assert.doesNotMatch(finding?.message || '', /could not evaluate/i);
});

test('healthy full launchctl dump remains an MD-L12 no-fire', () => {
  const snapshot = JSON.parse(fs.readFileSync(cleanSnapshotSource, 'utf8'));
  snapshot.launchd.daemon = classifyLaunchdPrint({ exitCode: 0, output: healthyLaunchdOutput });

  assert.equal(snapshot.launchd.daemon.state, 'running');
  assert.equal(evaluateConfigLint(snapshot).some((item) => item.ruleId === 'MD-L12'), false);
});

test('proxy launchd state is explicit when the managed proxy is app-owned', async (t) => {
  const data = estate(t);
  const snapshot = await collectConfigLintSnapshot(data.collectOptions);
  assert.deepEqual(snapshot.launchd.proxy, {
    status: 'ok',
    state: 'not-launchd-managed',
    source: 'managed proxy app report',
  });
});

test('runtime override lint covers every path pair that can split an install', async (t) => {
  const data = estate(t);
  const outside = path.join(path.dirname(data.root), `${path.basename(data.root)}-other-install`);
  const dbPath = path.join(outside, 'modeldeck.sqlite');
  const claudeProfilesDir = path.join(outside, 'claude-profiles');
  const codexProfilesDir = path.join(outside, 'codex-profiles');
  const claudeShellEnvFile = path.join(outside, 'claude-env.sh');
  const cliproxyManagementKeyPath = path.join(outside, '.mgmt-key');
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    dataDir: data.root,
    dbPath,
    claudeProfilesDir,
    codexProfilesDir,
    claudeShellEnvFile,
    cliproxyManagementKeyPath,
    runtimeEnv: {
      PATH: path.join(data.root, 'bin'),
      MODELDECK_DB_PATH: dbPath,
      MODELDECK_CLAUDE_PROFILES_DIR: claudeProfilesDir,
      MODELDECK_CODEX_PROFILES_DIR: codexProfilesDir,
      MODELDECK_CLAUDE_SHELL_ENV_FILE: claudeShellEnvFile,
      MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH: cliproxyManagementKeyPath,
    },
  });
  const findings = evaluateConfigLint(snapshot).filter((finding) => finding.ruleId === 'MD-L15');
  assert.equal(findings.length, 5);
  assert.deepEqual(
    findings.map((finding) => finding.evidence[0].path).sort(),
    [
      'MODELDECK_CLAUDE_PROFILES_DIR',
      'MODELDECK_CLAUDE_SHELL_ENV_FILE',
      'MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH',
      'MODELDECK_CODEX_PROFILES_DIR',
      'MODELDECK_DB_PATH',
    ],
  );
});

test('runtime override lint reports a data-dir split when proxy paths are unset', async (t) => {
  const data = estate(t);
  const dbPath = path.join(path.dirname(data.root), 'other-install', 'modeldeck.sqlite');
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    dataDir: data.root,
    dbPath,
    cliproxyConfigDir: null,
    cliproxyAuthDir: null,
    cliproxyManagementKeyPath: null,
    runtimeEnv: {
      PATH: path.join(data.root, 'bin'),
      MODELDECK_DB_PATH: dbPath,
    },
  });

  assert.equal(snapshot.runtimeOverrides.status, 'ok');
  const findings = evaluateConfigLint(snapshot).filter((finding) => finding.ruleId === 'MD-L15');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence[0].path, 'MODELDECK_DB_PATH');
});

test('MD-L11 PATH enumeration is sorted, deduplicated, and stable without CLI spawns', async (t) => {
  const data = estate(t);
  const secondBin = path.join(data.root, 'second-bin');
  fs.mkdirSync(secondBin, { mode: 0o700 });
  fs.copyFileSync(path.join(data.root, 'bin', 'claude'), path.join(secondBin, 'claude'));
  fs.chmodSync(path.join(secondBin, 'claude'), 0o700);
  data.service.childEnv.PATH = [secondBin, path.join(data.root, 'bin'), secondBin].join(path.delimiter);
  let spawns = 0;
  data.service.exec = async () => { spawns += 1; throw new Error('fixture forbids process spawns'); };
  const first = await collectConfigLintSnapshot(data.collectOptions);
  const second = await collectConfigLintSnapshot(data.collectOptions);
  assert.equal(spawns, 0);
  assert.deepEqual(first.pathExecutables, second.pathExecutables);
  assert.deepEqual(
    first.pathExecutables.items.map((item) => item.path),
    [path.join(data.root, 'bin', 'claude'), path.join(secondBin, 'claude')].sort(),
  );
  const finding = evaluateConfigLint(first).find((item) => item.ruleId === 'MD-L11');
  assert.equal(finding?.severity, 'info');
  assert.match(finding?.message || '', /could not evaluate/i);
});

test('MD-L11 reports unexpected PATH I/O failures instead of silently skipping them', async (t) => {
  const data = estate(t);
  const candidate = path.join(data.root, 'bin', 'claude');
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    access: async (file, mode) => {
      if (file === candidate) throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' });
      return fs.promises.access(file, mode);
    },
  });
  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L11');
  assert.match(finding?.message || '', /could not evaluate/i);
  assert.ok(finding.evidence.some((item) => item.reason === 'EIO'));
});

test('launchd inspection honors the injected executable and never touches live launchctl in tests', async (t) => {
  const data = estate(t);
  const executables = [];
  data.service.exec = async (executable) => {
    executables.push(executable);
    return { exitCode: 3, output: '' };
  };
  await collectConfigLintSnapshot({
    ...data.collectOptions,
    readLaunchd: undefined,
    launchctlPath: launchctlFixture,
  });
  assert.deepEqual(executables, [launchctlFixture]);
  assert.equal(executables.includes('/bin/launchctl'), false);
});

// Issue #785: with the usage-queue consumer on, the linter reads only the
// retention number from the proxy's config.yaml, which also holds secrets.
test('MD-L17 reads only the retention number from the proxy config', async (t) => {
  const data = estate(t);
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  const configFile = path.join(data.paths.cliproxyConfigDir, 'config.yaml');
  const secrets = [
    'remote-management:',
    '  secret-key: "placeholder-config-secret-must-not-surface"',
    'api-keys:',
    '  - "placeholder-client-key-must-not-surface"',
  ];
  fs.writeFileSync(configFile, `${secrets.join('\n')}\n`, { mode: 0o600 });

  let snapshot = await collectConfigLintSnapshot(data.collectOptions);
  let findings = evaluateConfigLint(snapshot).filter((item) => item.ruleId === 'MD-L17');
  assert.deepEqual(snapshot.proxy.usageQueue, {
    status: 'ok', consumerEnabled: true, path: configFile, retentionSeconds: 60, retentionSource: 'default',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  const serialized = JSON.stringify({ snapshot, findings });
  for (const forbidden of ['placeholder-config-secret-must-not-surface', 'placeholder-client-key-must-not-surface']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }

  fs.writeFileSync(configFile, `${secrets.join('\n')}\nredis-usage-queue-retention-seconds: 3600\n`, { mode: 0o600 });
  snapshot = await collectConfigLintSnapshot(data.collectOptions);
  assert.equal(snapshot.proxy.usageQueue.retentionSeconds, 3600);
  assert.deepEqual(evaluateConfigLint(snapshot).filter((item) => item.ruleId === 'MD-L17'), []);
});

test('MD-L17 never opens the proxy config while the usage-queue consumer is off', async (t) => {
  const data = estate(t);
  const configFile = path.join(data.paths.cliproxyConfigDir, 'config.yaml');
  fs.writeFileSync(configFile, 'host: "127.0.0.1"\n', { mode: 0o600 });
  const opened = [];
  const snapshot = await collectConfigLintSnapshot({
    ...data.collectOptions,
    open: async (file, flags) => { opened.push(file); return fs.promises.open(file, flags); },
  });
  assert.deepEqual(snapshot.proxy.usageQueue, { status: 'ok', consumerEnabled: false });
  assert.ok(!opened.includes(configFile));
});

test('MD-L17 cannot evaluate a missing or symlinked proxy config', async (t) => {
  const data = estate(t);
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  const configFile = path.join(data.paths.cliproxyConfigDir, 'config.yaml');
  const outside = path.join(data.root, 'outside.yaml');
  fs.writeFileSync(outside, 'redis-usage-queue-retention-seconds: 3600\n', { mode: 0o600 });

  for (const prepare of [() => {}, () => fs.symlinkSync(outside, configFile)]) {
    fs.rmSync(configFile, { force: true });
    prepare();
    const snapshot = await collectConfigLintSnapshot(data.collectOptions);
    assert.equal(snapshot.proxy.usageQueue.status, 'unknown');
    const findings = evaluateConfigLint(snapshot).filter((item) => item.ruleId === 'MD-L17');
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /could not evaluate/i);
  }
});
