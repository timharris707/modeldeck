import crypto from 'node:crypto';
import { USAGE_QUEUE_CONSUMER_INTERVAL_MS } from './usage-queue-consumer.mjs';

const COULD_NOT_EVALUATE_SEVERITY = Object.freeze({ error: 'warn', warn: 'warn', info: 'info' });

function normalizedSemver(value) {
  return String(value || '').match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1] || null;
}

function compareSemver(left, right) {
  const parse = (value) => value.split('-', 1)[0].split('.').map(Number);
  const a = parse(normalizedSemver(left));
  const b = parse(normalizedSemver(right));
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function fingerprint(finding) {
  const stable = JSON.stringify({
    ruleId: finding.ruleId,
    severity: finding.severity,
    scope: finding.scope,
    message: finding.message,
    evidence: finding.evidence,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function finding(rule, input) {
  const value = {
    ruleId: rule.id,
    severity: input.severity || rule.severity,
    scope: input.scope,
    message: input.message,
    evidence: input.evidence || [],
    suggestedFix: input.suggestedFix || rule.suggestedFix,
    provenance: {
      incidentSource: rule.incidentSource,
      verifiedAgainstCliVersions: rule.verifiedAgainstCliVersions,
      ...(rule.provenanceNote ? { note: rule.provenanceNote } : {}),
    },
  };
  return { ...value, fingerprint: fingerprint(value) };
}

function couldNotEvaluate(rule, scope, evidence) {
  return finding(rule, {
    severity: COULD_NOT_EVALUATE_SEVERITY[rule.severity],
    scope,
    message: `Could not evaluate ${rule.id}: required evidence was unavailable.`,
    evidence: Array.isArray(evidence) ? evidence : [{ reason: evidence || 'unknown' }],
  });
}

function unavailableEvidence(input, fallbackPath) {
  return [
    ...(input?.path || fallbackPath ? [{ path: input?.path || fallbackPath }] : []),
    { observed: 'could-not-evaluate', reason: input?.reason || 'required evidence was unavailable' },
  ];
}

function versionCheck(rule, snapshot, provider, scope, evidence) {
  const verified = rule.verifiedAgainstCliVersions[provider] || [];
  if (!verified.length) return null;
  const installed = snapshot.installedCliVersions?.[provider];
  if (installed?.status !== 'ok' || !installed.version) {
    return couldNotEvaluate(rule, scope, [
      ...evidence,
      { provider, installedVersion: 'unknown', reason: installed?.reason || 'daemon version fact unavailable' },
    ]);
  }
  const installedVersion = normalizedSemver(installed.version);
  if (!installedVersion) {
    return couldNotEvaluate(rule, scope, [
      ...evidence,
      { provider, installedVersion: 'invalid', reason: 'daemon version fact is not a semantic version' },
    ]);
  }
  const newestVerified = [...verified].sort(compareSemver).at(-1);
  if (compareSemver(installedVersion, newestVerified) <= 0) return null;
  return finding(rule, {
    severity: COULD_NOT_EVALUATE_SEVERITY[rule.severity],
    scope,
    message: `Could not evaluate ${rule.id}: the installed ${provider} CLI is newer than this rule's verified behavior.`,
    evidence: [
      ...evidence,
      { provider, installedVersion, newestVerifiedVersion: newestVerified },
    ],
  });
}

function profileScope(profile) {
  return profile.accountId ? `profile:${profile.accountId}` : `path:${profile.path}`;
}

function settingsValue(profile, rule) {
  if (profile.settings?.status === 'ok') return { value: profile.settings.value || {} };
  return {
    finding: couldNotEvaluate(rule, profileScope(profile), unavailableEvidence(profile.settings, `${profile.path}/settings.json`)),
  };
}

function mdL01(snapshot, rule) {
  const findings = [];
  for (const profile of snapshot.claudeProfiles || []) {
    const settings = settingsValue(profile, rule);
    if (settings.finding) findings.push(settings.finding);
    else if (Object.hasOwn(settings.value, 'apiKeyHelper')) {
      const evidence = [{ path: profile.settings.path, property: 'apiKeyHelper', observed: 'present' }];
      findings.push(versionCheck(rule, snapshot, 'claude', profileScope(profile), evidence) || finding(rule, {
        scope: profileScope(profile),
        message: 'apiKeyHelper is present and prevents ModelDeck from reading this profile identity during renewal.',
        evidence,
      }));
    }
  }
  return findings;
}

function mdL02(snapshot, rule) {
  const findings = [];
  for (const profile of snapshot.claudeProfiles || []) {
    const settings = settingsValue(profile, rule);
    if (settings.finding) {
      findings.push(settings.finding);
      continue;
    }
    const env = settings.value.env && typeof settings.value.env === 'object' && !Array.isArray(settings.value.env)
      ? settings.value.env
      : {};
    const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((key) => Object.hasOwn(env, key));
    if (!keys.length) continue;
    const evidence = [{ path: profile.settings.path, properties: keys, observed: 'present' }];
    findings.push(versionCheck(rule, snapshot, 'claude', profileScope(profile), evidence) || finding(rule, {
      scope: profileScope(profile),
      message: 'A profile settings file overrides the managed Claude sign-in with an API credential.',
      evidence,
    }));
  }
  return findings;
}

function normalizedOrigin(value) {
  try { return new URL(value).origin; }
  catch { return null; }
}

function mdL03(snapshot, rule) {
  const findings = [];
  for (const profile of snapshot.claudeProfiles || []) {
    const settings = settingsValue(profile, rule);
    if (settings.finding) {
      findings.push(settings.finding);
      continue;
    }
    const env = settings.value.env && typeof settings.value.env === 'object' && !Array.isArray(settings.value.env)
      ? settings.value.env
      : {};
    if (!Object.hasOwn(env, 'ANTHROPIC_BASE_URL')) continue;
    const observed = env.ANTHROPIC_BASE_URL;
    const expected = snapshot.proxy?.expectedOrigin;
    const expectedOrigin = normalizedOrigin(expected);
    if (!expectedOrigin) {
      findings.push(couldNotEvaluate(rule, profileScope(profile), [
        { path: profile.settings.path, property: 'ANTHROPIC_BASE_URL', observed },
        { expectedProxyOrigin: 'unavailable', reason: 'expected proxy origin is missing or invalid' },
      ]));
      continue;
    }
    const wrongOrigin = normalizedOrigin(observed) !== expectedOrigin;
    // A remote-role client routes through its forwarder; pool membership is
    // the host's to check.
    if (!wrongOrigin && snapshot.proxy?.roster?.status === 'remote') continue;
    if (!wrongOrigin && snapshot.proxy?.roster?.status !== 'ok') {
      findings.push(couldNotEvaluate(rule, profileScope(profile), [
        { path: profile.settings.path, property: 'ANTHROPIC_BASE_URL', observed },
        ...unavailableEvidence(snapshot.proxy?.roster),
      ]));
      continue;
    }
    const outsideRoster = !wrongOrigin && !snapshot.proxy.roster.accountIds.includes(profile.accountId);
    if (!wrongOrigin && !outsideRoster) continue;
    const evidence = [
      { path: profile.settings.path, property: 'ANTHROPIC_BASE_URL', observed },
      { expectedProxyOrigin: expected },
      ...(outsideRoster ? [{ proxyRoster: 'profile-not-registered' }] : []),
    ];
    findings.push(versionCheck(rule, snapshot, 'claude', profileScope(profile), evidence) || finding(rule, {
      scope: profileScope(profile),
      message: wrongOrigin
        ? 'ANTHROPIC_BASE_URL points somewhere other than ModelDeck’s expected proxy.'
        : 'This profile points at the proxy, but the proxy roster does not know the profile.',
      evidence,
    }));
  }
  return findings;
}

function mdL04(snapshot, rule) {
  const findings = [];
  for (const provider of ['claude', 'codex']) {
    const accounts = snapshot.accounts.filter((account) => account.provider === provider);
    if (!accounts.length) continue;
    const activation = snapshot.activation?.[provider];
    const scope = `machine:${provider}`;
    if (!activation || activation.state === 'unknown') {
      findings.push(couldNotEvaluate(rule, scope, unavailableEvidence(activation)));
      continue;
    }
    if (activation.state === 'ok') continue;
    const label = provider === 'claude' ? 'Claude' : 'Codex';
    findings.push(finding(rule, {
      scope,
      message: `${label} activation is not linked to a managed profile.`,
      evidence: [
        { path: activation.path, observed: activation.state },
        ...(activation.target ? [{ target: activation.target }] : []),
        { managedProfilesDir: activation.profilesDir },
      ],
    }));
  }
  return findings;
}

function mdL05(snapshot, rule) {
  if (!snapshot.accounts.some((account) => account.provider === 'claude')) return [];
  const zshenv = snapshot.shell?.zshenv;
  const env = snapshot.shell?.claudeEnv;
  const activation = snapshot.activation?.claude;
  if (activation && activation.state !== 'ok' && activation.state !== 'unknown') return [];
  const unavailable = [zshenv, env].filter((input) => input?.status !== 'ok');
  if (!activation || activation.state === 'unknown') unavailable.push(activation);
  if (unavailable.length) {
    return [couldNotEvaluate(rule, 'machine:claude-shell', unavailable.flatMap((input) => unavailableEvidence(input)))];
  }
  const defects = [];
  if (!zshenv.hasClaudeBlock) defects.push({ path: zshenv.path, observed: 'generated-Claude-block-missing' });
  if (env.configDir !== env.secureStorageConfigDir) {
    defects.push({ path: env.path, configDir: env.configDir, secureStorageConfigDir: env.secureStorageConfigDir });
  }
  if (activation.state !== 'ok') {
    defects.push({ path: activation.path, observed: activation.state });
  } else if (env.configDir !== activation.target || env.secureStorageConfigDir !== activation.target) {
    defects.push({ path: env.path, activeProfile: activation.target, pinnedConfigDir: env.configDir, pinnedSecureStorageConfigDir: env.secureStorageConfigDir });
  }
  if (!defects.length) return [];
  const gated = versionCheck(rule, snapshot, 'claude', 'machine:claude-shell', defects);
  return [gated || finding(rule, {
    scope: 'machine:claude-shell',
    message: 'Claude shell pinning is missing, stale, or split across two profile homes.',
    evidence: defects,
  })];
}

function mdL06(snapshot, rule) {
  const profiles = (snapshot.codexProfiles || []).filter((profile) => (
    profile.home?.status === 'ok'
      && profile.home.exists !== false
      && profile.home.isDirectory
      && !profile.home.isSymbolicLink
  ));
  if (profiles.length < 2) {
    const discovery = snapshot.profileDiscovery?.codex;
    const unavailableHomes = (snapshot.codexProfiles || []).filter((profile) => profile.home?.status !== 'ok');
    if ((discovery?.status && discovery.status !== 'ok') || unavailableHomes.length) {
      return [couldNotEvaluate(rule, 'machine:codex-shell', [
        ...(discovery?.status && discovery.status !== 'ok' ? unavailableEvidence(discovery) : []),
        ...unavailableHomes.flatMap((profile) => unavailableEvidence(profile.home, profile.path)),
      ])];
    }
    return [];
  }
  const zshenv = snapshot.shell?.zshenv;
  if (zshenv?.status !== 'ok') return [couldNotEvaluate(rule, 'machine:codex-shell', unavailableEvidence(zshenv))];
  if (zshenv.hasCodexBlock) return [];
  return [finding(rule, {
    scope: 'machine:codex-shell',
    message: 'Multiple Codex homes exist, but the shell does not pin CODEX_HOME.',
    // install-shell-env.sh is macOS-only; elsewhere launch sets CODEX_HOME per session.
    ...((snapshot.platform ?? process.platform) === 'darwin' ? {} : {
      suggestedFix: 'Start Codex with `modeldeck launch codex`, which sets CODEX_HOME for that session.',
    }),
    evidence: [
      { path: zshenv.path, observed: 'generated-Codex-block-missing' },
      { managedCodexHomes: profiles.map((profile) => profile.path).sort() },
    ],
  })];
}

function mdL07(snapshot, rule) {
  const findings = [];
  const claudeDuplicates = snapshot.daemonFacts?.duplicateClaudeAccountIds;
  if (claudeDuplicates?.status !== 'ok') {
    findings.push(couldNotEvaluate(rule, 'machine:claude-duplicates', unavailableEvidence(claudeDuplicates)));
  } else {
    const ids = [...new Set(claudeDuplicates.value || [])].sort();
    for (const accountId of ids) {
      const evidence = [{ duplicateAccountIds: ids, source: 'daemon weekly-reset fingerprints' }];
      findings.push(versionCheck(rule, snapshot, 'claude', `profile:${accountId}`, evidence) || finding(rule, {
        scope: `profile:${accountId}`,
        message: 'This Claude profile shares a weekly reset fingerprint with another managed profile.',
        evidence,
      }));
    }
  }

  const groups = new Map();
  for (const profile of snapshot.codexProfiles || []) {
    const identifier = profile.authAccountId;
    if (identifier?.status !== 'ok' || !identifier.value) {
      findings.push(couldNotEvaluate(rule, profileScope(profile), unavailableEvidence(identifier, `${profile.path}/auth.json`)));
      continue;
    }
    const group = groups.get(identifier.value) || [];
    group.push(profile);
    groups.set(identifier.value, group);
  }
  for (const [accountIdentifier, profiles] of groups) {
    if (profiles.length < 2) continue;
    const ids = profiles.map((profile) => profile.accountId).filter(Boolean).sort();
    const scopes = profiles.map(profileScope).sort();
    for (const profile of profiles) {
      findings.push(finding(rule, {
        scope: profileScope(profile),
        message: 'This Codex home carries the same account identifier as another managed home.',
        evidence: [{
          path: profile.authAccountId.path,
          accountIdentifier,
          ...(ids.length === profiles.length ? { duplicateAccountIds: ids } : { duplicateScopes: scopes }),
        }],
      }));
    }
  }
  return findings;
}

function modeEvidence(input) {
  return {
    path: input.path,
    mode: Number.isInteger(input.mode) ? `0${input.mode.toString(8)}` : 'unknown',
    ownedByCurrentUser: input.ownedByCurrentUser,
    isDirectory: input.isDirectory,
  };
}

function mdL08(snapshot, rule) {
  const findings = [];
  const inputs = [
    ...Object.values(snapshot.profileRoots || {}).map((root) => ({ input: root, scope: `path:${root.path}` })),
    ...(snapshot.claudeProfiles || []).map((profile) => ({ input: profile.home, scope: profileScope(profile) })),
    ...(snapshot.codexProfiles || []).map((profile) => ({ input: profile.home, scope: profileScope(profile) })),
  ];
  for (const { input, scope } of inputs) {
    if (input?.status === 'ok' && input.exists === false) continue;
    if (input?.status !== 'ok') {
      findings.push(couldNotEvaluate(rule, scope, unavailableEvidence(input)));
      continue;
    }
    if (input.isDirectory && input.ownedByCurrentUser && (input.mode & 0o077) === 0) continue;
    findings.push(finding(rule, {
      scope,
      message: 'A managed profiles directory is not owner-only or has the wrong owner.',
      evidence: [modeEvidence(input)],
    }));
  }
  const codexDiscovery = snapshot.profileDiscovery?.codex;
  if (codexDiscovery?.status && codexDiscovery.status !== 'ok'
    && snapshot.profileRoots?.codex?.status === 'ok') {
    findings.push(couldNotEvaluate(rule, `path:${codexDiscovery.path}`, unavailableEvidence(codexDiscovery)));
  }
  return findings;
}

function mdL09(snapshot, rule) {
  const findings = [];
  for (const profile of snapshot.claudeProfiles || []) {
    const document = profile.claudeJson;
    if (document?.status === 'missing') continue;
    if (document?.status === 'unknown') {
      findings.push(couldNotEvaluate(rule, profileScope(profile), unavailableEvidence(document)));
      continue;
    }
    if (document?.status === 'ok' && document.kind === 'object' && document.regularFile) continue;
    findings.push(finding(rule, {
      scope: profileScope(profile),
      message: '.claude.json is invalid, is not an object, or is not a regular file.',
      evidence: [{ path: document?.path, observed: document?.reason || document?.kind || 'not-regular-file' }],
    }));
  }
  return findings;
}

function mdL10(snapshot, rule) {
  const findings = [];
  const shared = snapshot.sharedScope || {};
  if (shared.enabled) {
    for (const profile of snapshot.claudeProfiles || []) {
      const memory = profile.memory;
      if (memory?.status !== 'ok') {
        findings.push(couldNotEvaluate(rule, profileScope(profile), unavailableEvidence(memory)));
      } else if (memory.kind === 'symlink' && memory.target !== shared.sharedMemoryDir) {
        findings.push(finding(rule, {
          scope: profileScope(profile),
          message: 'A managed profile memory link points outside the shared memory directory.',
          evidence: [{ path: memory.path, target: memory.target, expectedTarget: shared.sharedMemoryDir }],
        }));
      }
    }
  }
  if (shared.consistency?.status !== 'ok') {
    findings.push(couldNotEvaluate(rule, 'machine:shared-scope', unavailableEvidence(shared.consistency)));
  } else if (shared.consistency.issues?.length) {
    findings.push(finding(rule, {
      scope: 'machine:shared-scope',
      message: 'Shared-scope backups and the manifest disagree.',
      evidence: shared.consistency.issues.map((issue) => ({ issue })),
    }));
  }
  return findings;
}

function mdL11(snapshot, rule) {
  const executables = snapshot.pathExecutables;
  if (executables?.status !== 'ok') {
    return [couldNotEvaluate(rule, 'machine:claude-path', unavailableEvidence(executables))];
  }
  const unique = [...new Map((executables.items || [])
    .map((item) => [item.realpath || item.path, item])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  if (unique.length < 2) return [];
  if (unique.some((item) => !item.version)) {
    return [couldNotEvaluate(rule, 'machine:claude-path', unique.map((item) => ({
      path: item.path,
      realpath: item.realpath,
      version: item.version || 'not available without spawning claude',
    })))];
  }
  const versions = [...new Set(unique.map((item) => item.version))];
  if (versions.length < 2) return [];
  const evidence = unique.map((item) => ({ path: item.path, realpath: item.realpath, version: item.version }));
  return [versionCheck(rule, snapshot, 'claude', 'machine:claude-path', evidence) || finding(rule, {
    scope: 'machine:claude-path',
    message: 'Different Claude CLI versions are reachable through the daemon PATH.',
    evidence,
  })];
}

function mdL12(snapshot, rule) {
  const daemon = snapshot.launchd?.daemon;
  if (daemon?.status !== 'ok') return [couldNotEvaluate(rule, 'machine:launchd', unavailableEvidence(daemon))];
  if (daemon.state !== 'spawn-failed') return [];
  if (!Number.isInteger(daemon.lastExitCode) && !daemon.needsLwcrUpdate) {
    return [couldNotEvaluate(rule, 'machine:launchd', [{
      label: daemon.label,
      state: daemon.state,
      lastExitCode: 'unknown',
      needsLwcrUpdate: false,
    }])];
  }
  if (daemon.lastExitCode !== 78 && !daemon.needsLwcrUpdate) return [];
  return [finding(rule, {
    scope: 'machine:launchd',
    message: 'launchd is refusing to spawn the ModelDeck daemon with a stale launch constraint.',
    evidence: [{ label: daemon.label, state: daemon.state, lastExitCode: daemon.lastExitCode, needsLwcrUpdate: daemon.needsLwcrUpdate }],
  })];
}

function mdL13(snapshot, rule) {
  const authFiles = snapshot.proxy?.authFiles;
  if (authFiles?.status === 'not-installed' || authFiles?.status === 'remote') return [];
  if (authFiles?.status !== 'ok') return [couldNotEvaluate(rule, 'machine:proxy-auth', unavailableEvidence(authFiles))];
  const unreadable = (authFiles.issues || []).map((issue) => couldNotEvaluate(
    rule,
    issue.path ? `path:${issue.path}` : 'machine:proxy-auth',
    unavailableEvidence(issue),
  ));
  const unclaimed = (authFiles.files || [])
    .filter((file) => Number.isInteger(file.weight) && file.weight > 0 && !file.claimedAccountId)
    .map((file) => finding(rule, {
      scope: `path:${file.path}`,
      message: 'A weighted proxy auth file is not claimed by any registered ModelDeck account.',
      evidence: [{ path: file.path, provider: file.provider, identity: file.identity, weight: file.weight }],
    }));
  return [...unreadable, ...unclaimed];
}

function mdL14(snapshot, rule) {
  if (snapshot.proxy?.managed === false) return [];
  if (snapshot.proxy?.managed == null) {
    return [couldNotEvaluate(rule, 'machine:proxy-management-key', [{ reason: 'managed proxy state unavailable' }])];
  }
  const key = snapshot.proxy.managementKey;
  if (key?.status !== 'ok') return [couldNotEvaluate(rule, 'machine:proxy-management-key', unavailableEvidence(key))];
  if (key.exists && (key.mode & 0o077) === 0) return [];
  return [finding(rule, {
    scope: 'machine:proxy-management-key',
    message: key.exists
      ? 'The proxy management key is readable by group or other users.'
      : 'The managed proxy has no management-key file.',
    evidence: [{ path: key.path, exists: key.exists, mode: Number.isInteger(key.mode) ? `0${key.mode.toString(8)}` : null }],
  })];
}

function mdL15(snapshot, rule) {
  const overrides = snapshot.runtimeOverrides;
  if (overrides?.status !== 'ok') return [couldNotEvaluate(rule, 'machine:daemon-environment', unavailableEvidence(overrides))];
  return (overrides.splits || []).map((split) => finding(rule, {
    scope: 'machine:daemon-environment',
    message: 'Running-daemon MODELDECK overrides split related data, configuration, or authentication paths across installs.',
    evidence: [split],
  }));
}

// Issue #785: the daemon pulls the usage queue every
// USAGE_QUEUE_CONSUMER_INTERVAL_MS, and the proxy drops what waits longer
// than its retention. Each pull takes one batch and the next timer starts
// after it finishes, so anything under two intervals can lose usage.
function mdL17(snapshot, rule) {
  const queue = snapshot.proxy?.usageQueue;
  if (queue?.status === 'remote' || (queue?.status === 'ok' && !queue.consumerEnabled)) return [];
  if (queue?.status !== 'ok') return [couldNotEvaluate(rule, 'machine:proxy-usage-queue', unavailableEvidence(queue))];
  const pullSeconds = USAGE_QUEUE_CONSUMER_INTERVAL_MS / 1000;
  if (queue.retentionSeconds >= 2 * pullSeconds) return [];
  return [finding(rule, {
    scope: 'machine:proxy-usage-queue',
    message: `The proxy keeps unread usage records for ${queue.retentionSeconds} seconds, less than twice ModelDeck's ${pullSeconds}-second read interval, so usage can be lost before it is read.`,
    evidence: [{
      path: queue.path,
      retentionSeconds: queue.retentionSeconds,
      retentionSource: queue.retentionSource,
      pullIntervalSeconds: pullSeconds,
    }],
  })];
}

function rule(input) {
  return Object.freeze({
    ...input,
    verifiedAgainstCliVersions: Object.freeze(input.verifiedAgainstCliVersions),
  });
}

export const CONFIG_LINT_RULES = Object.freeze([
  rule({
    id: 'MD-L01', predicate: mdL01, severity: 'error', incidentSource: '#263',
    verifiedAgainstCliVersions: { claude: Object.freeze(['2.1.223']) },
    suggestedFix: 'Remove apiKeyHelper from this managed profile, then run the profile verification again.',
  }),
  rule({
    id: 'MD-L02', predicate: mdL02, severity: 'error', incidentSource: '#224',
    verifiedAgainstCliVersions: { claude: Object.freeze(['2.1.216', '2.1.223']) },
    suggestedFix: 'Remove ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the managed profile settings.',
  }),
  rule({
    id: 'MD-L03', predicate: mdL03, severity: 'warn', incidentSource: '#224 (classification)',
    verifiedAgainstCliVersions: { claude: Object.freeze(['2.1.216', '2.1.223']) },
    suggestedFix: 'Point ANTHROPIC_BASE_URL at ModelDeck’s expected proxy, or remove proxy routing from this profile.',
  }),
  rule({
    id: 'MD-L04', predicate: mdL04, severity: 'error', incidentSource: '#62, #66, onboarding runbook',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Activate a managed account for this provider so ModelDeck recreates the activation symlink.',
  }),
  rule({
    id: 'MD-L05', predicate: mdL05, severity: 'error', incidentSource: '#66, docs/CLAUDE_IDENTITY.md',
    verifiedAgainstCliVersions: { claude: Object.freeze(['2.1.216', '2.1.223']) },
    suggestedFix: 'Reinstall the ModelDeck shell block, then activate the intended Claude profile to rewrite both pins together.',
    provenanceNote: 'Skipped when MD-L04 already reports a known activation-link defect to avoid duplicate error rows.',
  }),
  rule({
    id: 'MD-L06', predicate: mdL06, severity: 'warn', incidentSource: '#161',
    verifiedAgainstCliVersions: { codex: Object.freeze([]) },
    suggestedFix: 'Remove any stale marked Codex block, then run scripts/install-shell-env.sh so new terminals pin CODEX_HOME when they open.',
  }),
  rule({
    id: 'MD-L07', predicate: mdL07, severity: 'error', incidentSource: '#108, #161, docs/CLAUDE_IDENTITY.md',
    verifiedAgainstCliVersions: { claude: Object.freeze(['2.1.223']), codex: Object.freeze([]) },
    suggestedFix: 'Sign one affected profile in again, then refresh and verify that each profile carries a distinct account.',
  }),
  rule({
    id: 'MD-L08', predicate: mdL08, severity: 'warn', incidentSource: 'src/shared-scope.mjs managedProfiles()',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Restore the directory owner to the current user and set owner-only permissions with chmod 700.',
  }),
  rule({
    id: 'MD-L09', predicate: mdL09, severity: 'error', incidentSource: 'src/shared-scope.mjs readMcpDocument()',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Restore .claude.json as a regular JSON file containing one top-level object.',
  }),
  rule({
    id: 'MD-L10', predicate: mdL10, severity: 'warn', incidentSource: 'src/shared-scope.mjs, incident 2026-07-20',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Review the shared-scope manifest and backups, then use the documented shared-scope recovery flow.',
  }),
  rule({
    id: 'MD-L11', predicate: mdL11, severity: 'info', incidentSource: '#300',
    verifiedAgainstCliVersions: { claude: Object.freeze(['2.1.216', '2.1.223']) },
    suggestedFix: 'Remove stale Claude installations from PATH so every shell resolves the same executable.',
    provenanceNote: 'Demoted from warn to info: v1 can enumerate daemon PATH deterministically, but section 4 forbids spawning claude to version every reachable executable.',
  }),
  rule({
    id: 'MD-L12', predicate: mdL12, severity: 'error', incidentSource: '#486, #514',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Use the app’s background-service repair so launchd re-registers the verified bundled daemon.',
  }),
  rule({
    id: 'MD-L13', predicate: mdL13, severity: 'warn', incidentSource: 'rebalance cron NOTE path',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Remove the stale routing weight through the proxy’s own configuration workflow, or register the intended account.',
  }),
  rule({
    id: 'MD-L14', predicate: mdL14, severity: 'warn', incidentSource: 'managed-proxy-adoption.md',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Restore the managed proxy key file and make it owner-readable only with chmod 600.',
  }),
  rule({
    id: 'MD-L15', predicate: mdL15, severity: 'warn', incidentSource: 'PR #430 review note in src/paths.mjs',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Remove the split overrides or point the related ModelDeck config and auth paths at the same install.',
  }),
  // MD-L16 is reserved for #585 (leaked auth-override environment).
  rule({
    id: 'MD-L17', predicate: mdL17, severity: 'warn', incidentSource: '#785',
    verifiedAgainstCliVersions: {},
    suggestedFix: 'Set redis-usage-queue-retention-seconds: 3600 in the proxy config.yaml (under observability: usage: if the file has that section); the proxy reloads it without a restart.',
  }),
]);

export function evaluateConfigLint(snapshot) {
  return CONFIG_LINT_RULES
    .flatMap((entry) => entry.predicate(snapshot, entry))
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId)
      || left.scope.localeCompare(right.scope)
      || left.fingerprint.localeCompare(right.fingerprint));
}

export function configLintFailureFindings(reason) {
  return CONFIG_LINT_RULES
    .map((entry) => couldNotEvaluate(entry, 'machine:config-linter', [{
      observed: 'could-not-evaluate',
      reason: reason || 'configuration snapshot collection failed',
    }]))
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}

export function renderConfigLintTable(findings) {
  if (!findings.length) return 'No configuration problems found.\n';
  const rows = [
    ['SEVERITY', 'RULE', 'SCOPE', 'MESSAGE', 'EVIDENCE', 'SUGGESTED FIX'],
    ...findings.map((item) => [
      item.severity.toUpperCase(),
      item.ruleId,
      item.scope,
      item.message,
      JSON.stringify(item.evidence),
      item.suggestedFix,
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return `${rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n')}\n`;
}
