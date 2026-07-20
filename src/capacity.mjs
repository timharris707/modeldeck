// Issue #28 (Tim's call, overrides mockups): the `spend` scope is the least
// important signal for subscription users, so it never drives worst-capacity
// (icon severity / headline). It only counts when no other scope exists.
export function isSpendScope(scope) {
  return String(scope ?? '').toLowerCase().includes('spend');
}

export function evaluateCapacity(usage, accounts, options = {}) {
  const threshold = Number(options.threshold ?? 25);
  const maxAgeMinutes = Number(options.maxAgeMinutes ?? 15);
  const now = Number(options.now ?? Date.now());
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const rows = usage.map((entry) => {
    const observed = Date.parse(entry.observedAt || 0);
    const ageMinutes = Number.isFinite(observed) ? Math.max(0, (now - observed) / 60_000) : Infinity;
    return {
      ...entry,
      accountLabel: accountById.get(entry.accountId)?.label || 'Unknown profile',
      ageMinutes,
      low: Number(entry.remainingPercent) <= threshold,
      stale: ageMinutes > maxAgeMinutes,
    };
  });
  const low = rows.filter((row) => row.low).sort((a, b) => a.remainingPercent - b.remainingPercent);
  const stale = rows.filter((row) => row.stale).sort((a, b) => b.ageMinutes - a.ageMinutes);
  return {
    status: !rows.length ? 'unknown' : low.length ? 'critical' : stale.length ? 'stale' : 'ok',
    threshold,
    maxAgeMinutes,
    checkedAt: new Date(now).toISOString(),
    low,
    stale,
  };
}

export function evaluateWorstCapacity(usage, accounts, options = {}) {
  const thresholdPercent = Number(options.thresholdPercent ?? 25);
  const criticalPercent = Number(options.criticalPercent ?? 10);
  const now = Number(options.now ?? Date.now());
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const excluded = [];
  const rows = [];
  let hasNonSpendScope = false;

  for (const entry of usage) {
    const account = accountById.get(entry.accountId);
    if (!account || !account.enabled) {
      excluded.push({ accountId: entry.accountId, scope: entry.scope, reason: account ? 'account disabled' : 'account not found' });
      continue;
    }
    if (!isSpendScope(entry.scope)) hasNonSpendScope = true;
    if (entry.usedPercent == null) {
      excluded.push({ accountId: entry.accountId, scope: entry.scope, reason: 'usage unavailable' });
      continue;
    }
    rows.push({
      accountId: account.id,
      accountLabel: account.label,
      provider: account.provider,
      scope: entry.scope,
      remainingPercent: entry.remainingPercent == null ? Math.max(0, 100 - Number(entry.usedPercent)) : Number(entry.remainingPercent),
      resetsAt: entry.resetsAt || null,
      observedAt: entry.observedAt,
    });
  }

  // Issue #28: spend never wins worst-capacity; it is evaluated only as a
  // fallback when every non-spend scope is absent.
  const rateLimitRows = rows.filter((row) => !isSpendScope(row.scope));
  // A non-spend scope with unavailable usage must still keep spend from
  // seizing worst — fall back to spend only when no non-spend scope exists.
  const candidates = hasNonSpendScope ? rateLimitRows : rows;
  if (hasNonSpendScope) {
    for (const row of rows.filter((item) => isSpendScope(item.scope))) {
      excluded.push({ accountId: row.accountId, scope: row.scope, reason: 'spend scope deprioritized' });
    }
  }

  candidates.sort((a, b) => a.remainingPercent - b.remainingPercent);
  const worst = candidates[0] || null;
  const status = !worst ? 'unknown' : worst.remainingPercent <= criticalPercent ? 'critical' : worst.remainingPercent <= thresholdPercent ? 'warn' : 'ok';
  return {
    status,
    iconState: status === 'critical' ? 'red' : status === 'warn' ? 'gold' : 'plain',
    worst,
    thresholdPercent,
    criticalPercent,
    notify: Boolean(worst && worst.remainingPercent <= thresholdPercent),
    accountsEvaluated: new Set(candidates.map((row) => row.accountId)).size,
    windowsEvaluated: candidates.length,
    excluded,
    checkedAt: new Date(now).toISOString(),
  };
}
