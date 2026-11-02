import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG_LINT_RULES, evaluateConfigLint } from '../src/config-linter.mjs';
import { parseUsageQueueRetention } from '../src/config-linter-snapshot.mjs';
import { USAGE_QUEUE_CONSUMER_INTERVAL_MS } from '../src/usage-queue-consumer.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/config-linter/', import.meta.url));
const readFixture = (name) => JSON.parse(fs.readFileSync(`${fixtures}${name}.json`, 'utf8'));
const expectedSeverities = new Map([
  ['MD-L01', 'error'],
  ['MD-L02', 'error'],
  ['MD-L03', 'warn'],
  ['MD-L04', 'error'],
  ['MD-L05', 'error'],
  ['MD-L06', 'warn'],
  ['MD-L07', 'error'],
  ['MD-L08', 'warn'],
  ['MD-L09', 'error'],
  ['MD-L10', 'warn'],
  ['MD-L11', 'info'],
  ['MD-L12', 'error'],
  ['MD-L13', 'warn'],
  ['MD-L14', 'warn'],
  ['MD-L15', 'warn'],
  ['MD-L17', 'warn'],
]);

test('registry carries all required fields for MD-L01 through MD-L17 (MD-L16 reserved for #585)', () => {
  assert.deepEqual(CONFIG_LINT_RULES.map((rule) => rule.id), [...expectedSeverities.keys()]);
  for (const rule of CONFIG_LINT_RULES) {
    assert.equal(typeof rule.predicate, 'function', rule.id);
    assert.ok(rule.incidentSource, rule.id);
    assert.ok(rule.verifiedAgainstCliVersions && typeof rule.verifiedAgainstCliVersions === 'object', rule.id);
    assert.ok(rule.suggestedFix, rule.id);
    assert.equal(rule.severity, expectedSeverities.get(rule.id), rule.id);
  }
  assert.match(CONFIG_LINT_RULES.find((rule) => rule.id === 'MD-L11').provenanceNote, /demoted.*info.*forbid.*spawn/i);
});

test('every rule fires in the broken fixture estate', () => {
  const findings = evaluateConfigLint(readFixture('fire'));
  for (const [ruleId, severity] of expectedSeverities) {
    const matching = findings.filter((finding) => finding.ruleId === ruleId);
    assert.ok(matching.length > 0, `${ruleId} did not fire`);
    assert.ok(matching.some((finding) => (
      finding.severity === severity && !/could not evaluate/i.test(finding.message)
    )), `${ruleId} produced only could-not-evaluate output`);
  }
});

test('no rule fires in the clean fixture estate', () => {
  assert.deepEqual(evaluateConfigLint(readFixture('clean')), []);
});

test('every rule reports could-not-evaluate without an error in the unreadable fixture estate', () => {
  const findings = evaluateConfigLint(readFixture('unknown'));
  for (const ruleId of expectedSeverities.keys()) {
    const matching = findings.filter((finding) => finding.ruleId === ruleId);
    assert.ok(matching.length > 0, `${ruleId} silently skipped unreadable evidence`);
    assert.ok(matching.some((finding) => /could not evaluate/i.test(finding.message)), `${ruleId} message`);
    assert.ok(matching.every((finding) => finding.severity !== 'error'), `${ruleId} false error`);
  }
});

test('findings carry the complete JSON data model and stable rerun fingerprints', () => {
  const first = evaluateConfigLint(readFixture('fire'));
  const second = evaluateConfigLint(readFixture('fire'));
  assert.deepEqual(first.map((finding) => finding.fingerprint), second.map((finding) => finding.fingerprint));
  for (const finding of first) {
    assert.deepEqual(Object.keys(finding).sort(), [
      'evidence',
      'fingerprint',
      'message',
      'provenance',
      'ruleId',
      'scope',
      'severity',
      'suggestedFix',
    ]);
    assert.ok(Array.isArray(finding.evidence));
    assert.equal(finding.fingerprint.length, 64);
  }
});

test('managed-but-disabled profiles still bind activation and Codex pinning rules', () => {
  const snapshot = readFixture('clean');
  snapshot.accounts = snapshot.accounts.map((account) => ({ ...account, enabled: false }));
  snapshot.activation.claude.state = 'missing';
  snapshot.activation.codex.state = 'missing';
  snapshot.shell.zshenv.hasCodexBlock = false;
  const findings = evaluateConfigLint(snapshot);
  assert.deepEqual(
    findings.filter((finding) => finding.ruleId === 'MD-L04').map((finding) => finding.scope),
    ['machine:claude', 'machine:codex'],
  );
  assert.equal(findings.filter((finding) => finding.ruleId === 'MD-L05').length, 0);
  assert.equal(findings.filter((finding) => finding.ruleId === 'MD-L06').length, 1);
});

