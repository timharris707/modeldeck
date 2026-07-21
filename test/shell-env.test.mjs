import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #66: the ~/.zshenv block must source the daemon-written pinned env
// snippet (both CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR) and
// only fall back to the legacy readlink-derived secure-storage scope before
// the first activation. Runs against a temporary HOME — never the real one.
const script = fileURLToPath(new URL('../scripts/install-shell-env.sh', import.meta.url));

function runInstaller(home, args = []) {
  execFileSync('/bin/sh', [script, ...args], { env: { ...process.env, HOME: home } });
}

function fixtureHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-shellenv-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('installs a block that sources the pinned env file with a readlink fallback', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const content = fs.readFileSync(path.join(home, '.zshenv'), 'utf8');
  assert.ok(content.includes('# >>> ModelDeck Claude identity switching >>>'));
  assert.ok(content.includes('# <<< ModelDeck Claude identity switching <<<'));
  // The block resolves the same override variable the daemon honors, with
  // the same default, so activation writes and shell sourcing cannot
  // diverge under MODELDECK_CLAUDE_SHELL_ENV_FILE.
  assert.ok(content.includes('_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"'));
  assert.ok(content.includes('. "$_modeldeck_claude_env"'));
  // Fallback only sets the secure-storage scope; it must never pretend to
  // pin CLAUDE_CONFIG_DIR from a launch-time readlink.
  assert.ok(content.includes('export CLAUDE_SECURESTORAGE_CONFIG_DIR="$(readlink ~/.claude 2>/dev/null || true)"'));
  assert.ok(!content.includes('export CLAUDE_CONFIG_DIR='));

  // Idempotent: a second run adds nothing.
  runInstaller(home);
  assert.equal(fs.readFileSync(path.join(home, '.zshenv'), 'utf8'), content);
});

test('sourcing the block exports the pinned pair when the env file exists', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const dataDir = path.join(home, 'Library', 'Application Support', 'ModelDeck');
  fs.mkdirSync(dataDir, { recursive: true });
  const profile = path.join(home, 'profiles', 'work');
  fs.writeFileSync(path.join(dataDir, 'claude-env.sh'), [
    `export CLAUDE_CONFIG_DIR='${profile}'`,
    `export CLAUDE_SECURESTORAGE_CONFIG_DIR='${profile}'`,
    '',
  ].join('\n'));
  const output = execFileSync('/bin/sh', ['-c', '. "$HOME/.zshenv"; printf "%s\\n%s" "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR"'], {
    env: { HOME: home, PATH: process.env.PATH },
  }).toString();
  assert.deepEqual(output.split('\n'), [profile, profile]);
});

test('override path agrees end-to-end: daemon write path and generated block source the same file', async (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const overrideFile = path.join(home, 'custom-state', 'claude-env.sh');

  // Daemon side: paths.mjs must resolve the same override the shell block
  // reads. Fresh module instance via a query-string cache-buster so the
  // env override set here is actually observed.
  process.env.MODELDECK_CLAUDE_SHELL_ENV_FILE = overrideFile;
  t.after(() => { delete process.env.MODELDECK_CLAUDE_SHELL_ENV_FILE; });
  const paths = await import('../src/paths.mjs?shell-env-override');
  assert.equal(paths.CLAUDE_SHELL_ENV_FILE, overrideFile);

  // Activation writes through that path...
  const { Store } = await import('../src/db.mjs');
  const { ModelDeckService } = await import('../src/service.mjs');
  const profilesDir = path.join(home, 'profiles');
  const profileHome = path.join(profilesDir, 'work');
  fs.mkdirSync(profileHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);
  fs.chmodSync(profileHome, 0o700);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    claudeActiveLink: path.join(home, 'active', '.claude'),
    claudeShellEnvFile: paths.CLAUDE_SHELL_ENV_FILE,
    platform: 'linux',
    listProviderProcesses: async () => [],
  });
  const account = store.saveAccount({ provider: 'claude', label: 'Work', profileRef: profileHome });
  await service.activateAccount(account.id);
  assert.ok(fs.existsSync(overrideFile));

  // ...and a shell sourcing the installed block with the same override
  // exports the pinned pair from that exact file.
  const output = execFileSync('/bin/sh', ['-c', '. "$HOME/.zshenv"; printf "%s\\n%s" "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR"'], {
    env: { HOME: home, PATH: process.env.PATH, MODELDECK_CLAUDE_SHELL_ENV_FILE: overrideFile },
  }).toString();
  const realProfile = fs.realpathSync(profileHome);
  assert.deepEqual(output.split('\n'), [realProfile, realProfile]);
});

test('upgrades a legacy readlink-only block in place and --remove restores the file', (t) => {
  const home = fixtureHome(t);
  const zshenv = path.join(home, '.zshenv');
  fs.writeFileSync(zshenv, [
    'export EDITOR=vi',
    '',
    '# >>> ModelDeck Claude identity switching >>>',
    'export CLAUDE_SECURESTORAGE_CONFIG_DIR="$(readlink ~/.claude 2>/dev/null || true)"',
    '# <<< ModelDeck Claude identity switching <<<',
    '',
  ].join('\n'));
  runInstaller(home);
  const upgraded = fs.readFileSync(zshenv, 'utf8');
  assert.ok(upgraded.includes('export EDITOR=vi'));
  assert.ok(upgraded.includes('ModelDeck/claude-env.sh'));
  assert.equal(upgraded.match(/>>> ModelDeck Claude identity switching >>>/g).length, 1);

  runInstaller(home, ['--remove']);
  const removed = fs.readFileSync(zshenv, 'utf8');
  assert.ok(removed.includes('export EDITOR=vi'));
  assert.ok(!removed.includes('ModelDeck'));
});
