#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { evaluateCapacity } from '../src/capacity.mjs';
import { addAccount, runInTerminal, signin } from '../src/signin-cli.mjs';
import { resolveMutationToken } from '../src/token.mjs';
import { configLintFailureFindings, evaluateConfigLint, renderConfigLintTable } from '../src/config-linter.mjs';
import { collectConfigLintSnapshot, configLintSnapshotOptions } from '../src/config-linter-snapshot.mjs';
import { LEGACY_CLIENT_KEY_SERVICE, assertClientKeyService, readClientKey } from '../src/client-key-helper.mjs';
import {
  DB_PATH, PROJECTS_ROOT, CLAUDE_PATH, CLAUDE_PROFILES_DIR, CLAUDE_ACTIVE_LINK,
  CLAUDE_SHELL_ENV_FILE, CLAUDE_STATUSLINE_DIR, CODEX_PATH, CODEX_ACTIVE_LINK, CODEX_PROFILES_DIR,
  CLIPROXY_AUTH_DIR, CLIPROXY_BASE_URL, CLIPROXY_CONFIG_DIR, CLIPROXY_MANAGEMENT_KEY_PATH,
  DATA_DIR, HOST, LAUNCHCTL_PATH, PORT, ZSHENV_PATH,
} from '../src/paths.mjs';

