import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, dueAt: this.time + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.time = next[1].dueAt;
      this.timers.delete(next[0]);
      next[1].callback();
      await this.flush();
    }
    this.time = target;
    await this.flush();
  }

  async wakeAfter(ms) {
    this.time += ms;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.dueAt <= this.time);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
    await this.flush();
  }

  async flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function fixture({
  enabled = true,
  intervalSeconds = 60,
  initialDelayMs = 100,
  pauseWhileActive = true,
  listProviderProcesses = async () => [],
  demoFixtures = false,
} = {}) {
  const store = new Store(':memory:');
  store.saveSettings({
    autoRefreshEnabled: enabled,
    autoRefreshIntervalSeconds: intervalSeconds,
    pauseWhileActive,
  });
  const clock = new FakeClock();
  const service = new ModelDeckService(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    autoRefreshInitialDelayMs: initialDelayMs,
    listProviderProcesses,
    demoFixtures,
  });
  return { store, clock, service, close: () => { service.stopAutoRefresh(); store.close(); } };
}

test('auto-refresh fires shortly after boot and once per configured interval', async () => {
  const data = fixture();
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(99);
    assert.equal(refreshes, 0);
    await data.clock.advance(1);
    assert.equal(refreshes, 1);
    await data.clock.advance(59_999);
    assert.equal(refreshes, 1);
    await data.clock.advance(1);
    assert.equal(refreshes, 2);
  } finally { data.close(); }
});

// Issue #129: demo screenshot instances run on seeded fixture snapshots.
// Placeholder accounts hold no credentials, so a real provider refresh could
// only fail and degrade their auth chips — demo mode therefore never arms
// the scheduler and turns refreshAll into a truthful no-op.
test('demo fixture mode never schedules and refreshAll is a provider-free no-op', async () => {
  const data = fixture({ demoFixtures: true });
  let providerCalls = 0;
  data.service.refreshClaude = async () => { providerCalls += 1; return []; };
  data.service.refreshCodex = async () => { providerCalls += 1; return []; };
  try {
    data.service.startAutoRefresh();
    assert.equal(data.clock.timers.size, 0);
    await data.clock.advance(3_600_000);
    const result = await data.service.refreshAll();
    assert.equal(result.demoFixtures, true);
    assert.equal(result.claude, null);
    assert.equal(result.codex, null);
    assert.equal(providerCalls, 0);
    assert.equal(data.clock.timers.size, 0);
  } finally { data.close(); }
});

test('disabled auto-refresh never arms or fires a timer', async () => {
  const data = fixture({ enabled: false });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    assert.equal(data.clock.timers.size, 0);
    await data.clock.advance(3_600_000);
    assert.equal(refreshes, 0);
  } finally { data.close(); }
});

test('settings changes replace the pending timer and disabling cancels it', async () => {
  const data = fixture({ intervalSeconds: 300 });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(50);
    let settings = data.store.saveSettings({ autoRefreshIntervalSeconds: 60 });
    data.service.rescheduleAutoRefresh(settings);
    await data.clock.advance(59_999);
    assert.equal(refreshes, 0);
    await data.clock.advance(1);
    assert.equal(refreshes, 1);

    settings = data.store.saveSettings({ autoRefreshEnabled: false });
    data.service.rescheduleAutoRefresh(settings);
    assert.equal(data.clock.timers.size, 0);
    await data.clock.advance(300_000);
    assert.equal(refreshes, 1);
  } finally { data.close(); }
});

test('manual refresh coalesces with an in-flight scheduled refresh', async () => {
  const data = fixture();
  let releaseClaude;
  let claudePasses = 0;
  let codexPasses = 0;
  data.service.refreshClaude = async () => {
    claudePasses += 1;
    await new Promise((resolve) => { releaseClaude = resolve; });
    return [];
  };
  data.service.refreshCodex = async () => { codexPasses += 1; return []; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    const manual = data.service.refreshAll();
    assert.equal(claudePasses, 1);
    releaseClaude();
    await manual;
    await data.clock.flush();
    assert.equal(claudePasses, 1);
    assert.equal(codexPasses, 1);
  } finally { data.close(); }
});

