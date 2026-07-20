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

function fixture({ enabled = true, intervalSeconds = 60, initialDelayMs = 100 } = {}) {
  const store = new Store(':memory:');
  store.saveSettings({
    autoRefreshEnabled: enabled,
    autoRefreshIntervalSeconds: intervalSeconds,
  });
  const clock = new FakeClock();
  const service = new ModelDeckService(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    autoRefreshInitialDelayMs: initialDelayMs,
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
