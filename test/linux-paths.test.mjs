import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDataDir, defaultSecretsDir } from '../src/paths.mjs';

// #807: app data follows the platform's convention; secrets live in an
// owner-only config directory where there is no Keychain (decision 0046).
test('macOS keeps app data under ~/Library', () => {
  assert.equal(defaultDataDir({ platform: 'darwin', home: '/Users/placeholder' }),
    '/Users/placeholder/Library/Application Support/ModelDeck');
});

// Codex review of #813: XDG variables would split the CLI and the systemd
// unit across folders, so the Linux folders are fixed.
test('Linux uses fixed folders whatever XDG says', () => {
  process.env.XDG_DATA_HOME = '/elsewhere-data';
  process.env.XDG_CONFIG_HOME = '/elsewhere-config';
  try {
    assert.equal(defaultDataDir({ platform: 'linux', home: '/home/placeholder' }), '/home/placeholder/.local/share/modeldeck');
    assert.equal(defaultSecretsDir({ home: '/home/placeholder' }), '/home/placeholder/.config/modeldeck');
  } finally {
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
  }
});