test('a long sleep drops missed ticks instead of firing a catch-up burst', async () => {
  const data = fixture();
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 1);

    await data.clock.wakeAfter(10 * 60_000);
    assert.equal(refreshes, 2);
    assert.equal(data.clock.timers.size, 1);
    const [next] = data.clock.timers.values();
    assert.equal(next.dueAt, data.clock.time + 60_000);
  } finally { data.close(); }
});

// Issue #90 change-event provenance: the persisted
// autoRefreshIntervalCustomized flag is the cap's only gate. It flips true —
// permanently — when a settings write CHANGES the interval or the app
// asserts an explicit picker selection; echoed full documents can never set
// it, and nothing can clear it.
test('changing the interval sets the customized flag; echoes and false cannot touch it', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.getSettings().autoRefreshIntervalCustomized, false);

    // Echo-PUT of the full unchanged document (the app PUTs merged docs):
    // every key present, values unchanged — must NOT count as customization.
    const echoed = store.saveSettings({ ...store.getSettings() });
    assert.equal(echoed.autoRefreshIntervalCustomized, false);

    // Unrelated setting writes don't count either.
    assert.equal(store.saveSettings({ menuBarStyle: 'icon-and-percent' }).autoRefreshIntervalCustomized, false);

    // A write that CHANGES the interval is the change event.
    assert.equal(store.saveSettings({ autoRefreshIntervalSeconds: 600 }).autoRefreshIntervalCustomized, true);

    // One-way: changing back to the default value keeps it, an explicit
    // false cannot clear it, and echoes keep it.
    assert.equal(store.saveSettings({ autoRefreshIntervalSeconds: 300 }).autoRefreshIntervalCustomized, true);
    assert.equal(store.saveSettings({ autoRefreshIntervalCustomized: false }).autoRefreshIntervalCustomized, true);
    assert.equal(store.saveSettings({ ...store.getSettings() }).autoRefreshIntervalCustomized, true);
  } finally { store.close(); }
});

test('an explicit picker assertion sets the flag even when the value matches the default', () => {
  const store = new Store(':memory:');
  try {
    // The Swift interval picker sends the value plus the flag on user
    // selection, so re-picking 5 minutes (the default) still sticks.
    const saved = store.saveSettings({ autoRefreshIntervalSeconds: 300, autoRefreshIntervalCustomized: true });
    assert.equal(saved.autoRefreshIntervalSeconds, 300);
    assert.equal(saved.autoRefreshIntervalCustomized, true);
  } finally { store.close(); }
});

test('the customized flag persists across daemon restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-settings-'));
  const dbPath = path.join(dir, 'modeldeck.sqlite');
  try {
    const first = new Store(dbPath);
    first.saveSettings({ autoRefreshIntervalSeconds: 600 });
    first.close();

    const second = new Store(dbPath);
    try {
      assert.equal(second.getSettings().autoRefreshIntervalCustomized, true);
      assert.equal(second.getSettings().autoRefreshIntervalSeconds, 600);
    } finally { second.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('flag set + interval back at the default (Tim\'s case): 300s honored under active sessions', async () => {
  const data = fixture({ intervalSeconds: 300, listProviderProcesses: async () => ['claude'] });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    // The reporter's configuration: a deliberate 5-minute interval whose
    // VALUE equals the default. The explicit selection sets the flag; the
    // cap must never apply again.
    data.service.rescheduleAutoRefresh(
      data.store.saveSettings({ autoRefreshIntervalSeconds: 300, autoRefreshIntervalCustomized: true }),
    );
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 1);
    await data.clock.advance(300_000);
    assert.equal(refreshes, 2);
    assert.deepEqual((await data.service.state()).scheduler, {
      pausedForActiveSessions: false,
      configuredRefreshIntervalSeconds: 300,
      effectiveRefreshIntervalSeconds: 300,
      effectiveRefreshReason: null,
    });
  } finally { data.close(); }
});

