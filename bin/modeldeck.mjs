#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { evaluateCapacity } from '../src/capacity.mjs';
import {
  DB_PATH, PROJECTS_ROOT, CLAUDE_PATH, CLAUDE_PROFILES_DIR, CLAUDE_ACTIVE_LINK,
  CODEX_PATH, CODEX_ACTIVE_LINK, HOST, PORT,
} from '../src/paths.mjs';

function usage() {
  console.log(`ModelDeck CLI

Usage:
  modeldeck serve
  modeldeck scan [projects-root]
  modeldeck status
  modeldeck check [--threshold 25] [--max-age-min 15] [--json]
  modeldeck account add claude <label> [--identity email] [--purpose text] [--default]
  modeldeck account add codex <label> <profile-ref> [--identity email] [--purpose text] [--default]
  modeldeck claude migrate <label> <approved-cswap-profile-home>
  modeldeck map <project-path> [--claude account-id] [--codex account-id] [--purpose text]
  modeldeck resolve <claude|codex> [project-path]
  modeldeck launch <claude|codex> [--project path] [--dry-run] [-- <provider args>]
  modeldeck refresh
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
} else {
  const store = new Store(DB_PATH);
  const service = new ModelDeckService(store, {
    projectsRoot: PROJECTS_ROOT,
    claudePath: CLAUDE_PATH,
    claudeProfilesDir: CLAUDE_PROFILES_DIR,
    claudeActiveLink: CLAUDE_ACTIVE_LINK,
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
      const spec = service.launchSpec(provider, projectPath);
      console.log(JSON.stringify({ provider, project: spec.project, account: spec.account, command: spec.preview }, null, 2));
    } else if (command === 'launch') {
      const provider = args[0];
      const separator = args.indexOf('--');
      const flags = separator >= 0 ? args.slice(1, separator) : args.slice(1);
      const providerArgs = separator >= 0 ? args.slice(separator + 1) : [];
      const projectPath = valueAfter(flags, '--project') || process.cwd();
      const dryRun = flags.includes('--dry-run');
      const spec = service.launchSpec(provider, projectPath, providerArgs);
      service.recordLaunch(spec, dryRun);
      if (dryRun) console.log(spec.preview);
      else {
        const child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
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
