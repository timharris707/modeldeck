// Issue #705: signed history and release channels must survive publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as appcast from '../scripts/generate-appcast.mjs';
import * as checks from '../scripts/release-checks.mjs';

const item = (version, channel = null, floor = '1.0.0') => `\t<item>
 <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
 ${channel ? `<sparkle:channel>${channel}</sparkle:channel>` : ''}
 <modeldeck:rollbackFloor>${floor}</modeldeck:rollbackFloor>
 <description><![CDATA[notes with </item> and <sparkle:channel>fake</sparkle:channel>]]></description>
 <enclosure sparkle:edSignature="signature-${version}" length="123" />
</item>`;
const feed = (...items) => `<rss><channel>${items.join('\n')}</channel></rss>`;
const render = (options = {}) => appcast.renderAppcast({
  version: '1.2.0', build: '50', url: 'https://example.invalid/update.dmg',
  length: 123, signature: 'new-signature', pubDate: 'Sun, 20 Sep 2026 12:00:00 +0000',
  ...options,
});

test('merge preserves three older stables verbatim and every beta newer than newest stable', () => {
  const prior = ['1.1.10', '1.1.9', '1.1.8', '1.1.7'].map(v => item(v));
  const betas = [item('1.3.0-beta.9', 'beta'), item('1.3.0-beta.10', 'beta')];
  const xml = render({ existingXML: feed(prior[2], betas[0], prior[0], item('1.2.0-beta.1', 'beta'), prior[3], betas[1], prior[1]) });
  for (const raw of [...prior.slice(0, 3), ...betas]) assert.ok(xml.includes(raw.trimStart()));
  assert.ok(!xml.includes('signature-1.1.7'));
  assert.ok(!xml.includes('signature-1.2.0-beta.1'));
  assert.equal(appcast.appcastItems(xml)[0].version, '1.2.0');
  assert.equal(appcast.appcastItems(xml).length, 6);
});

test('beta writes channel and inherits latest stable floor; retains current stable plus three older', () => {
  const xml = render({ version: '1.3.0-beta.2', channel: 'beta', rollbackFloor: 'unchanged',
    existingXML: feed(item('1.0.0'), item('1.2.0', null, '1.1.0'), item('1.1.0'), item('1.0.1'), item('0.9.0'), item('1.3.0-beta.1', 'beta', '1.3.0-beta.1')) });
  assert.match(xml, /xmlns:modeldeck="https:\/\/modeldeck.ai\/appcast"/);
  const items = appcast.appcastItems(xml);
  assert.equal(items[0].channel, 'beta');
  assert.equal(items[0].rollbackFloor, '1.1.0');
  assert.equal(items.filter(i => i.channel === null).length, 4);
  assert.ok(items.some(i => i.version === '1.3.0-beta.1'));
});

test('floor defaults to own version without an inherited floor and explicit floor wins', () => {
  assert.equal(appcast.appcastItems(render())[0].rollbackFloor, '1.2.0');
  assert.equal(appcast.appcastItems(render({ rollbackFloor: '1.1.0' }))[0].rollbackFloor, '1.1.0');
  assert.equal(appcast.appcastItems(render({ existingXML: feed('<item><sparkle:shortVersionString>1.1.0</sparkle:shortVersionString></item>') }))[0].rollbackFloor, '1.2.0');
});

test('stable-only merge drops channels and duplicate new version', () => {
  const xml = render({ stableOnly: true, existingXML: feed(item('1.3.0-beta.1', 'beta'), item('1.2.0'), item('1.1.0')) });
  assert.deepEqual(appcast.appcastItems(xml).map(i => i.version), ['1.2.0', '1.1.0']);
});

test('release channel checks reject version/flag mismatches, channel items in stable, and schema notes without a floor', async () => {
  const checks = await import('../scripts/release-checks.mjs');
  const validate = checks.validateReleaseChannel;
  assert.throws(() => validate({ version: '1.2.0-beta.1' }), /--beta/);
  assert.throws(() => validate({ version: '1.2.0', beta: true }), /prerelease/);
  assert.throws(() => validate({ version: '1.2.0', stableAppcast: feed(item('1.3.0-beta.1', 'beta')) }), /stable.*channel/i);
  assert.throws(() => validate({ version: '1.2.0', notes: 'Changed the SCHEMA.' }), /Rollback floor/);
  assert.doesNotThrow(() => validate({ version: '1.2.0', notes: 'Schema update\nRollback floor: unchanged' }));
  assert.doesNotThrow(() => validate({ version: '1.2.0-beta.1', beta: true }));
  assert.doesNotThrow(() => validate({ version: '1.2.0', stableAppcast: feed(item('1.2.0')) }));
});

