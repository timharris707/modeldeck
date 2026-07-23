import http from 'node:http';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };
import { Store } from './db.mjs';
import { ModelDeckService } from './service.mjs';
import { resolveMutationToken } from './token.mjs';
import { runProbeCli as runClaudeUsageProbe } from './adapters/claude-usage-probe.mjs';
import {
  HOST, PORT, DB_PATH, PROJECTS_ROOT, CLAUDE_PATH, CLAUDE_PROFILES_DIR, CLAUDE_ACTIVE_LINK,
  CLAUDE_SHELL_ENV_FILE, CODEX_PATH, CODEX_ACTIVE_LINK, CODEX_PROFILES_DIR,
} from './paths.mjs';

// esbuild replaces the build-only identifier with a string literal for SEA;
// source-mode execution uses Node's JSON module loader instead.
const VERSION = typeof __MODELDECK_VERSION__ === 'string'
  ? __MODELDECK_VERSION__
  : packageMetadata.version;

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('content-type must be application/json');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function mutationAllowed(req, host, port, sessionToken) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}:${port}` && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) return false;
  const cookies = Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim().split('=').map(decodeURIComponent))
    .filter((parts) => parts.length === 2));
  return req.headers['x-modeldeck-token'] === sessionToken && cookies.modeldeck_session === sessionToken;
}

function hostAllowed(req, port) {
  const value = String(req.headers.host || '');
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

export function createApp({ store, service, host = HOST, port = PORT, mutationToken } = {}) {
  const ownedStore = store || new Store(DB_PATH);
  const ownedService = service || new ModelDeckService(ownedStore, {
    projectsRoot: PROJECTS_ROOT,
    claudePath: CLAUDE_PATH,
    claudeProfilesDir: CLAUDE_PROFILES_DIR,
    claudeActiveLink: CLAUDE_ACTIVE_LINK,
    claudeShellEnvFile: CLAUDE_SHELL_ENV_FILE,
    codexPath: CODEX_PATH,
    codexActiveLink: CODEX_ACTIVE_LINK,
    codexProfilesDir: CODEX_PROFILES_DIR,
    // DEMO/DEV ONLY (issue #129): seeded fixture snapshots are authoritative —
    // provider refresh becomes a no-op and nothing is ever scheduled. Set by
    // scripts/demo-daemon.sh for screenshot instances; never in production.
    demoFixtures: process.env.MODELDECK_DEMO_FIXTURES === '1',
  });
  const { token: sessionToken, source: tokenSource } = resolveMutationToken({ token: mutationToken });

  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address()?.port || port;
      if (!hostAllowed(req, actualPort)) return json(res, 403, { error: 'unexpected host header' });
      const url = new URL(req.url, `http://${host}:${actualPort}`);
      if (req.method !== 'GET' && !mutationAllowed(req, host, actualPort, sessionToken)) return json(res, 403, { error: 'mutation token or origin rejected' });

      if (req.method === 'GET' && url.pathname === '/api/session') {
        return json(res, 200, { token: sessionToken }, {
          'Set-Cookie': `modeldeck_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict`,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, { ok: true, name: 'ModelDeck', version: VERSION, tokenSource, projectsRoot: ownedService.projectsRoot });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await ownedService.state());
      if (req.method === 'GET' && url.pathname === '/api/tools') {
        const refresh = url.searchParams.get('refresh') === '1';
        // Cache-busting refresh forces process spawns + a registry fetch, so it
        // sits behind the same boundary as mutations; cached reads stay open.
        if (refresh && !mutationAllowed(req, host, actualPort, sessionToken)) {
          return json(res, 403, { error: 'mutation token or origin rejected' });
        }
        return json(res, 200, await ownedService.probeTools({ refresh }));
      }
      const toolUpdateMatch = url.pathname.match(/^\/api\/tools\/(claude|codex)\/update$/);
      if (req.method === 'POST' && toolUpdateMatch) {
        const outcome = await ownedService.updateTool(toolUpdateMatch[1]);
        return json(res, outcome.ok ? 200 : 500, outcome);
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, ownedStore.getSettings());
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const settings = ownedStore.saveSettings(await body(req));
        ownedService.rescheduleAutoRefresh(settings);
        return json(res, 200, settings);
      }
      if (req.method === 'GET' && url.pathname === '/api/capacity/worst') return json(res, 200, ownedService.worstCapacity());
      if (req.method === 'POST' && url.pathname === '/api/claude/migrate-cswap') {
        const input = await body(req);
        const accounts = await ownedService.importClaudeSwapProfiles(input.selections);
        return json(res, 201, { accounts: await ownedService.accountsWithAuthState(accounts) });
      }
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        const input = await body(req);
        return json(res, 200, { projects: ownedService.scanProjects(input.root || ownedService.projectsRoot) });
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const input = await body(req);
        const account = await ownedService.saveAccount(input);
        return json(res, 201, { account });
      }
      const defaultMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/default$/);
      if (req.method === 'POST' && defaultMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(defaultMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, { account: ownedService.setDefaultAccount(account.provider, account.id) });
      }
      // Issue #8, step 2: the provider-owned login command for one account.
      // Read-only spec (same trust boundary as GET /api/launch) — the app
      // runs it in the user's own terminal; the daemon never performs logins.
      const loginMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/login$/);
      if (req.method === 'GET' && loginMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(loginMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        const spec = await ownedService.loginSpec(account.id);
        return json(res, 200, {
          provider: spec.provider,
          account: spec.account,
          command: spec.preview,
          // Issue #99: Claude specs carry the version-detected flow. With
          // requiresActivation the caller must activate this account BEFORE
          // running the command, verify identity while it is still active,
          // and only then optionally restore the previous active account.
          ...(spec.flow ? { flow: spec.flow } : {}),
          ...(spec.requiresActivation != null ? { requiresActivation: spec.requiresActivation } : {}),
        });
      }
      // Issue #8, step 3: token-gated identity read-back (spawns the
      // provider's status command — never a login or logout).
      const verifyMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/verify$/);
      if (req.method === 'POST' && verifyMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(verifyMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, await ownedService.verifyAccount(account.id));
      }
      const resetIdentityMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/reset-identity$/);
      if (req.method === 'POST' && resetIdentityMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(resetIdentityMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, { account: ownedService.resetClaudeIdentity(account.id) });
      }
      const activateMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/activate$/);
      if (req.method === 'POST' && activateMatch) {
        const id = decodeURIComponent(activateMatch[1]);
        const account = ownedStore.getAccount(id);
        if (!account) return json(res, 404, { error: 'account not found' });
        if (!account.enabled) return json(res, 400, { error: 'account is disabled' });
        const activated = await ownedService.activateAccount(id);
        const state = await ownedService.state();
        return json(res, 200, {
          account: activated.account,
          // Issue #66: pre-flip honesty — running Claude sessions launched
          // without the pinned env may lose session storage on this switch.
          warnings: activated.warnings,
          activation: state.activation[account.provider],
          claudeSecureStorage: state.claudeSecureStorage,
        });
      }
      const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (req.method === 'DELETE' && accountMatch) {
        const deleted = ownedService.deleteAccount(decodeURIComponent(accountMatch[1]));
        return json(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'account not found' });
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (req.method === 'PUT' && projectMatch) {
        return json(res, 200, { project: ownedStore.mapProject(decodeURIComponent(projectMatch[1]), await body(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') return json(res, 200, await ownedService.refreshAll());
      if (req.method === 'GET' && url.pathname === '/api/launch') {
        const spec = ownedService.launchSpec(url.searchParams.get('provider'), url.searchParams.get('project') || process.cwd());
        return json(res, 200, {
          provider: spec.provider,
          project: spec.project,
          account: spec.account,
          command: spec.preview,
        });
      }

      return json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, error.statusCode || 400, {
        error: error.message,
        ...(error.code === 'active-link-blocked' ? { code: error.code } : {}),
      });
    }
  });

  return {
    server,
    store: ownedStore,
    service: ownedService,
    sessionToken,
    tokenSource,
    listen(callback) {
      return server.listen(port, host, () => {
        ownedService.startAutoRefresh();
        callback?.();
      });
    },
    close() {
      ownedService.stopAutoRefresh();
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function main() {
  if (isSea() && process.argv.includes('modeldeck-internal-claude-usage-probe')) {
    // Issue #114: the probe owns its error reporting (`Claude usage probe
    // failed: <reason>`). Letting a probe error fall through to main()'s
    // catch stamped it "ModelDeck failed to start:", which misread as a
    // daemon crash in every recorded per-account refresh error.
    const code = await runClaudeUsageProbe();
    if (code !== 0) process.exitCode = code;
    return;
  }

  const app = createApp();
  app.listen(() => {
    const actualPort = app.server.address()?.port || PORT;
    console.log(`ModelDeck running at http://${HOST}:${actualPort} (db: ${DB_PATH}, mutation token source: ${app.tokenSource})`);
  });
  const shutdown = async () => {
    await app.close();
    app.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = isSea() || (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ModelDeck failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
