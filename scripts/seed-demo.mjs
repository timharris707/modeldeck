// Demo fixture seeder — placeholder identities ONLY (issue #129).
//
// Seeds an ISOLATED ModelDeck data directory with the demo roster used for
// README/marketing screenshots: 4 Claude + 3 Codex accounts carrying Tim's
// chosen placeholder labels ("Personal", "Business", "Hobby Account",
// "School"), `…@example.invalid` identities, anchored reset times, and plan
// tiers — so the deck renders exactly like a production install without a
// single real identity or credential anywhere.
//
// Refuses to run without MODELDECK_DATA_DIR: this must never touch the live
// database under ~/Library/Application Support/ModelDeck. The "credential"
// files it writes are clearly-labelled placeholder markers (so auth chips
// read Healthy), never real credentials. See scripts/demo-daemon.sh for the
// full isolated-instance launcher and docs/RELEASE.md for the screenshot
// capture flow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { DB_PATH, CLAUDE_PROFILES_DIR } from '../src/paths.mjs';

if (!process.env.MODELDECK_DATA_DIR) throw new Error('Set MODELDECK_DATA_DIR to an isolated demo directory');

// The seeder enforces isolation ITSELF — it can be run without
// demo-daemon.sh, so it cannot rely on the launcher's checks. All paths are
// canonicalized (symlinks resolved) before comparison; a symlink pointing at
// the live directory must not defeat the refusal.
fs.mkdirSync(process.env.MODELDECK_DATA_DIR, { recursive: true });
const dataDir = fs.realpathSync(process.env.MODELDECK_DATA_DIR);
const liveDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'ModelDeck');
let liveDataDirReal = liveDataDir;
try { liveDataDirReal = fs.realpathSync(liveDataDir); } catch { /* live dir may not exist */ }
function insideDemoDir(p) {
  return p === dataDir || p.startsWith(dataDir + path.sep);
}
for (const live of new Set([liveDataDir, liveDataDirReal])) {
  if (dataDir === live || dataDir.startsWith(live + path.sep)) {
    throw new Error('refusing to seed the live ModelDeck data directory — point MODELDECK_DATA_DIR at a throwaway demo directory');
  }
}
// Every path this script writes must resolve inside the demo dir. In
// particular MODELDECK_DB_PATH overrides the DATA_DIR-derived default in
// src/paths.mjs, so an inherited value could otherwise target a live
// database even with a safe MODELDECK_DATA_DIR.
function assertDemoPath(label, p) {
  const resolved = path.resolve(p);
  let real = null;
  try {
    // Resolve the path itself when it exists (catches a symlink as the final
    // component), else its parent + basename (path not created yet).
    real = fs.existsSync(resolved)
      ? fs.realpathSync(resolved)
      : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch { real = null; }
  if (real == null || !insideDemoDir(real)) {
    throw new Error(`refusing to seed: ${label} (${p}) is outside the demo data directory ${dataDir}`);
  }
}
assertDemoPath('database path (MODELDECK_DB_PATH)', DB_PATH);
if (path.basename(DB_PATH) !== 'modeldeck.sqlite') {
  throw new Error(`refusing to seed: database path must be ${path.join(dataDir, 'modeldeck.sqlite')}`);
}
assertDemoPath('Claude profiles dir (MODELDECK_CLAUDE_PROFILES_DIR)', CLAUDE_PROFILES_DIR);
const root = process.env.MODELDECK_PROJECTS_ROOT || path.join(dataDir, 'projects');
fs.mkdirSync(root, { recursive: true });
assertDemoPath('projects root (MODELDECK_PROJECTS_ROOT)', fs.realpathSync(root));

// Tim's chosen placeholder labels (issue #129, verbatim). Codex reuses three
// of the four — School stays Claude-only.
const identities = {
  claude: {
    personal: process.env.MODELDECK_DEMO_CLAUDE_PERSONAL || 'personal@example.invalid',
    business: process.env.MODELDECK_DEMO_CLAUDE_BUSINESS || 'business@example.invalid',
    hobby: process.env.MODELDECK_DEMO_CLAUDE_HOBBY || 'hobby@example.invalid',
    school: process.env.MODELDECK_DEMO_CLAUDE_SCHOOL || 'school@example.invalid',
  },
  codex: {
    personal: process.env.MODELDECK_DEMO_CODEX_PERSONAL || 'personal-codex@example.invalid',
    business: process.env.MODELDECK_DEMO_CODEX_BUSINESS || 'business-codex@example.invalid',
    hobby: process.env.MODELDECK_DEMO_CODEX_HOBBY || 'hobby-codex@example.invalid',
  },
};

for (const name of ['acme-webapp', 'robot-garden', 'modeldeck']) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`);
}

function makeProfileHome(dir, markerName) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  // Placeholder marker so the presence probes report Healthy. NOT a
  // credential — the content says so, and it never leaves the demo dir.
  fs.writeFileSync(
    path.join(dir, markerName),
    `${JSON.stringify({ placeholder: 'ModelDeck demo fixture — not a real credential' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return dir;
}

// Claude profile homes live under the (demo) claude-profiles dir; the
// `.credentials.json` marker satisfies claudeCredentialsPresent's file
// fallback. Codex homes carry an `auth.json` marker for the same reason.
const claudeTiers = { personal: 'default_claude_max_20x', business: 'default_claude_max_20x', hobby: 'default_claude_pro', school: 'default_claude_pro' };
const claudeHomes = Object.fromEntries(['personal', 'business', 'hobby', 'school'].map((name) => {
  const dir = makeProfileHome(path.join(CLAUDE_PROFILES_DIR, `${name}-demo`), '.credentials.json');
  // Placeholder identity truth (`oauthAccount`) so the activation read-back
  // verifies against the account's `…@example.invalid` identity and the
  // deck shows an honest "effective" state — placeholder data only.
  fs.writeFileSync(path.join(dir, '.claude.json'), `${JSON.stringify({
    oauthAccount: {
      emailAddress: identities.claude[name],
      accountUuid: `00000000-0000-4000-8000-00000000000${['personal', 'business', 'hobby', 'school'].indexOf(name) + 1}`,
      organizationRateLimitTier: claudeTiers[name],
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return [name, dir];
}));
const codexProfiles = path.join(dataDir, 'demo-profiles');
const codexHomes = Object.fromEntries(['personal', 'business', 'hobby']
  .map((name) => [name, makeProfileHome(path.join(codexProfiles, `codex-${name}`), 'auth.json')]));

const claudeMaxPlan = { claudePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } };
const claudeProPlan = { claudePlan: { subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' } };
const codexPlan = (planType, displayName) => ({ codexPlan: { planType, displayName } });

const store = new Store(DB_PATH);
const personalClaude = store.saveAccount({ provider: 'claude', label: 'Personal', identity: identities.claude.personal, profileRef: claudeHomes.personal, purpose: 'Personal builds', color: '#e68a61', isDefault: true, metadata: claudeMaxPlan });
const businessClaude = store.saveAccount({ provider: 'claude', label: 'Business', identity: identities.claude.business, profileRef: claudeHomes.business, purpose: 'Client work', color: '#6bb8ff', metadata: claudeMaxPlan });
const hobbyClaude = store.saveAccount({ provider: 'claude', label: 'Hobby Account', identity: identities.claude.hobby, profileRef: claudeHomes.hobby, purpose: 'Side projects', color: '#9e8cff', metadata: claudeProPlan });
const schoolClaude = store.saveAccount({ provider: 'claude', label: 'School', identity: identities.claude.school, profileRef: claudeHomes.school, purpose: 'Coursework', color: '#f2c66d', metadata: claudeProPlan });
const personalCodex = store.saveAccount({ provider: 'codex', label: 'Personal', identity: identities.codex.personal, profileRef: codexHomes.personal, purpose: 'Personal builds', color: '#52c879', isDefault: true, metadata: codexPlan('pro', 'Pro') });
const businessCodex = store.saveAccount({ provider: 'codex', label: 'Business', identity: identities.codex.business, profileRef: codexHomes.business, purpose: 'Client work', color: '#65d6c4', metadata: codexPlan('team', 'Team') });
const hobbyCodex = store.saveAccount({ provider: 'codex', label: 'Hobby Account', identity: identities.codex.hobby, profileRef: codexHomes.hobby, purpose: 'Side projects', color: '#91a7ff', metadata: codexPlan('plus', 'Plus') });

// Anchored reset times (relative to seed time) so every window renders a
// real "Resets …" line and the next-reset sort differs visibly from the
// lowest-remaining sort in screenshots.
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const snapshots = [
  [personalClaude, '5-hour', 34, inMinutes(100)], [personalClaude, 'weekly', 52, inMinutes(2 * 1440 + 300)], [personalClaude, 'Fable weekly', 61, inMinutes(2 * 1440 + 300)],
  [businessClaude, '5-hour', 68, inMinutes(185)], [businessClaude, 'weekly', 74, inMinutes(4 * 1440 + 120)], [businessClaude, 'Fable weekly', 83, inMinutes(4 * 1440 + 120)],
  [hobbyClaude, '5-hour', 12, inMinutes(48)], [hobbyClaude, 'weekly', 27, inMinutes(5 * 1440 + 480)],
  [schoolClaude, '5-hour', 3, inMinutes(250)], [schoolClaude, 'weekly', 9, inMinutes(1440 + 200)],
  [personalCodex, '5-hour', 22, inMinutes(140)], [personalCodex, 'weekly', 41, inMinutes(3 * 1440 + 240)],
  [businessCodex, '5-hour', 57, inMinutes(55)], [businessCodex, 'weekly', 63, inMinutes(6 * 1440 + 90)],
  [hobbyCodex, '5-hour', 8, inMinutes(220)], [hobbyCodex, 'weekly', 15, inMinutes(2 * 1440 + 600)],
];
for (const [account, scope, usedPercent, resetsAt] of snapshots) {
  store.recordUsage(account.id, { scope, usedPercent, resetsAt, source: 'demo-fixture' });
}

for (const name of ['acme-webapp', 'robot-garden', 'modeldeck']) {
  const project = store.saveProject({ name, path: path.join(root, name) });
  const mapping = name === 'acme-webapp'
    ? { purpose: 'Business', claudeAccountId: businessClaude.id, codexAccountId: businessCodex.id }
    : name === 'robot-garden'
      ? { purpose: 'Hobby', claudeAccountId: hobbyClaude.id, codexAccountId: hobbyCodex.id }
      : { purpose: 'Personal', claudeAccountId: personalClaude.id, codexAccountId: personalCodex.id };
  store.mapProject(project.id, mapping);
}
store.close();

// Active-provider symlinks INSIDE the demo dir. The demo daemon must be
// launched with MODELDECK_CLAUDE_ACTIVE_LINK / MODELDECK_CODEX_ACTIVE_LINK
// pointing here (scripts/demo-daemon.sh does) — never at ~/.claude or
// ~/.codex, which belong to the live install.
for (const [link, target] of [
  [path.join(dataDir, 'active-claude'), claudeHomes.personal],
  [path.join(dataDir, 'active-codex'), codexHomes.personal],
]) {
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link);
}

console.log(JSON.stringify({ dataDir, projectsRoot: root, claudeProfiles: 4, codexProfiles: 3, seeded: true }));