function releaseFixture(t, version, notes = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-beta-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'docs/release-notes'), { recursive: true });
  fs.copyFileSync(new URL('../scripts/release-dmg.sh', import.meta.url), path.join(root, 'scripts/release-dmg.sh'));
  for (const name of ['generate-appcast.mjs', 'release-checks.mjs']) {
    fs.symlinkSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
  }
  fs.writeFileSync(path.join(root, `docs/release-notes/${version}.md`), notes);
  const dmg = path.join(root, `ModelDeck-${version}.dmg`);
  fs.writeFileSync(dmg, 'fake dmg');
  const signer = path.join(root, 'sign_update');
  fs.writeFileSync(signer, '#!/bin/sh\nprintf \'sparkle:edSignature="fake" length="8"\\n\'\n', { mode: 0o755 });
  const run = (...args) => spawnSync('bash', [path.join(root, 'scripts/release-dmg.sh'), '--appcast-only', dmg, '--build', '705', ...args], {
    encoding: 'utf8', env: { ...process.env, MD_SPARKLE_SIGN_UPDATE: signer },
  });
  return { root, run };
}

test('stable release generates both feeds from their own history, with floor from notes', t => {
  const { root, run } = releaseFixture(t, '1.2.0', 'Schema-compatible change\nRollback floor: 1.1.0\n');
  const stablePath = path.join(root, 'previous-stable.xml'), betaPath = path.join(root, 'previous-beta.xml');
  fs.writeFileSync(stablePath, feed(item('1.1.15')));
  fs.writeFileSync(betaPath, feed(item('1.1.15'), item('1.3.0-beta.1', 'beta')));
  const result = run('--merge-existing-stable', stablePath, '--merge-existing-beta', betaPath);
  assert.equal(result.status, 0, result.stderr);
  const stable = appcast.appcastItems(fs.readFileSync(path.join(root, 'appcast.xml'), 'utf8'));
  const beta = appcast.appcastItems(fs.readFileSync(path.join(root, 'appcast-beta.xml'), 'utf8'));
  assert.deepEqual(stable.map(i => i.version), ['1.2.0', '1.1.15']);
  assert.deepEqual(beta.map(i => i.version), ['1.2.0', '1.3.0-beta.1', '1.1.15']);
  assert.equal(stable[0].rollbackFloor, '1.1.0');
  assert.equal(beta[0].rollbackFloor, '1.1.0');
});

test('beta release writes only beta feed and requires the beta flag', t => {
  const { root, run } = releaseFixture(t, '1.2.0-beta.2');
  const prior = path.join(root, 'prior.xml');
  fs.writeFileSync(prior, feed(item('1.1.15', null, '1.1.0'), item('1.2.0-beta.1', 'beta')));
  assert.notEqual(run('--first-feeds').status, 0, 'a prerelease version without --beta is refused');
  const result = run('--beta', '--merge-existing-beta', prior);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'appcast.xml')), false);
  const items = appcast.appcastItems(fs.readFileSync(path.join(root, 'appcast-beta.xml'), 'utf8'));
  assert.equal(items[0].channel, 'beta');
  assert.equal(items[0].rollbackFloor, '1.1.0');
  assert.equal(items.length, 3);
});

test('stable release rejects --beta and schema notes without floor before signing', t => {
  const { run } = releaseFixture(t, '1.2.0', 'A new schema');
  assert.match(run('--beta', '--first-feeds').stderr, /prerelease/);
  assert.match(run('--first-feeds').stderr, /Rollback floor/);
});

test('beta bundle stamping keeps numeric Apple version and full display version', t => {
  const { root } = releaseFixture(t, '1.2.0-beta.1');
  fs.mkdirSync(path.join(root, 'Contents'));
  const plist = path.join(root, 'Contents/Info.plist');
  fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.0</string><key>CFBundleVersion</key><string>0</string></dict></plist>');
  const source = fs.readFileSync(new URL('../scripts/release-dmg.sh', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('echo "==> stamping version'), source.indexOf('# Issue #121: Sparkle. Embed'));
  const result = spawnSync('bash', ['-eu', '-c', section], { encoding: 'utf8', env: {
    ...process.env, APP: root, VERSION: '1.2.0-beta.1', BUILD_NUMBER: '705', GIT_COMMIT: 'fixture',
  } });
  assert.equal(result.status, 0, result.stderr);
  const read = key => spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).stdout.trim();
  assert.equal(read('CFBundleShortVersionString'), '1.2.0');
  assert.equal(read('CFBundleVersion'), '705');
  assert.equal(read('ModelDeckDisplayVersion'), '1.2.0-beta.1');
});