// Issue #90: the active-session cap only steers the never-customized DEFAULT
// interval (300s). An explicitly configured interval always wins, and
// /api/state reports the effective cadence honestly either way.
test('default interval + active session: cap applies and the state says so honestly', async () => {
  const data = fixture({ intervalSeconds: 300, listProviderProcesses: async () => ['claude'] });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 0);
    assert.deepEqual((await data.service.state()).scheduler, {
      pausedForActiveSessions: true,
      configuredRefreshIntervalSeconds: 300,
      effectiveRefreshIntervalSeconds: 1_800,
      effectiveRefreshReason: 'active-session-cap',
    });

    await data.clock.advance(300_000);
    assert.equal(refreshes, 0);
  } finally { data.close(); }
});

test('default interval + active session still polls at the thirty-minute cap', async () => {
  const data = fixture({ intervalSeconds: 300, listProviderProcesses: async () => ['codex'] });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(30 * 60_000 - 1);
    assert.equal(refreshes, 0);
    await data.clock.advance(1_000);
    assert.equal(refreshes, 1);
    assert.equal((await data.service.state()).scheduler.pausedForActiveSessions, false);
  } finally { data.close(); }
});

test('uncustomized SLOW interval is never accelerated by the cap: report matches reality', async () => {
  // Migration shape: a pre-#90 install persisted 3600s without the
  // provenance flag. The cap must only ever SLOW polling — max(configured,
  // cap) — so the daemon runs 3600s here, and /api/state reports exactly
  // that (CodeRabbit, PR #111: report and scheduler share one function).
  const data = fixture({ intervalSeconds: 300, listProviderProcesses: async () => ['claude'] });
  data.store.db.prepare('UPDATE settings SET value_json = ? WHERE id = 1').run(JSON.stringify({
    autoRefreshEnabled: true, autoRefreshIntervalSeconds: 3_600, pauseWhileActive: true,
  }));
  assert.equal(data.store.getSettings().autoRefreshIntervalCustomized, false);
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 0);
    // The old Math.min(interval, cap) behavior would have refreshed at 30
    // minutes — faster than the configured hour. It must not.
    await data.clock.advance(30 * 60_000);
    assert.equal(refreshes, 0);
    assert.deepEqual((await data.service.state()).scheduler, {
      pausedForActiveSessions: true,
      configuredRefreshIntervalSeconds: 3_600,
      effectiveRefreshIntervalSeconds: 3_600,
      effectiveRefreshReason: null,
    });
    await data.clock.advance(30 * 60_000);
    assert.equal(refreshes, 1);
  } finally { data.close(); }
});

test('customized interval wins over active sessions: cadence honored, no cap, no indicator', async () => {
  let processChecks = 0;
  const data = fixture({
    intervalSeconds: 120,
    listProviderProcesses: async () => { processChecks += 1; return ['claude']; },
  });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 1);
    await data.clock.advance(120_000);
    assert.equal(refreshes, 2);
    // The cap can never apply, so the scheduler does not even probe for
    // provider processes — and never polls faster than configured either.
    assert.equal(processChecks, 0);
    assert.deepEqual((await data.service.state()).scheduler, {
      pausedForActiveSessions: false,
      configuredRefreshIntervalSeconds: 120,
      effectiveRefreshIntervalSeconds: 120,
      effectiveRefreshReason: null,
    });
  } finally { data.close(); }
});

