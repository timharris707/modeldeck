import test from 'node:test';
import assert from 'node:assert/strict';
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

test('active provider sessions skip scheduled ticks and surface the pause', async () => {
  const data = fixture({ listProviderProcesses: async () => ['claude'] });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 0);
    assert.deepEqual((await data.service.state()).scheduler, { pausedForActiveSessions: true });

    await data.clock.advance(60_000);
    assert.equal(refreshes, 0);
  } finally { data.close(); }
});

test('active-session throttle still polls at the thirty-minute cap', async () => {
  const data = fixture({ intervalSeconds: 3_600, listProviderProcesses: async () => ['codex'] });
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

test('pause setting off preserves normal cadence without listing processes', async () => {
  let processChecks = 0;
  const data = fixture({
    pauseWhileActive: false,
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

test('manual refresh remains available while scheduled ticks are paused', async () => {
  const data = fixture({ listProviderProcesses: async () => ['claude'] });
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
  const data = fixture({ listProviderProcesses: async () => active ? ['codex'] : [] });
  let refreshes = 0;
  data.service.refreshAll = async () => { refreshes += 1; };
  try {
    data.service.startAutoRefresh();
    await data.clock.advance(100);
    assert.equal(refreshes, 0);

    active = false;
    await data.clock.advance(59_999);
    assert.equal(refreshes, 0);
    await data.clock.advance(1);
    assert.equal(refreshes, 1);
    assert.equal(data.clock.timers.size, 1);
    const [next] = data.clock.timers.values();
    assert.equal(next.dueAt, data.clock.time + 60_000);
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
