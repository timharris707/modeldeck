import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { DB_PATH } from '../src/paths.mjs';

if (!process.env.MODELDECK_DATA_DIR) throw new Error('Set MODELDECK_DATA_DIR to an isolated demo directory');
const root = process.env.MODELDECK_PROJECTS_ROOT || path.join(process.env.MODELDECK_DATA_DIR, 'projects');
const identities = {
  claude: {
    studio: process.env.MODELDECK_DEMO_CLAUDE_STUDIO || 'studio@example.invalid',
    client: process.env.MODELDECK_DEMO_CLAUDE_CLIENT || 'client@example.invalid',
    personalOne: process.env.MODELDECK_DEMO_CLAUDE_PERSONAL_ONE || 'personal-one@example.invalid',
    personalTwo: process.env.MODELDECK_DEMO_CLAUDE_PERSONAL_TWO || 'personal-two@example.invalid',
  },
  codex: {
    studio: process.env.MODELDECK_DEMO_CODEX_STUDIO || 'studio-codex@example.invalid',
    client: process.env.MODELDECK_DEMO_CODEX_CLIENT || 'client-codex@example.invalid',
    personal: process.env.MODELDECK_DEMO_CODEX_PERSONAL || 'personal-codex@example.invalid',
  },
};
for (const name of ['loanmeld', 'chili', 'modeldeck']) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`);
}

const profiles = path.join(process.env.MODELDECK_DATA_DIR, 'demo-profiles');
const codexHomes = Object.fromEntries(['studio', 'client', 'personal'].map((name) => [name, path.join(profiles, `codex-${name}`)]));
for (const dir of Object.values(codexHomes)) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

const store = new Store(DB_PATH);
const studioClaude = store.saveAccount({ provider: 'claude', label: 'Studio Max', identity: identities.claude.studio, profileRef: 'studio-max', purpose: 'Studio projects', color: '#e68a61', isDefault: true });
const clientClaude = store.saveAccount({ provider: 'claude', label: 'Client Max', identity: identities.claude.client, profileRef: 'client-max', purpose: 'demo-project', color: '#6bb8ff' });
const personalOneClaude = store.saveAccount({ provider: 'claude', label: 'Personal Max 1', identity: identities.claude.personalOne, profileRef: 'personal-one-max', purpose: 'Personal builds', color: '#9e8cff' });
const personalTwoClaude = store.saveAccount({ provider: 'claude', label: 'Personal Max 2', identity: identities.claude.personalTwo, profileRef: 'personal-two-max', purpose: 'Personal reserve', color: '#f2c66d' });
const studioCodex = store.saveAccount({ provider: 'codex', label: 'Studio Codex', identity: identities.codex.studio, profileRef: codexHomes.studio, purpose: 'Studio projects', color: '#52c879', isDefault: true });
const clientCodex = store.saveAccount({ provider: 'codex', label: 'Client Codex', identity: identities.codex.client, profileRef: codexHomes.client, purpose: 'demo-project', color: '#65d6c4' });
const personalCodex = store.saveAccount({ provider: 'codex', label: 'Personal Codex', identity: identities.codex.personal, profileRef: codexHomes.personal, purpose: 'Personal builds', color: '#91a7ff' });

const snapshots = [
  [studioClaude, '5-hour', 68], [studioClaude, 'weekly', 74], [studioClaude, 'Fable weekly', 83],
  [clientClaude, '5-hour', 41], [clientClaude, 'weekly', 36], [clientClaude, 'Fable weekly', 52],
  [personalOneClaude, '5-hour', 13], [personalOneClaude, 'weekly', 27], [personalOneClaude, 'Fable weekly', 24],
  [personalTwoClaude, '5-hour', 4], [personalTwoClaude, 'weekly', 8], [personalTwoClaude, 'Fable weekly', 12],
  [studioCodex, '5-hour', 78], [studioCodex, 'weekly', 54],
  [clientCodex, '5-hour', 9], [clientCodex, 'weekly', 19],
  [personalCodex, '5-hour', 2], [personalCodex, 'weekly', 6],
];
for (const [account, scope, usedPercent] of snapshots) store.recordUsage(account.id, { scope, usedPercent, source: 'demo-fixture' });

for (const name of ['loanmeld', 'chili', 'modeldeck']) {
  const project = store.saveProject({ name, path: path.join(root, name) });
  const mapping = name === 'loanmeld'
    ? { purpose: 'Business', claudeAccountId: clientClaude.id, codexAccountId: clientCodex.id }
    : name === 'chili'
      ? { purpose: 'Personal', claudeAccountId: personalOneClaude.id, codexAccountId: personalCodex.id }
      : { purpose: 'Operations', claudeAccountId: studioClaude.id, codexAccountId: studioCodex.id };
  store.mapProject(project.id, mapping);
}
store.close();
console.log(JSON.stringify({ dataDir: process.env.MODELDECK_DATA_DIR, projectsRoot: root, claudeProfiles: 4, codexProfiles: 3, seeded: true }));