test('customizing the interval mid-pause lifts the cap and clears the indicator immediately', async () => {
  const data = fixture({ intervalSeconds: 300, listProviderProcesses: async () => ['claude'] });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 0);
    assert.equal((await data.service.state()).scheduler.effectiveRefreshReason, 'active-session-cap');

    const settings = data.store.saveSettings({ autoRefreshIntervalSeconds: 120 });
    data.service.rescheduleAutoRefresh(settings);
    assert.deepEqual((await data.service.state()).scheduler, {
      pausedForActiveSessions: false,
      configuredRefreshIntervalSeconds: 120,
      effectiveRefreshIntervalSeconds: 120,
      effectiveRefreshReason: null,
    });
    await data.clock.advance(120_000);
    assert.equal(refreshes, 1);
  } finally { data.close(); }
});

test('auto-refresh disabled reports no effective cadence and no reason', async () => {
  const data = fixture({ enabled: false, intervalSeconds: 300 });
  try {
    data.service.startAutoRefresh();
    assert.deepEqual((await data.service.state()).scheduler, {
      pausedForActiveSessions: false,
      configuredRefreshIntervalSeconds: 300,
      effectiveRefreshIntervalSeconds: null,
      effectiveRefreshReason: null,
    });
  } finally { data.close(); }
});

test('pause setting off preserves normal cadence without listing processes', async () => {
  let processChecks = 0;
  const data = fixture({
    pauseWhileActive: false,
    intervalSeconds: 60,
    listProviderProcesses: async () => { processChecks += 1; return ['claude']; },
  });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    await data.clock.advance(60_000);
    assert.equal(refreshes, 2);
    assert.equal(processChecks, 0);
  } finally { data.close(); }
});

test('pause setting off never caps the default interval either', async () => {
  const data = fixture({
    pauseWhileActive: false,
    intervalSeconds: 300,
    listProviderProcesses: async () => ['claude'],
  });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    await data.clock.advance(300_000);
    assert.equal(refreshes, 2);
    assert.deepEqual((await data.service.state()).scheduler, {
      pausedForActiveSessions: false,
      configuredRefreshIntervalSeconds: 300,
      effectiveRefreshIntervalSeconds: 300,
      effectiveRefreshReason: null,
    });
  } finally { data.close(); }
});

test('manual refresh remains available while scheduled ticks are paused', async () => {
  const data = fixture({ intervalSeconds: 300, listProviderProcesses: async () => ['claude'] });
  let claudePasses = 0;
  let codexPasses = 0;
  data.service.refreshClaude = async () => { claudePasses += 1; return []; };
  data.service.refreshCodex = async () => { codexPasses += 1; return []; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(claudePasses, 0);

    await data.service.refreshAll();
    assert.equal(claudePasses, 1);
    assert.equal(codexPasses, 1);
    assert.equal((await data.service.state()).scheduler.pausedForActiveSessions, true);
  } finally { data.close(); }
});

test('ending an active session waits for the next normal tick without a catch-up burst', async () => {
  let active = true;
  const data = fixture({ intervalSeconds: 300, listProviderProcesses: async () => active ? ['codex'] : [] });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 0);

    active = false;
    await data.clock.advance(299_999);
    assert.equal(refreshes, 0);
    await data.clock.advance(1);
    assert.equal(refreshes, 1);
    assert.equal(data.clock.timers.size, 1);
    const [next] = data.clock.timers.values();
    assert.equal(next.dueAt, data.clock.time + 300_000);
  } finally { data.close(); }
});

test('default process lister filters current-user ps output to exact provider names', async () => {
  const calls = [];
  const store = new Store(':memory:');
  const service = new ModelDeckService(store, {
    exec: async (...args) => {
      calls.push(args);
      return { stdout: '/opt/bin/claude\nclaude-helper\ncodex\nnode\n' };
    },
  });
  try {
    assert.deepEqual(await service.listProviderProcesses(), ['claude', 'codex']);
    assert.equal(calls[0][0], '/bin/ps');
    assert.ok(calls[0][1].includes('-U'));
  } finally { service.stopAutoRefresh(); store.close(); }
});
