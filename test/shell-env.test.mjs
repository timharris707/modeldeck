import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudePinnedEnvFileContent } from '../src/adapters/claude.mjs';

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

test('a failed proxy Keychain lookup exports an empty key without breaking shell startup', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const dataDir = path.join(home, 'Library', 'Application Support', 'ModelDeck');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(dataDir, 'claude-env.sh'), claudePinnedEnvFileContent('/profiles/proxied', true));
  // Never touch the test runner's real Keychain. This stand-in models a
  // missing item by failing noisily; the generated pointer must suppress the
  // error, export an empty value, and let even a `set -e` shell continue.
  fs.writeFileSync(path.join(binDir, 'security'), [
    '#!/bin/sh',
    'echo "fixture Keychain item missing" >&2',
    'exit 44',
    '',
  ].join('\n'), { mode: 0o700 });
  const output = execFileSync('/bin/sh', ['-c', 'set -eu; . "$HOME/.zshenv"; printf "<%s>\\ncontinued" "$ANTHROPIC_API_KEY"'], {
    env: { HOME: home, PATH: `${binDir}:/usr/bin:/bin` },
  }).toString();
  assert.equal(output, '<>\ncontinued');
});

test('an unproxied profile clears an inherited key, but never the user\'s own (CodeRabbit, PR #278)', (t) => {
  // The nested-shell case: a shell started while a PROXIED profile was
  // active exports the key; switching to an unproxied profile rewrites
  // claude-env.sh, and a subshell sourcing it must come up WITHOUT the key
  // — an unproxied profile authenticates with its stored OAuth, and an API
  // key would override and break it. Omitting the export is not enough,
  // because the child inherits it.
  const home = fixtureHome(t);
  runInstaller(home);
  const dataDir = path.join(home, 'Library', 'Application Support', 'ModelDeck');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'claude-env.sh'), claudePinnedEnvFileContent('/profiles/plain', false));

  // Inherited from a proxied-profile parent: OUR marker is set, so ours goes.
  const cleared = execFileSync('/bin/sh', ['-c', 'set -eu; . "$HOME/.zshenv"; printf "<%s>" "${ANTHROPIC_API_KEY:-}"'], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: 'inherited-proxy-key-placeholder',
      MODELDECK_MANAGED_ANTHROPIC_API_KEY: '1',
    },
  }).toString();
  assert.equal(cleared, '<>', 'a key ModelDeck exported is cleared');

  // The user's OWN key (no marker) must survive untouched — ModelDeck does
  // not own this variable when it did not set it.
  const preserved = execFileSync('/bin/sh', ['-c', 'set -eu; . "$HOME/.zshenv"; printf "<%s>" "${ANTHROPIC_API_KEY:-}"'], {
    env: { HOME: home, PATH: process.env.PATH, ANTHROPIC_API_KEY: 'user-own-key-placeholder' },
  }).toString();
  assert.equal(preserved, '<user-own-key-placeholder>', "a user's own key is never touched");
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

// Issue #161: the Codex block freezes CODEX_HOME per terminal by resolving
// the ~/.codex active-profile symlink once at shell startup, mirroring the
// Claude pinning so a `codex login` can never land in a profile that was
// activated after the terminal opened.
test('installs a Codex block that resolves the symlink once and respects an explicit CODEX_HOME', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const content = fs.readFileSync(path.join(home, '.zshenv'), 'utf8');
  assert.ok(content.includes('# >>> ModelDeck Codex identity switching >>>'));
  assert.ok(content.includes('# <<< ModelDeck Codex identity switching <<<'));
  // Precedence guard: an already-exported CODEX_HOME (per-profile launch
  // commands, issue #106) must never be overwritten.
  assert.ok(content.includes('if [ -z "${CODEX_HOME:-}" ]; then'));
  assert.ok(content.includes('readlink ~/.codex'));

  // Idempotent: a second run adds nothing.
  runInstaller(home);
  assert.equal(fs.readFileSync(path.join(home, '.zshenv'), 'utf8'), content);
  assert.equal(content.match(/>>> ModelDeck Codex identity switching >>>/g).length, 1);
});