test('MD-L03 refuses to guess when the expected proxy origin is missing or invalid', () => {
  const cases = [
    { expected: undefined, observed: 'not-a-url' },
    { expected: 'not-a-url', observed: 'https://proxy-placeholder.example.invalid' },
  ];
  for (const input of cases) {
    const snapshot = readFixture('clean');
    snapshot.claudeProfiles[0].settings.value.env.ANTHROPIC_BASE_URL = input.observed;
    if (input.expected === undefined) delete snapshot.proxy.expectedOrigin;
    else snapshot.proxy.expectedOrigin = input.expected;

    const findings = evaluateConfigLint(snapshot).filter((finding) => finding.ruleId === 'MD-L03');
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /could not evaluate/i);
    assert.ok(findings[0].evidence.some((item) => /expected proxy origin.*missing or invalid/i.test(item.reason || '')));
  }
});

test('a missing Claude activation link produces MD-L04 without a duplicate MD-L05 row', () => {
  const snapshot = readFixture('clean');
  snapshot.activation.claude.state = 'missing';

  const findings = evaluateConfigLint(snapshot).filter((finding) => (
    finding.scope === 'machine:claude' || finding.scope === 'machine:claude-shell'
  ));
  assert.deepEqual(findings.map((finding) => finding.ruleId), ['MD-L04']);
});

test('absent unused profile roots and zero-weight unclaimed auth files do not invent drift', () => {
  const snapshot = readFixture('clean');
  snapshot.accounts = [];
  snapshot.claudeProfiles = [];
  snapshot.codexProfiles = [];
  snapshot.profileRoots.claude = { status: 'ok', path: '/fixture/missing-claude', exists: false, isDirectory: false };
  snapshot.profileRoots.codex = { status: 'ok', path: '/fixture/missing-codex', exists: false, isDirectory: false };
  snapshot.proxy.authFiles.files.push({
    path: '/fixture/proxy/auth/retired-zero.json',
    provider: 'claude',
    identity: 'retired-zero@example.invalid',
    weight: 0,
    claimedAccountId: null,
  });
  const findings = evaluateConfigLint(snapshot);
  assert.equal(findings.some((finding) => finding.ruleId === 'MD-L08'), false);
  assert.equal(findings.some((finding) => finding.ruleId === 'MD-L13'), false);
});

test('spawn-failed launchd state without an exit verdict is could-not-evaluate', () => {
  const snapshot = readFixture('clean');
  snapshot.launchd.daemon = {
    status: 'ok',
    label: 'ai.hermes.modeldeck',
    state: 'spawn-failed',
    lastExitCode: null,
    needsLwcrUpdate: false,
  };
  const findings = evaluateConfigLint(snapshot).filter((finding) => finding.ruleId === 'MD-L12');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /could not evaluate/i);
  assert.notEqual(findings[0].severity, 'error');
});

test('newer CLI versions make version-stamped behavior unverified instead of asserted', () => {
  const snapshot = readFixture('fire');
  snapshot.installedCliVersions.claude.version = '99.0.0';
  const findings = evaluateConfigLint(snapshot);
  for (const ruleId of ['MD-L01', 'MD-L02', 'MD-L03', 'MD-L05', 'MD-L11']) {
    const matching = findings.filter((finding) => finding.ruleId === ruleId);
    assert.ok(matching.length > 0, ruleId);
    assert.ok(matching.every((finding) => /newer than this rule.*verified/i.test(finding.message)), ruleId);
    assert.ok(matching.every((finding) => finding.severity !== 'error'), ruleId);
  }
  const claudeDuplicates = findings.filter((finding) => (
    finding.ruleId === 'MD-L07' && finding.evidence.some((entry) => entry.source === 'daemon weekly-reset fingerprints')
  ));
  assert.ok(claudeDuplicates.length > 0);
  assert.ok(claudeDuplicates.every((finding) => /newer than this rule.*verified/i.test(finding.message)));
  assert.ok(claudeDuplicates.every((finding) => finding.severity !== 'error'));
});

test('malformed daemon CLI version facts cannot turn version-gated rules into errors', () => {
  const snapshot = readFixture('clean');
  snapshot.installedCliVersions.claude.version = 'garbage-version';
  snapshot.claudeProfiles[0].settings.value.apiKeyHelper = true;

  const finding = evaluateConfigLint(snapshot).find((item) => item.ruleId === 'MD-L01');
  assert.match(finding?.message || '', /could not evaluate/i);
  assert.notEqual(finding?.severity, 'error');
});