function usage() {
  console.log(`ModelDeck CLI

Usage:
  modeldeck serve
  modeldeck scan [projects-root]
  modeldeck status
  modeldeck check [--threshold 25] [--max-age-min 15] [--json]
  modeldeck lint [--json]
  modeldeck account add claude <label> [--identity email] [--purpose text] [--default]
  modeldeck account add codex <label> <profile-ref> [--identity email] [--purpose text] [--default]
  modeldeck claude migrate <label> <approved-cswap-profile-home>
  modeldeck map <project-path> [--claude account-id] [--codex account-id] [--purpose text]
  modeldeck resolve <claude|codex> [project-path]
  modeldeck launch <claude|codex> [--project path] [--dry-run] [-- <provider args>]
  modeldeck refresh
  modeldeck add <claude|codex> <label> [--manage]
  modeldeck signin <account id or label>
`);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const [command, ...args] = process.argv.slice(2);
if (!command || ['help', '--help', '-h'].includes(command)) {
  usage();
  process.exit(0);
}
if (command === 'serve') {
  await import('../src/server.mjs');
  const { createApp } = await import('../src/server.mjs');
  const app = createApp();
  app.listen(() => console.log(`ModelDeck running at http://${HOST}:${PORT}`));
} else if (command === 'lint') {
  const unknownOption = args.find((arg) => arg !== '--json');
  if (unknownOption) {
    console.error(`ModelDeck: unknown lint option ${unknownOption}`);
    process.exitCode = 2;
  } else {
    let store;
    let findings;
    try {
      store = new Store(DB_PATH, { readOnly: true });
      const service = new ModelDeckService(store, {
        projectsRoot: PROJECTS_ROOT,
        claudePath: CLAUDE_PATH,
        claudeProfilesDir: CLAUDE_PROFILES_DIR,
        claudeActiveLink: CLAUDE_ACTIVE_LINK,
        claudeShellEnvFile: CLAUDE_SHELL_ENV_FILE,
        claudeStatuslineDir: CLAUDE_STATUSLINE_DIR,
        codexPath: CODEX_PATH,
        codexActiveLink: CODEX_ACTIVE_LINK,
        codexProfilesDir: CODEX_PROFILES_DIR,
        cliproxyAuthDir: CLIPROXY_AUTH_DIR,
        cliproxyConfigDir: CLIPROXY_CONFIG_DIR,
        cliproxyBaseUrl: CLIPROXY_BASE_URL,
        cliproxyManagementKeyPath: CLIPROXY_MANAGEMENT_KEY_PATH,
        dataDir: DATA_DIR,
        dbPath: DB_PATH,
        zshenvPath: ZSHENV_PATH,
        launchctlPath: LAUNCHCTL_PATH,
      });
      const snapshot = await collectConfigLintSnapshot(configLintSnapshotOptions(service));
      findings = evaluateConfigLint(snapshot);
    } catch (error) {
      findings = configLintFailureFindings(error?.code || error?.message || 'configuration lint failed');
    } finally {
      store?.close();
    }
    if (args.includes('--json')) console.log(JSON.stringify({ findings }, null, 2));
    else process.stdout.write(renderConfigLintTable(findings));
    if (findings.some((finding) => finding.severity === 'error')) process.exitCode = 1;
  }
} else if (command === 'signin' || command === 'add') {
  // #808, #811: sign in or add an account from this terminal (SSH included)
  // through the running daemon; the provider prints the URL or code to
  // finish elsewhere.
  const manage = command === 'add' && args.includes('--manage');
  const rest = args.filter((arg) => arg !== '--manage');
  const usageError = command === 'signin'
    ? (rest.length !== 1 || manage) && 'usage: modeldeck signin <account id or label>'
    : rest.length !== 2 && 'usage: modeldeck add <claude|codex> <label> [--manage]';
  if (usageError) {
    console.error(usageError);
    process.exitCode = 2;
  } else {
    const { token, source } = resolveMutationToken();
    if (source === 'ephemeral') {
      console.error('ModelDeck: no stored mutation token; run scripts/set-mutation-token.sh and restart the daemon first.');
      process.exitCode = 1;
    } else {
      const daemonUrl = `http://127.0.0.1:${PORT}`;
      try {
        process.exitCode = command === 'signin'
          ? await signin(rest[0], { daemonUrl, token, run: runInTerminal })
          : await addAccount(rest[0], rest[1], { daemonUrl, token, manage });
      } catch (error) {
        console.error(`ModelDeck: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
} else {
  const store = new Store(DB_PATH);
  const service = new ModelDeckService(store, {
    projectsRoot: PROJECTS_ROOT,
    claudePath: CLAUDE_PATH,
    claudeProfilesDir: CLAUDE_PROFILES_DIR,
    claudeActiveLink: CLAUDE_ACTIVE_LINK,
    claudeShellEnvFile: CLAUDE_SHELL_ENV_FILE,
    claudeStatuslineDir: CLAUDE_STATUSLINE_DIR,
    codexPath: CODEX_PATH,
    codexActiveLink: CODEX_ACTIVE_LINK,
  });
  try {
    if (command === 'scan') {
      const projects = service.scanProjects(args[0] || PROJECTS_ROOT);
      console.log(JSON.stringify({ projects }, null, 2));
    } else if (command === 'status') {
      console.log(JSON.stringify(store.state(), null, 2));
    } else if (command === 'check') {
      const threshold = Number(valueAfter(args, '--threshold') || 25);
      const maxAgeMinutes = Number(valueAfter(args, '--max-age-min') || 15);
      const result = evaluateCapacity(store.latestUsage(), store.listAccounts(), { threshold, maxAgeMinutes });
      if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else if (result.status === 'unknown') console.log('UNKNOWN: no usage snapshots are stored; refresh manually when it is safe.');
      else {
        for (const row of result.low) console.log(`LOW: ${row.accountLabel} · ${row.scope} · ${Math.round(row.remainingPercent)}% remaining`);
        for (const row of result.stale) console.log(`STALE: ${row.accountLabel} · ${row.scope} · ${Math.round(row.ageMinutes)} minutes old`);
        if (result.status === 'ok') console.log('OK: capacity snapshots are fresh and above threshold.');
      }
      if (result.status === 'critical') process.exitCode = 2;
      else if (['stale', 'unknown'].includes(result.status)) process.exitCode = 3;
    } else if (command === 'refresh') {
      console.log(JSON.stringify(await service.refreshAll(), null, 2));
    } else if (command === 'account' && args[0] === 'add') {
      const [, provider, label, ...tail] = args;
      const profileRef = tail[0]?.startsWith('--') ? undefined : tail.shift();
      const input = {
        provider, label, profileRef,
        identity: valueAfter(tail, '--identity'),
        purpose: valueAfter(tail, '--purpose') || '',
        isDefault: tail.includes('--default'),
      };
      if (provider === 'claude' && profileRef) throw new Error('Claude profile homes are created by ModelDeck; use claude migrate for a legacy home');
      const account = await service.saveAccount(input);
      console.log(JSON.stringify(account, null, 2));
    } else if (command === 'claude' && args[0] === 'migrate') {
      const [, label, sourceDir] = args;
      if (!label || !sourceDir) throw new Error('claude migrate requires a label and an explicitly approved source directory');
      const accounts = await service.importClaudeSwapProfiles([{ label, profileName: label, sourceDir }]);
      console.log(JSON.stringify({ accounts }, null, 2));
    } else if (command === 'map') {
      const [projectPath, ...flags] = args;
      const project = store.findProjectByPath(path.resolve(projectPath));
      if (!project) throw new Error('project is not registered; run modeldeck scan first');
      const mapped = store.mapProject(project.id, {
        claudeAccountId: valueAfter(flags, '--claude') || project.claudeAccountId,
        codexAccountId: valueAfter(flags, '--codex') || project.codexAccountId,
        purpose: valueAfter(flags, '--purpose') ?? project.purpose,
      });
      console.log(JSON.stringify(mapped, null, 2));
    } else if (command === 'resolve') {
      const [provider, projectPath = process.cwd()] = args;
      const spec = await service.launchSpec(provider, projectPath);
      console.log(JSON.stringify({ provider, project: spec.project, account: spec.account, command: spec.preview }, null, 2));
    } else if (command === 'launch') {
      const provider = args[0];
      const separator = args.indexOf('--');
      const flags = separator >= 0 ? args.slice(1, separator) : args.slice(1);
      const providerArgs = separator >= 0 ? args.slice(separator + 1) : [];
      const projectPath = valueAfter(flags, '--project') || process.cwd();
      const dryRun = flags.includes('--dry-run');
      const spec = await service.launchSpec(provider, projectPath, providerArgs);
      service.recordLaunch(spec, dryRun);
      if (dryRun) console.log(spec.preview);
      else {
        const env = { ...process.env, ...spec.env };
        // The MAPPED account decides the credential, not the shell this
        // command runs from (adversarial review of #278, blocker 1).
        if (spec.credential === 'cliproxy-pointer') {
          // Pointer resolved at spawn, value never printed or persisted.
          // An empty/missing Keychain item exports nothing — an empty
          // ANTHROPIC_API_KEY would override the profile's stored OAuth —
          // and a managed key inherited from the launching shell is
          // cleared rather than left stale.
          // Issue #522: the profile's OWN item, named by the spec, so the
          // launcher and the preview it prints can never fetch different
          // keys. Validated here too — this is a command argument.
          const keychainService = assertClientKeyService(spec.keychainService || LEGACY_CLIENT_KEY_SERVICE);
          // #808: the Keychain on macOS, the owner-only key file elsewhere.
          const key = readClientKey(keychainService, { execFileSync });
          if (key) {
            env.ANTHROPIC_API_KEY = key;
            env.MODELDECK_MANAGED_ANTHROPIC_API_KEY = '1';
          } else if (env.MODELDECK_MANAGED_ANTHROPIC_API_KEY === '1') {
            delete env.ANTHROPIC_API_KEY;
            delete env.MODELDECK_MANAGED_ANTHROPIC_API_KEY;
          }
        } else if (spec.credential === 'clear-managed') {
          // Direct account: ModelDeck's own proxy key must not ride along
          // from a proxied shell. Guarded on the marker so a key the user
          // exported for their own tooling is never touched.
          if (env.MODELDECK_MANAGED_ANTHROPIC_API_KEY === '1') {
            delete env.ANTHROPIC_API_KEY;
            delete env.MODELDECK_MANAGED_ANTHROPIC_API_KEY;
          }
        }
        const child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env,
          stdio: 'inherit',
          shell: false,
        });
        const exitCode = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) => resolve(code ?? 1));
        });
        process.exitCode = exitCode;
      }
    } else {
      usage();
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`ModelDeck: ${error.message}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
