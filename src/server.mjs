import http from 'node:http';
import { setImmediate as yieldToServeLoop } from 'node:timers/promises';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };
import { DASHBOARD_APP_HTML } from './dashboard-app.mjs';
import { Store } from './db.mjs';
import { startDaemonErrorLogMaintenance } from './daemon-error-log.mjs';
import { scopeFindings } from './diagnostician.mjs';
import { ModelDeckService } from './service.mjs';
import { readLaneRuns, tagSessionsWithLaneRuns } from './lane-manifest.mjs';
import { resolveMutationToken } from './token.mjs';
import { OTEL_INGEST_BATCH_SIZE, parseOtlpLogs, parseOtlpMetrics } from './otel-ingest.mjs';
import { usageEstimateReport } from './usage-estimate.mjs';
import {
  activityBreakdownReport, attributionReport, costReport, exhaustionForecastReport,
} from './usage-analytics.mjs';
import { runProbeCli as runClaudeUsageProbe } from './adapters/claude-usage-probe.mjs';
import { runProbeCli as runGrokUsageProbe } from './adapters/grok-usage-probe.mjs';
import { GROK_SEA_PROBE_COMMAND } from './adapters/grok.mjs';
import { runStatuslineCli as runClaudeStatusline, STATUSLINE_SEA_COMMAND } from './adapters/claude-statusline.mjs';
import { resetCalendarReport } from './capacity.mjs';
import {
  HOST, PORT, DB_PATH, DATA_DIR, DAEMON_ERROR_LOG_PATH, PROJECTS_ROOT, CLAUDE_PATH, CLAUDE_PROFILES_DIR, CLAUDE_ACTIVE_LINK,
  CLAUDE_SHELL_ENV_FILE, CLAUDE_STATUSLINE_DIR, CODEX_PATH, CODEX_ACTIVE_LINK, CODEX_PROFILES_DIR,
  LEGACY_CODEX_PROFILES_DIR,
  GROK_SESSIONS_DIR,
  CLIPROXY_AUTH_DIR, CLIPROXY_BIN, CLIPROXY_BASE_URL, CLIPROXY_CONFIG_DIR,
  CLIPROXY_MANAGEMENT_KEY_PATH, LANE_MANIFEST_PATH, LAUNCHCTL_PATH, ZSHENV_PATH,
} from './paths.mjs';

// esbuild replaces the build-only identifier with a string literal for SEA;
// source-mode execution uses Node's JSON module loader instead.
const VERSION = typeof __MODELDECK_VERSION__ === 'string'
  ? __MODELDECK_VERSION__
  : packageMetadata.version;

// The daemon's own build commit, inlined by esbuild the same way as VERSION.
// Self-reported on /api/health (and /api/state's daemon section) so the app
// can verify that the RUNNING process is the build it just registered — the
// 0.3.13→0.3.15 incident: SMAppService re-register no-ops at the BTM layer
// while the old process keeps answering, and nothing else can tell them
// apart (the on-disk manifest always matches the new bundle). Null in
// source-mode runs, which never go through SMAppService registration.
const GIT_COMMIT = typeof __MODELDECK_GIT_COMMIT__ === 'string' && __MODELDECK_GIT_COMMIT__ !== ''
  ? __MODELDECK_GIT_COMMIT__
  : null;

const EXPOSED_ERROR_CODES = new Set([
  'active-link-blocked',
  'not-managed',
  'manage-required',
  'management-in-progress',
  'claude-unmanage-unavailable',
  'profile-exists',
  'claude-activation-operation-timeout',
  'claude-activation-operation-still-running',
  'claude-activation-queue-timeout',
  'claude-profile-settings-operation-timeout',
]);

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