test('sourcing the Codex block exports the symlink target frozen at shell open', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const profile = path.join(home, '.codex-profiles', 'work');
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(profile, path.join(home, '.codex'));
  const output = execFileSync('/bin/sh', ['-c', '. "$HOME/.zshenv"; printf "%s" "${CODEX_HOME:-}"'], {
    env: { HOME: home, PATH: process.env.PATH },
  }).toString();
  assert.equal(output, profile);
});

test('a RELATIVE symlink target is anchored at $HOME before export (PR #162 review)', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const profile = path.join(home, '.codex-profiles', 'work');
  fs.mkdirSync(profile, { recursive: true });
  // Symlink created with a relative target, as a hand-made `ln -s` might be.
  fs.symlinkSync(path.join('.codex-profiles', 'work'), path.join(home, '.codex'));
  const output = execFileSync('/bin/sh', ['-c', '. "$HOME/.zshenv"; printf "%s" "${CODEX_HOME:-}"'], {
    env: { HOME: home, PATH: process.env.PATH },
  }).toString();
  assert.equal(output, profile);
});

test('no ~/.codex symlink means no CODEX_HOME export (stock behavior)', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  // Nothing at ~/.codex at all.
  const missing = execFileSync('/bin/sh', ['-c', '. "$HOME/.zshenv"; printf "%s" "${CODEX_HOME:-unset}"'], {
    env: { HOME: home, PATH: process.env.PATH },
  }).toString();
  assert.equal(missing, 'unset');
  // A real (unmanaged) directory at ~/.codex is not a symlink either.
  fs.mkdirSync(path.join(home, '.codex'));
  const realDir = execFileSync('/bin/sh', ['-c', '. "$HOME/.zshenv"; printf "%s" "${CODEX_HOME:-unset}"'], {
    env: { HOME: home, PATH: process.env.PATH },
  }).toString();
  assert.equal(realDir, 'unset');
});

test('an already-exported CODEX_HOME wins over the symlink (issue #106 launch commands)', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  const active = path.join(home, '.codex-profiles', 'active');
  const explicit = path.join(home, '.codex-profiles', 'explicit');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(explicit, { recursive: true });
  fs.symlinkSync(active, path.join(home, '.codex'));
  const output = execFileSync('/bin/sh', ['-c', '. "$HOME/.zshenv"; printf "%s" "$CODEX_HOME"'], {
    env: { HOME: home, PATH: process.env.PATH, CODEX_HOME: explicit },
  }).toString();
  assert.equal(output, explicit);
});

test('adds the Codex block to a pre-#161 install without duplicating the Claude block', (t) => {
  const home = fixtureHome(t);
  const zshenv = path.join(home, '.zshenv');
  // A ~/.zshenv exactly as the pre-#161 installer left it: Claude block
  // present (with the claude-env.sh marker), no Codex block.
  fs.writeFileSync(zshenv, [
    'export EDITOR=vi',
    '',
    '# >>> ModelDeck Claude identity switching >>>',
    '_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"',
    'if [ -f "$_modeldeck_claude_env" ]; then',
    '  . "$_modeldeck_claude_env"',
    'else',
    '  export CLAUDE_SECURESTORAGE_CONFIG_DIR="$(readlink ~/.claude 2>/dev/null || true)"',
    'fi',
    'unset _modeldeck_claude_env',
    '# <<< ModelDeck Claude identity switching <<<',
    '',
  ].join('\n'));
  runInstaller(home);
  const upgraded = fs.readFileSync(zshenv, 'utf8');
  assert.equal(upgraded.match(/>>> ModelDeck Claude identity switching >>>/g).length, 1);
  assert.equal(upgraded.match(/>>> ModelDeck Codex identity switching >>>/g).length, 1);
  assert.ok(upgraded.includes('export EDITOR=vi'));
});

test('--remove strips the Codex block too', (t) => {
  const home = fixtureHome(t);
  runInstaller(home);
  runInstaller(home, ['--remove']);
  const removed = fs.readFileSync(path.join(home, '.zshenv'), 'utf8');
  assert.ok(!removed.includes('ModelDeck'));
  assert.ok(!removed.includes('CODEX_HOME'));
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