// Issue #705 (Astra review of PR #710): a release without the prior feeds
// silently published one-item feeds and dropped the rollback history.
test('TRIPWIRE #705: a stable release refuses to write feeds without BOTH prior feeds', t => {
  const { root, run } = releaseFixture(t, '1.2.0');
  const stablePath = path.join(root, 'previous-stable.xml');
  fs.writeFileSync(stablePath, feed(item('1.1.15')));
  const none = run();
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /--merge-existing-stable .* is required/);
  assert.equal(fs.existsSync(path.join(root, 'appcast.xml')), false, 'no feed may be written');
  const onlyStable = run('--merge-existing-stable', stablePath);
  assert.notEqual(onlyStable.status, 0);
  assert.match(onlyStable.stderr, /--merge-existing-beta .* is required/);
  assert.equal(fs.existsSync(path.join(root, 'appcast.xml')), false);
});

test('TRIPWIRE #705: --first-feeds is the only way to publish without history, and never together with a prior feed', t => {
  const { root, run } = releaseFixture(t, '1.2.0');
  const both = run('--first-feeds', '--merge-existing-stable', path.join(root, 'x.xml'));
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /mutually exclusive/);
  const bootstrap = run('--first-feeds');
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /WARNING: --first-feeds/);
  const stable = appcast.appcastItems(fs.readFileSync(path.join(root, 'appcast.xml'), 'utf8'));
  assert.deepEqual(stable.map(i => i.version), ['1.2.0']);
});

test('a beta release needs only the prior beta feed', t => {
  const { root, run } = releaseFixture(t, '1.2.0-beta.2');
  const prior = path.join(root, 'prior.xml');
  fs.writeFileSync(prior, feed(item('1.1.15', null, '1.1.0'), item('1.2.0-beta.1', 'beta')));
  const missing = run('--beta');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--merge-existing-beta .* is required/);
  assert.equal(run('--beta', '--merge-existing-beta', prior).status, 0);
});

// CodeRabbit (PR #710): one strict version validator, unusable prior feeds
// refused, and beta mode admitting only untagged and "beta" items.
test('TRIPWIRE #705: release versions and floors must be strict SemVer everywhere', () => {
  const bad = ['01.2.3', '1.2.3-01', '1.2.3--beta', '1.2.3-beta..1', '1.2.3.foo', '1.2', 'v1.2.3'];
  const good = ['1.2.3', '1.2.3-beta.1', '1.2.3-beta.10', '1.2.3-rc.1', '0.0.0'];
  for (const v of bad) assert.equal(appcast.isStrictVersion(v), false, v);
  for (const v of good) assert.equal(appcast.isStrictVersion(v), true, v);
  for (const v of bad) assert.throws(() => checks.validateReleaseChannel({ version: v, beta: v.includes('-') }), new RegExp('invalid release VERSION'), v);
  assert.throws(() => checks.validateReleaseChannel({ version: '1.2.3', notes: 'Rollback floor: 01.0.0\n' }), /invalid Rollback floor line/);
  assert.throws(() => appcast.parseArgs(['--version', '01.2.3', '--build', '1', '--dmg', 'x', '--url', 'u', '--sign-update', 's', '--out', 'o']), /invalid --version/);
  assert.throws(() => appcast.parseArgs(['--version', '1.2.3', '--rollback-floor', '1.2', '--build', '1', '--dmg', 'x', '--url', 'u', '--sign-update', 's', '--out', 'o']), /invalid --rollback-floor/);
});

test('TRIPWIRE #705: an empty or item-less prior feed is refused before any feed is written', t => {
  const { root, run } = releaseFixture(t, '1.2.0');
  const stablePath = path.join(root, 'previous-stable.xml'), betaPath = path.join(root, 'previous-beta.xml');
  fs.writeFileSync(stablePath, feed(item('1.1.15')));
  fs.writeFileSync(betaPath, '');
  const empty = run('--merge-existing-stable', stablePath, '--merge-existing-beta', betaPath);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /prior feed has no versioned items/);
  assert.equal(fs.existsSync(path.join(root, 'appcast-beta.xml')), false, 'no beta feed may be written');
  fs.writeFileSync(betaPath, feed());
  const itemless = run('--merge-existing-stable', stablePath, '--merge-existing-beta', betaPath);
  assert.notEqual(itemless.status, 0);
  assert.match(itemless.stderr, /prior feed has no versioned items/);
});

test('release-checks refuses an option with no value instead of using the repo default', () => {
  const script = new URL('../scripts/release-checks.mjs', import.meta.url).pathname;
  for (const flag of ['--version', '--notes', '--stable-appcast']) {
    const result = spawnSync(process.execPath, [script, '--channel-only', flag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, new RegExp(`${flag} requires a value`));
  }
});