// Issue #785: the proxy drops usage records unread longer than its retention
// (absent or <= 0 means 60, capped at 3600); the daemon pulls every 5 minutes.
test('MD-L17 reads the retention the way the proxy does', () => {
  const cases = [
    ['host: "127.0.0.1"\n', { seconds: 60, source: 'default' }],
    ['redis-usage-queue-retention-seconds: 3600\n', { seconds: 3600, source: 'config' }],
    ['redis-usage-queue-retention-seconds: 3600 # an hour\r\n', { seconds: 3600, source: 'config' }],
    ['redis-usage-queue-retention-seconds: 0\n', { seconds: 60, source: 'config' }],
    ['redis-usage-queue-retention-seconds: -5\n', { seconds: 60, source: 'config' }],
    ['redis-usage-queue-retention-seconds: 7200\n', { seconds: 3600, source: 'config' }],
    ['nested:\n  redis-usage-queue-retention-seconds: 3600\n', { seconds: 60, source: 'default' }],
    ['redis-usage-queue-retention-seconds: "3600"\n', null],
    ['redis-usage-queue-retention-seconds:\n', null],
    ['redis-usage-queue-retention-seconds: 600\nredis-usage-queue-retention-seconds: 3600\n', null],
    ['redis-usage-queue-retention-seconds: 0600\n', null],
    ['"redis-usage-queue-retention-seconds": 3600\n', { seconds: 3600, source: 'config' }],
    // Proxy v8 layout: the nested spelling wins over the top-level one.
    ['config-version: 8\nobservability:\n  logs:\n    debug: false\n  usage:\n    usage-statistics-enabled: true\n    redis-usage-queue-retention-seconds: 3600\n', { seconds: 3600, source: 'config' }],
    ['redis-usage-queue-retention-seconds: 3600\nobservability:\n  usage:\n    redis-usage-queue-retention-seconds: 60 # example default\n', { seconds: 60, source: 'config' }],
    ['observability:\n  usage:\n    usage-statistics-enabled: true\nredis-usage-queue-retention-seconds: 3600\n', { seconds: 3600, source: 'config' }],
    ['observability:\n  other:\n    redis-usage-queue-retention-seconds: 3600\n', { seconds: 60, source: 'default' }],
    ['observability: { usage: { redis-usage-queue-retention-seconds: 60 } }\nredis-usage-queue-retention-seconds: 3600\n', null],
    // Anchors, aliases and merge keys are beyond this line reader (CodeRabbit, #803).
    ['observability: &obs\n  usage:\n    redis-usage-queue-retention-seconds: 60\nredis-usage-queue-retention-seconds: 3600\n', null],
    ['defaults: &d\n  redis-usage-queue-retention-seconds: 60\nobservability: *d\nredis-usage-queue-retention-seconds: 3600\n', null],
    ['observability:\n  usage:\n    <<: *usage\nredis-usage-queue-retention-seconds: 3600\n', null],
    ['<<: *base\nhost: "127.0.0.1"\n', null],
    ['redis-usage-queue-retention-seconds: *ret\n', null],
    ['logging:\n  <<: *log\nredis-usage-queue-retention-seconds: 3600\n', { seconds: 3600, source: 'config' }],
  ];
  for (const [source, expected] of cases) assert.deepEqual(parseUsageQueueRetention(source), expected, source);
});

test('MD-L17 fires only when retention is under twice the pull interval on a consumer-on pool', () => {
  const pullSeconds = USAGE_QUEUE_CONSUMER_INTERVAL_MS / 1000;
  const lint = (usageQueue) => evaluateConfigLint({ ...readFixture('clean'), proxy: { ...readFixture('clean').proxy, usageQueue } })
    .filter((finding) => finding.ruleId === 'MD-L17');
  const on = { status: 'ok', consumerEnabled: true, path: '/fixture/proxy/config.yaml', retentionSource: 'config' };
  assert.equal(lint({ ...on, retentionSeconds: 2 * pullSeconds - 1 }).length, 1);
  assert.equal(lint({ ...on, retentionSeconds: 2 * pullSeconds }).length, 0);
  assert.equal(lint({ status: 'ok', consumerEnabled: false }).length, 0);
  assert.equal(lint({ status: 'remote' }).length, 0);
  const [finding] = lint({ ...on, retentionSeconds: 60, retentionSource: 'default' });
  assert.equal(finding.severity, 'warn');
  assert.deepEqual(finding.evidence, [{
    path: '/fixture/proxy/config.yaml', retentionSeconds: 60, retentionSource: 'default', pullIntervalSeconds: pullSeconds,
  }]);
});

// Tripwire: every config ModelDeck writes or tells Tim to write must keep
// records for at least two of the daemon's pull intervals.
test('every retention ModelDeck writes outlasts the usage-queue pull interval', () => {
  const pullSeconds = USAGE_QUEUE_CONSUMER_INTERVAL_MS / 1000;
  const sources = [
    'macos/ModelDeckMac/Sources/ModelDeckMacCore/ManagedProxyLive.swift',
    'docs/live-proxy-ops.md',
  ];
  for (const source of sources) {
    const text = fs.readFileSync(new URL(`../${source}`, import.meta.url), 'utf8');
    const values = [...text.matchAll(/redis-usage-queue-retention-seconds:\s*(\d+)/g)].map((match) => Number(match[1]));
    assert.ok(values.length > 0, `${source} sets no retention`);
    for (const value of values) assert.ok(value >= 2 * pullSeconds, `${source}: ${value} < ${2 * pullSeconds}`);
  }
});

test('MD-L06 points Linux at modeldeck launch, never the macOS-only shell installer', () => {
  const snapshot = readFixture('clean');
  snapshot.shell.zshenv.hasCodexBlock = false;
  const fix = (platform) => evaluateConfigLint({ ...snapshot, platform })
    .find((finding) => finding.ruleId === 'MD-L06').suggestedFix;
  assert.match(fix('darwin'), /install-shell-env\.sh/);
  assert.doesNotMatch(fix('linux'), /install-shell-env\.sh/);
  assert.match(fix('linux'), /modeldeck launch codex/);
});