// Issue #343: the dashboard is the daemon's only non-JSON response. Same
// loopback trust boundary as every route (Host gate ahead of the router);
// the CSP additionally pins the page to inline assets + same-origin fetch —
// external CDNs/resources are structurally impossible, not just avoided.
function html(res, markup) {
  const payload = Buffer.from(markup, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
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

function loopbackPeer(req) {
  const address = req.socket?.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function otlpJsonOnly(req) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType === 'application/json') return;
  const error = new Error('OTLP receiver accepts JSON only; protobuf content types are not supported');
  error.statusCode = 415;
  throw error;
}

async function ingestOtelBatches(records, insert, yieldLoop) {
  for (let offset = 0; offset < records.length; offset += OTEL_INGEST_BATCH_SIZE) {
    insert(records.slice(offset, offset + OTEL_INGEST_BATCH_SIZE));
    await yieldLoop();
  }
}

export function createApp({
  store, service, host = HOST, port = PORT, mutationToken,
  // Issue #347: read-only lane manifest used to tag sessions with an issue.
  laneManifestPath = LANE_MANIFEST_PATH,
} = {}) {
  const ownedStore = store || new Store(DB_PATH);
  const ownedService = service || new ModelDeckService(ownedStore, {
    projectsRoot: PROJECTS_ROOT,
    claudePath: CLAUDE_PATH,
    claudeProfilesDir: CLAUDE_PROFILES_DIR,
    claudeActiveLink: CLAUDE_ACTIVE_LINK,
    claudeShellEnvFile: CLAUDE_SHELL_ENV_FILE,
    claudeStatuslineDir: CLAUDE_STATUSLINE_DIR,
    codexPath: CODEX_PATH,
    codexActiveLink: CODEX_ACTIVE_LINK,
    codexProfilesDir: CODEX_PROFILES_DIR,
    codexLegacyProfilesDir: LEGACY_CODEX_PROFILES_DIR,
    grokSessionsDir: GROK_SESSIONS_DIR,
    cliproxyAuthDir: CLIPROXY_AUTH_DIR,
    cliproxyConfigDir: CLIPROXY_CONFIG_DIR,
    cliproxyPath: CLIPROXY_BIN,
    cliproxyBaseUrl: CLIPROXY_BASE_URL,
    cliproxyManagementKeyPath: CLIPROXY_MANAGEMENT_KEY_PATH,
    daemonGitCommit: GIT_COMMIT,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    zshenvPath: ZSHENV_PATH,
    launchctlPath: LAUNCHCTL_PATH,
    configLintEnabled: true,
    // DEMO/DEV ONLY (issue #129): seeded fixture snapshots are authoritative —
    // provider refresh becomes a no-op and its scheduler never arms. Local
    // database maintenance remains independent. Set only by demo-daemon.sh.
    demoFixtures: process.env.MODELDECK_DEMO_FIXTURES === '1',
  });
  const { token: sessionToken, source: tokenSource } = resolveMutationToken({ token: mutationToken });
  let startup = Promise.resolve();

  const server = http.createServer(async (req, res) => {
    let migrationReader = false;
    try {
      await startup;
      const actualPort = server.address()?.port || port;
      // Loopback-only is the supported deployment: the peer address is
      // kernel-provided, so this holds even if MODELDECK_HOST binds wider
      // and the (client-controlled) Host header is spoofed. Issue #436.
      if (!loopbackPeer(req)) return json(res, 403, { error: 'loopback connections only' });
      if (!hostAllowed(req, actualPort)) return json(res, 403, { error: 'unexpected host header' });
      const url = new URL(req.url, `http://${host}:${actualPort}`);
      const migrationRequest = req.method === 'POST' && url.pathname === '/api/codex-profiles/migrate';
      if (!migrationRequest && url.pathname !== '/api/health') {
        // Readers and mutations see either the original or the published
        // profile tree. An on-demand request joins the attempt in its route.
        while (ownedService.codexProfilesMigrationPromise) await ownedService.codexProfilesMigrationPromise;
        ownedService.codexProfilesMigrationReaders = (ownedService.codexProfilesMigrationReaders || 0) + 1;
        migrationReader = true;
      }
      if (ownedService.codexProfilesMigrationBlocked && url.pathname !== '/api/health') {
        return json(res, 503, { error: ownedService.codexProfilesMigrationWarning });
      }
      const otlpKind = req.method === 'POST' && url.pathname === '/otlp/v1/metrics'
        ? 'metrics'
        : req.method === 'POST' && url.pathname === '/otlp/v1/logs'
          ? 'logs'
          : null;
      if (otlpKind) {
        // Claude's exporter cannot participate in the UI session-token
        // handshake. This is the only non-GET exception, and it stays absent
        // by default plus confined by the global loopback peer check above.
        if (!ownedStore.getSettings().otelReceiverEnabled) return json(res, 404, { error: 'not found' });
        otlpJsonOnly(req);
        const yieldLoop = ownedService.yieldToServeLoop || yieldToServeLoop;
        const parsed = otlpKind === 'metrics'
          ? await parseOtlpMetrics(await body(req), { yieldToServeLoop: yieldLoop })
          : await parseOtlpLogs(await body(req), { yieldToServeLoop: yieldLoop });
        await ingestOtelBatches(parsed.quarantine, (records) => ownedStore.ingestOtelQuarantine(records), yieldLoop);
        if (otlpKind === 'metrics') {
          await ingestOtelBatches(parsed.records, (records) => ownedStore.ingestOtelMetrics(records), yieldLoop);
        } else {
          await ingestOtelBatches(parsed.records, (records) => ownedStore.ingestOtelEvents(records), yieldLoop);
        }
        const rejectedKey = otlpKind === 'metrics' ? 'rejectedDataPoints' : 'rejectedLogRecords';
        // Keep the response valid OTLP/JSON: int64 fields are JSON strings,
        // and no ModelDeck-only fields are added for strict SDK decoders.
        return json(res, 200, parsed.unknown > 0
          ? { partialSuccess: { [rejectedKey]: String(parsed[rejectedKey]), errorMessage: `${parsed.unknown} unrecognized OTLP record(s) quarantined` } }
          : {});
      }
      if (req.method !== 'GET' && !mutationAllowed(req, host, actualPort, sessionToken)) return json(res, 403, { error: 'mutation token or origin rejected' });

      if (req.method === 'GET' && url.pathname === '/api/session') {
        return json(res, 200, { token: sessionToken }, {
          'Set-Cookie': `modeldeck_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict`,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true, name: 'ModelDeck', version: VERSION, MDGitCommit: GIT_COMMIT, tokenSource, projectsRoot: ownedService.projectsRoot,
          ...(ownedService.codexProfilesMigrationWarning ? { warning: ownedService.codexProfilesMigrationWarning } : {}),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/codex-profiles/migrate') {
        const result = await ownedService.migrateCodexProfilesDir();
        return json(res, 200, result.migrated ? { status: 'moved' }
          : result.warning ? { status: 'deferred', holders: result.holders || [] }
            : { status: 'not-needed' });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await ownedService.state());
      if (req.method === 'GET' && url.pathname === '/api/config-lint') {
        return json(res, 200, ownedService.configLintStatus());
      }
      if (req.method === 'POST' && url.pathname === '/api/config-lint/run') {
        return json(res, 200, await ownedService.runConfigLint());
      }
      // Issue #432: the app owns the proxy process, so it reports lifecycle
      // facts through the same token-gated mutation boundary as every other
      // app write. The service keeps only the last report in memory.
      if (req.method === 'POST' && url.pathname === '/api/managed-proxy/report') {
        return json(res, 200, { appReport: ownedService.reportManagedProxy(await body(req)) });
      }
      // Issue #520: the app owns raw client keys and reports only SHA-256
      // hashes. Full-state and idempotent — the store applies it atomically
      // and rejects a generation it has already applied, so a replayed report
      // cannot resurrect a rotated key. Inherits the mutation-token gate above.
      if (req.method === 'POST' && url.pathname === '/api/client-keys/report') {
        return json(res, 200, { clientKeys: ownedService.reportClientKeys(await body(req)) });
      }
      // Issue #359: every usage-analytics API route shares the dashboard's
      // kill-switch boundary. Prefix gating keeps future /api/usage/* routes
      // indistinguishable from routes that do not exist until explicitly enabled.
      if (url.pathname.startsWith('/api/usage/') && !ownedStore.getSettings().usageAnalyticsEnabled) {
        return json(res, 404, { error: 'not found' });
      }
      // Issue #343/#388: the usage-analytics dashboard, behind the
      // usageAnalyticsEnabled kill switch. While the flag is off
      // the route is indistinguishable from a route that never existed.
      //
      // Issue #385: the landing is the Overview — dashboard/ compiled to one
      // self-contained page (src/dashboard-app.mjs). Issue #387 finished the
      // port: the detail views live in that same bundle, /dashboard/legacy is
      // gone, and ONE dashboard stack survives v1 (amendment decision 7).
      if (req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
        if (!ownedStore.getSettings().usageAnalyticsEnabled) return json(res, 404, { error: 'not found' });
        return html(res, DASHBOARD_APP_HTML);
      }
      // Receipts-v1 diagnostician findings are materialized by the daemon's
      // warehouse pass. This endpoint is a read only — it never rescans the
      // corpus or advances a suppression revision while a dashboard polls it.
      if (req.method === 'GET' && url.pathname === '/api/usage/findings') {
        return json(res, 200, {
          findings: scopeFindings(ownedStore.listFindings(), {
            provider: url.searchParams.get('provider'),
            since: url.searchParams.get('since'),
            until: url.searchParams.get('until'),
          }),
        });
      }
      // This endpoint may later supersede the Mac app's client-side BurnRateWindow sampling.
      if (req.method === 'GET' && url.pathname === '/api/usage/history') {
        return json(res, 200, ownedStore.usageHistory({
          accountId: url.searchParams.get('accountId'),
          scope: url.searchParams.get('scope'),
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          bucket: url.searchParams.has('bucket') ? url.searchParams.get('bucket') : undefined,
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/summary') {
        return json(res, 200, ownedStore.usageSummary({
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          groupBy: url.searchParams.get('groupBy'),
          // Issue #344 burn-timeline filters; absent params stay null (unfiltered).
          accountId: url.searchParams.get('accountId'),
          model: url.searchParams.get('model'),
          provider: url.searchParams.get('provider'),
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/resets') {
        return json(res, 200, resetCalendarReport(
          ownedStore.latestUsage(),
          ownedStore.listAccounts(),
        ));
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/estimate') {
        return json(res, 200, usageEstimateReport(ownedStore, {
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          accountId: url.searchParams.get('accountId'),
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/exhaustion-forecast') {
        return json(res, 200, exhaustionForecastReport(ownedStore, {
          provider: url.searchParams.get('provider'),
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/attribution') {
        return json(res, 200, attributionReport(ownedStore, {
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          scope: url.searchParams.get('scope') || undefined,
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/activity-breakdown') {
        return json(res, 200, activityBreakdownReport(ownedStore, {
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          provider: url.searchParams.get('provider'),
          project: url.searchParams.get('project'),
          laneRuns: readLaneRuns(laneManifestPath),
        }));
      }
      // Issue #371: model × reasoning effort with a PROJECT filter. The
      // warehouse grouping behind /api/usage/summary?groupBy=model_effort
      // records no project, so this reads the session corpus — the same
      // universe /api/usage/projects measures. Same validation style as the
      // readers above: raw query strings straight to the reader, which owns
      // every message, under the #359 prefix gate.
      if (req.method === 'GET' && url.pathname === '/api/usage/model-effort') {
        return json(res, 200, ownedStore.modelEffortBurn({
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          provider: url.searchParams.get('provider'),
          project: url.searchParams.get('project'),
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/cost') {
        return json(res, 200, costReport(ownedStore, {
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          provider: url.searchParams.get('provider'),
        }));
      }
      // Issue #347: the session/task explorer — a leaderboard across BOTH
      // providers by default; ?sessionId= (+ ?profile=) switches to the detail
      // read. Lane-issue tags are a heuristic enrichment layered on top of the
      // warehouse read — the manifest is read fresh per request and a missing
      // or unreadable manifest simply produces untagged rows.
      //
      // Sits under the issue #359 /api/usage/ prefix gate above, so while
      // usageAnalyticsEnabled is off this route is byte-identical to a route
      // that never existed — including its detail mode and its
      // parameter-validation errors.
      if (req.method === 'GET' && url.pathname === '/api/usage/sessions') {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId != null) {
          const detail = ownedStore.usageSessionDetail({
            sessionId,
            profile: url.searchParams.get('profile'),
            provider: url.searchParams.get('provider'),
          });
          const tagged = detail.session
            ? tagSessionsWithLaneRuns([detail.session], readLaneRuns(laneManifestPath))[0]
            : null;
          return json(res, 200, { mode: 'detail', ...detail, session: tagged });
        }
        const leaderboard = ownedStore.usageSessions({
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          provider: url.searchParams.get('provider'),
          accountId: url.searchParams.get('accountId'),
          limit: url.searchParams.get('limit'),
          // Issue #346: the project-burn drill-down narrows this same
          // leaderboard to one project (or the 'unattributed' bucket).
          project: url.searchParams.get('project'),
        });
        return json(res, 200, {
          mode: 'leaderboard',
          ...leaderboard,
          sessions: tagSessionsWithLaneRuns(leaderboard.sessions, readLaneRuns(laneManifestPath)),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/session-anatomy') {
        return json(res, 200, ownedStore.sessionAnatomy({
          sessionId: url.searchParams.get('sessionId'),
          profile: url.searchParams.get('profile'),
          provider: url.searchParams.get('provider'),
        }));
      }
      // Issue #346: burn by project (decision 10b). Same validation style as
      // /api/usage/sessions — raw query strings straight to the reader, which
      // owns every message — and under the same #359 prefix gate, so the route
      // is byte-identical to a nonexistent one while the flag is off.
      // ?project= adds that project's session drill-down, tagged like the
      // leaderboard's own rows.
      if (req.method === 'GET' && url.pathname === '/api/usage/projects') {
        const burn = ownedStore.projectBurn({
          since: url.searchParams.get('since'),
          until: url.searchParams.get('until'),
          provider: url.searchParams.get('provider'),
          project: url.searchParams.get('project'),
          limit: url.searchParams.get('limit'),
          bucket: url.searchParams.get('bucket'),
        });
        return json(res, 200, burn.sessions
          ? {
            ...burn,
            sessions: {
              ...burn.sessions,
              sessions: tagSessionsWithLaneRuns(burn.sessions.sessions, readLaneRuns(laneManifestPath)),
            },
          }
          : burn);
      }
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
        const previous = ownedStore.getSettings();
        const settings = await ownedService.updateSettings(await body(req));
        try {
          await ownedService.applySharedScopeSettings(previous, settings);
        } catch (error) {
          // A conflict means this request never started, so restore its prior
          // opt-in value. Genuinely started operations retain recovery intent:
          // disable failures keep the previous true bit and enable failures
          // keep the requested true bit. Other validated settings stay applied.
          const restored = ownedStore.saveSettings({
            sharedUserScopeEnabled: error.statusCode === 409
              ? previous.sharedUserScopeEnabled
              : settings.sharedUserScopeEnabled
                ? true
                : previous.sharedUserScopeEnabled,
            // A failed combined update must never arm/disarm a destructive
            // queue consumer later than the response implies. Roll this one
            // handoff flag back even though ordinary validated fields remain.
            usageQueueConsumerEnabled: previous.usageQueueConsumerEnabled,
          });
          await ownedService.rescheduleUsageQueueConsumer?.(restored);
          await ownedService.rescheduleWarehouseIngest?.(ownedStore.getSettings());
          throw error;
        }
        const current = ownedStore.getSettings();
        ownedService.rescheduleAutoRefresh(current);
        await ownedService.rescheduleUsageQueueConsumer?.(current);
        await ownedService.rescheduleWarehouseIngest?.(current);
        return json(res, 200, current);
      }
      if (req.method === 'POST' && url.pathname === '/api/shared-scope/enable') {
        return json(res, 200, { sharedScope: await ownedService.enableSharedScope() });
      }
      if (req.method === 'POST' && url.pathname === '/api/shared-scope/disable') {
        return json(res, 200, { sharedScope: await ownedService.disableSharedScope() });
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
      if (req.method === 'GET' && url.pathname === '/api/grok/home-candidate') {
        if (!mutationAllowed(req, host, actualPort, sessionToken)) {
          return json(res, 403, { error: 'mutation token or origin rejected' });
        }
        return json(res, 200, await ownedService.grokHomeCandidate(url.searchParams.get('path')));
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const input = await body(req);
        const { profileNote, ...account } = await ownedService.saveAccount(input);
        return json(res, 201, {
          account: ownedService.accountForPublicResponse(account),
          ...(profileNote ? { profileNote } : {}),
        });
      }
      const defaultMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/default$/);
      if (req.method === 'POST' && defaultMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(defaultMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, {
          account: ownedService.accountForPublicResponse(
            ownedService.setDefaultAccount(account.provider, account.id),
          ),
        });
      }
      // Issue #8, step 2: the provider-owned login command for one account.
      // Same trust boundary as GET /api/launch — the app runs the command in
      // the user's own terminal; the daemon never performs logins. One
      // deliberate side effect (issue #596): serving a Claude spec SEEDS the
      // stray-login baseline if no attempt is live. Seed-only by design: an
      // ungated GET may start tracking but can never clear or overwrite a
      // baseline, so it cannot disarm the stray-login diagnostic.
      const loginMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/login$/);
      if (req.method === 'GET' && loginMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(loginMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        const spec = await ownedService.loginSpec(account.id);
        return json(res, 200, {
          provider: spec.provider,
          account: ownedService.accountForPublicResponse(spec.account),
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
        const verification = await ownedService.verifyAccount(account.id);
        return json(res, 200, {
          ...verification,
          account: ownedService.accountForPublicResponse(verification.account),
        });
      }
      // Issue #280: re-check a remembered Claude identity through the same
      // isolated, auth-status-only read used by renewal. This endpoint never
      // reaches renewal probing or its inference fallback.
      const verifyIdentityMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/verify-identity$/);
      if (req.method === 'POST' && verifyIdentityMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(verifyIdentityMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, await ownedService.verifyClaudeIdentity(account.id));
      }
      // Issue #279: user-initiated CLIProxyAPI OAuth. The proxy binary opens
      // the browser; the daemon waits only for matching identity evidence in
      // the auth directory and never captures child output or credential data.
      const proxyPoolJoinMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/proxy-pool\/join$/);
      if (req.method === 'POST' && proxyPoolJoinMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(proxyPoolJoinMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, await ownedService.joinProxyPool(account.id));
      }
      // Issue #396: in-app repair for an expired pool credential. ModelDeck
      // asks the PROXY to run the proxy's own OAuth (#398 — the proxy stays
      // the sole auth-file writer); start hands back the authorize URL for
      // the app to open, and the poll reports the proxy's own verdict.
      const proxyReloginMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/proxy-relogin$/);
      if (proxyReloginMatch && (req.method === 'GET' || req.method === 'POST')) {
        const account = ownedStore.getAccount(decodeURIComponent(proxyReloginMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, req.method === 'POST'
          ? await ownedService.startProxyRelogin(account.id)
          : await ownedService.proxyReloginState(account.id));
      }
      const proxyReloginCancelMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/proxy-relogin\/cancel$/);
      if (req.method === 'POST' && proxyReloginCancelMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(proxyReloginCancelMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, await ownedService.cancelProxyRelogin(account.id));
      }
      // Session routing is deliberately separate from pool membership: any
      // combination is legal. Claude-only until Codex provider routing can be
      // detected and mutated honestly.
      const proxyRoutingMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/proxy-routing\/(wire|unwire)$/);
      if (req.method === 'POST' && proxyRoutingMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(proxyRoutingMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        const routing = proxyRoutingMatch[2] === 'wire'
          ? await ownedService.wireProxyRouting(account.id)
          : await ownedService.unwireProxyRouting(account.id);
        return json(res, 200, routing);
      }
      // Issue #522: the legacy→per-profile client-key helper migration, daemon
      // half. GET reports honest state (including a migration that stopped
      // between its two files); POST performs the settings + shell-env stages
      // and refuses unless the app reports #521's consented config write
      // landed. The app keeps the raw key and the config edit; the daemon
      // never sees either.
      const clientKeyHelperMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/client-key-helper$/);
      if (clientKeyHelperMatch && (req.method === 'GET' || req.method === 'POST')) {
        const account = ownedStore.getAccount(decodeURIComponent(clientKeyHelperMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, {
          clientKeyHelper: req.method === 'POST'
            ? await ownedService.migrateClaudeClientKeyHelper(account.id, await body(req))
            : await ownedService.claudeClientKeyWiring(account.id),
        });
      }
      // Issue #174: per-profile statusline capture opt-in. Both writes stay
      // inside the profile's OWN settings.json (never the active-profile
      // symlink) and are token-gated like every mutation.
      const statuslineMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/statusline\/(install|uninstall)$/);
      if (req.method === 'POST' && statuslineMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(statuslineMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        const statusline = statuslineMatch[2] === 'install'
          ? await ownedService.installClaudeStatusline(account.id)
          : await ownedService.uninstallClaudeStatusline(account.id);
        return json(res, 200, { statusline });
      }
      const resetIdentityMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/reset-identity$/);
      if (req.method === 'POST' && resetIdentityMatch) {
        const account = ownedStore.getAccount(decodeURIComponent(resetIdentityMatch[1]));
        if (!account) return json(res, 404, { error: 'account not found' });
        return json(res, 200, {
          account: ownedService.accountForPublicResponse(
            ownedService.resetClaudeIdentity(account.id),
          ),
        });
      }
      const renewMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/renew$/);
      if (req.method === 'POST' && renewMatch) {
        const id = decodeURIComponent(renewMatch[1]);
        if (!ownedStore.getAccount(id)) return json(res, 404, { error: 'account not found' });
        return json(res, 200, { renew: await ownedService.renewClaudeAccount(id) });
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
          account: ownedService.accountForPublicResponse(activated.account),
          // Issue #66: pre-flip honesty — running Claude sessions launched
          // without the pinned env may lose session storage on this switch.
          warnings: activated.warnings,
          activation: state.activation[account.provider],
          claudeSecureStorage: state.claudeSecureStorage,
        });
      }
      // Issue #586: in-app resolution of the first-run `active-link-blocked`
      // dead end — adopt (or move aside, mode "fresh") the legacy real
      // ~/.claude so the add-subscription flow can proceed.
      const adoptMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/adopt-legacy-home$/);
      if (req.method === 'POST' && adoptMatch) {
        const id = decodeURIComponent(adoptMatch[1]);
        if (!ownedStore.getAccount(id)) return json(res, 404, { error: 'account not found' });
        const input = await body(req);
        const adopted = await ownedService.adoptClaudeLegacyHome(id, { mode: input.mode ?? 'adopt' });
        return json(res, 200, {
          account: ownedService.accountForPublicResponse(adopted.account),
          warnings: adopted.warnings,
          backupPath: adopted.backupPath,
        });
      }
      const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (req.method === 'DELETE' && accountMatch) {
        const deleted = await ownedService.deleteAccount(decodeURIComponent(accountMatch[1]));
        return json(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'account not found' });
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (req.method === 'PUT' && projectMatch) {
        return json(res, 200, { project: ownedStore.mapProject(decodeURIComponent(projectMatch[1]), await body(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') return json(res, 200, await ownedService.refreshAll());
      if (req.method === 'GET' && url.pathname === '/api/launch') {
        const spec = await ownedService.launchSpec(url.searchParams.get('provider'), url.searchParams.get('project') || process.cwd());
        return json(res, 200, {
          provider: spec.provider,
          project: spec.project,
          account: ownedService.accountForPublicResponse(spec.account),
          command: spec.preview,
        });
      }

      return json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, error.statusCode || 400, {
        error: error.message,
        ...(EXPOSED_ERROR_CODES.has(error.code) ? { code: error.code } : {}),
        ...(error.code === 'profile-exists' ? { profile: error.profile } : {}),
      });
    } finally {
      if (migrationReader) ownedService.codexProfilesMigrationReaders -= 1;
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
        // Finish filesystem/store migration before any reader, writer, or
        // provider poll can observe a half-moved profile. HTTP waits too.
        startup = Promise.resolve(ownedService.migrateCodexProfilesDir?.()).then(() => {
          if (ownedService.codexProfilesMigrationBlocked) { callback?.(); return; }
          // Retention is daemon maintenance, not provider polling: start it even
          // when auto-refresh is disabled or the daemon serves demo fixtures.
          ownedService.startUsageSnapshotRetention?.();
          ownedService.startUsageQueueConsumer?.();
          void ownedService.startConfigLint?.()?.catch((error) => {
            console.error(`[modeldeck] config lint startup failed: ${error?.message || error}`);
          });
          void ownedService.startWarehouseIngest?.()?.catch((error) => {
            console.error(`[modeldeck] warehouse ingest startup failed: ${error?.message || error}`);
          });
          ownedService.startAutoRefresh();
          callback?.();
        });
      });
    },
    async close() {
      await startup;
      await Promise.all([
        ownedService.stopCodexProfilesMigration?.() || Promise.resolve(),
        ownedService.stopAutoRefresh(),
        ownedService.stopUsageSnapshotRetention?.() || Promise.resolve(),
        ownedService.stopUsageQueueConsumer?.() || Promise.resolve(),
        ownedService.stopWarehouseIngest?.() || Promise.resolve(),
        ownedService.stopConfigLint?.() || Promise.resolve(),
        new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      ]);
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
  if (isSea() && process.argv.includes(GROK_SEA_PROBE_COMMAND)) {
    // Same contract as the Claude probe above: the probe owns its error
    // reporting, so a probe failure never reads as a daemon start failure.
    const code = await runGrokUsageProbe();
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (isSea() && process.argv.includes(STATUSLINE_SEA_COMMAND)) {
    // Issue #174: the SEA daemon binary doubles as the statusline tee. The
    // tee never fails (a statusline error would degrade the user's own
    // statusline), so no exit-code plumbing here.
    await runClaudeStatusline();
    return;
  }

  // daemon-entry.mjs redirected fd 2 before this module loaded. Keep that
  // active inode bounded in place so native/runtime diagnostics and direct
  // fs.writeSync(2, ...) calls rotate with ordinary process.stderr writes.
  let stopErrorLogMaintenance = () => {};
  if (isSea()) {
    try {
      stopErrorLogMaintenance = startDaemonErrorLogMaintenance({ logPath: DAEMON_ERROR_LOG_PATH });
    } catch (error) {
      try {
        process.stderr.write(`[modeldeck] managed stderr log unavailable: ${error?.message || error}\n`);
      } catch {
        // Logging failure does not block the daemon from serving.
      }
    }
  }
  const app = createApp();
  app.listen(() => {
    const actualPort = app.server.address()?.port || PORT;
    console.log(`ModelDeck running at http://${HOST}:${actualPort} (db: ${DB_PATH}, mutation token source: ${app.tokenSource})`);
  });
  const shutdown = async () => {
    await app.close();
    app.store.close();
    stopErrorLogMaintenance();
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
