import { formatResetTime } from './usage-view.js';

const $ = (selector) => document.querySelector(selector);
let state = { accounts: [], projects: [], usage: [], launches: [] };
let health = {};
let sessionToken = '';

async function api(url, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: options.body ? {
      'Content-Type': 'application/json',
      ...(method !== 'GET' && sessionToken ? { 'X-ModelDeck-Token': sessionToken } : {}),
      ...(options.headers || {}),
    } : options.headers,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 4200);
}

function usageFor(accountId) {
  return state.usage.filter((entry) => entry.accountId === accountId);
}

function renderAlerts() {
  const target = $('#capacity-alerts');
  if (!state.usage.length) {
    target.innerHTML = '<div class="capacity-alert unknown">No usage snapshots yet. Refresh manually when provider testing is safe.</div>';
    return;
  }
  const accountById = new Map(state.accounts.map((account) => [account.id, account]));
  const low = state.usage
    .filter((entry) => Number(entry.remainingPercent) <= 25)
    .sort((a, b) => a.remainingPercent - b.remainingPercent);
  const stale = state.usage.filter((entry) => Date.now() - Date.parse(entry.observedAt) > 15 * 60_000);
  if (low.length) {
    target.innerHTML = low.slice(0, 4).map((entry) => `<div class="capacity-alert critical"><strong>${esc(accountById.get(entry.accountId)?.label || 'Profile')}</strong> · ${esc(entry.scope)} · ${Math.round(entry.remainingPercent)}% remaining. Warn the active builder before spawning more work.</div>`).join('');
  } else if (stale.length) {
    const profiles = [...new Set(stale.map((entry) => accountById.get(entry.accountId)?.label || 'Profile'))];
    target.innerHTML = `<div class="capacity-alert stale">Usage data is older than 15 minutes for ${esc(profiles.join(', '))}. Refresh manually when it will not interrupt an active run.</div>`;
  } else {
    target.innerHTML = '<div class="capacity-alert">Capacity snapshots are fresh and above the 25% remaining warning threshold.</div>';
  }
}

function renderStats() {
  const mapped = state.projects.filter((project) => project.claudeAccountId || project.codexAccountId).length;
  const fable = state.usage.filter((entry) => entry.scope.toLowerCase().includes('fable'));
  const fableRemaining = fable.length ? Math.round(Math.max(...fable.map((entry) => entry.remainingPercent ?? 0))) : '—';
  $('#hero-stats').innerHTML = [
    [state.accounts.length, 'Profiles registered'],
    [state.projects.length, 'Projects discovered'],
    [mapped, 'Projects mapped'],
    [fableRemaining === '—' ? '—' : `${fableRemaining}%`, 'Best Fable remaining'],
  ].map(([value, label]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
}

function usageRows(accountId) {
  const usage = usageFor(accountId);
  if (!usage.length) return '<div class="empty">No usage snapshot yet</div>';
  return usage.map((entry) => {
    const percent = entry.usedPercent == null ? 0 : Math.max(0, Math.min(100, entry.usedPercent));
    const remaining = 100 - percent;
    const severity = remaining <= 10 ? ' critical' : remaining <= 25 ? ' warning' : '';
    const isFable = entry.scope.toLowerCase().includes('fable');
    const resetTime = formatResetTime(entry.resetsAt);
    const reset = resetTime ? `Resets ${resetTime}` : 'Reset time unavailable';
    return `<div class="usage-row${isFable ? ' fable' : ''}${severity}" title="${esc(entry.scope)} · ${esc(reset)}"><span class="usage-label">${esc(entry.scope)}</span><div class="bar"><span style="width:${percent}%"></span></div><span class="usage-pct">${Math.round(percent)}%</span><span class="usage-reset">${esc(reset)}</span></div>`;
  }).join('');
}

function primaryMeter(account) {
  const usage = usageFor(account.id);
  if (!usage.length) return null;
  if (account.provider === 'claude') {
    const fable = usage.find((entry) => entry.scope.toLowerCase().includes('fable'));
    if (fable) return fable;
  }
  return [...usage].sort((a, b) => (a.remainingPercent ?? 101) - (b.remainingPercent ?? 101))[0];
}

function providerSummaryCard(provider) {
  const accounts = state.accounts.filter((account) => account.provider === provider);
  if (!accounts.length) return '';
  const meters = accounts.map((account) => ({ account, meter: primaryMeter(account) })).filter((item) => item.meter);
  const lowest = meters.sort((a, b) => (a.meter.remainingPercent ?? 101) - (b.meter.remainingPercent ?? 101))[0] || null;
  const remaining = lowest?.meter.remainingPercent == null ? null : Math.round(lowest.meter.remainingPercent);
  const warningCount = meters.filter((item) => Number(item.meter.remainingPercent) <= 25).length;
  const severity = remaining == null ? '' : remaining <= 10 ? ' critical' : remaining <= 25 ? ' warning' : '';
  const meterColor = remaining == null ? '#59616e' : remaining <= 10 ? 'var(--danger)' : remaining <= 25 ? 'var(--amber)' : 'var(--green)';
  const dots = accounts.map((account) => `<i style="--dot:${esc(account.color)}" title="${esc(account.label)}"></i>`).join('');
  return `<button type="button" class="provider-summary${severity}" data-provider-details="${provider}" style="--remaining:${remaining ?? 0};--meter-color:${meterColor}">
    <span class="provider-summary-icon ${provider}">${provider === 'claude' ? 'C' : 'X'}</span>
    <span class="provider-summary-copy"><strong>${provider === 'claude' ? 'Claude' : 'Codex'}</strong><span>${accounts.length} accounts · ${warningCount ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : 'all healthy'}</span><small>${lowest ? `Lowest: ${esc(lowest.account.label)} · ${esc(lowest.meter.scope)}` : 'No usage snapshots'}</small><span class="provider-dots">${dots}</span></span>
    <span class="quick-ring"><strong>${remaining == null ? '—' : `${remaining}%`}</strong></span>
    <span class="provider-chevron">›</span>
  </button>`;
}

function renderQuickDeck() {
  const cards = ['claude', 'codex'].map(providerSummaryCard).filter(Boolean);
  $('#quick-deck').innerHTML = cards.length ? cards.join('') : '<div class="empty quick-empty">Add an account to create its provider meter.</div>';
}

function providerAccountDetail(account) {
  return `<div class="provider-account-detail" style="--account-color:${esc(account.color)}">
    <div class="account-head"><div><div class="account-name"><i></i>${esc(account.label)}</div><p class="account-identity">${esc(account.identity || 'Identity not configured')}</p><p class="account-purpose">${esc(account.purpose || account.profileRef)}</p></div>${account.isDefault ? '<span class="pill">Default</span>' : ''}</div>
    <div class="usage-grid">${usageRows(account.id)}</div>
  </div>`;
}

function accountCard(account) {
  return `<div class="account-card" style="--account-color:${esc(account.color)}">
    <div class="account-head"><div><div class="account-name"><i></i>${esc(account.label)}</div><p class="account-identity">${esc(account.identity || 'Identity not configured')}</p><p class="account-purpose">${esc(account.purpose || account.profileRef)}</p></div>${account.isDefault ? '<span class="pill">Default</span>' : ''}</div>
    <div class="usage-grid">${usageRows(account.id)}</div>
    <div class="card-actions">
      ${account.isDefault ? '' : `<button class="button ghost small" data-default="${account.id}">Set default</button>`}
      <button class="button ghost small danger" data-delete="${account.id}">Remove</button>
    </div>
  </div>`;
}

function renderAccounts() {
  for (const provider of ['claude', 'codex']) {
    const accounts = state.accounts.filter((account) => account.provider === provider);
    $(`#${provider}-accounts`).innerHTML = accounts.length ? accounts.map(accountCard).join('') : `<div class="empty">No ${provider === 'claude' ? 'Claude' : 'Codex'} profiles registered</div>`;
  }
}

function options(provider, selected) {
  const accounts = state.accounts.filter((account) => account.provider === provider && account.enabled);
  return `<option value="">Use provider default</option>${accounts.map((account) => `<option value="${account.id}"${selected === account.id ? ' selected' : ''}>${esc(account.label)}</option>`).join('')}`;
}

function projectRow(project) {
  return `<div class="project-row" data-project="${project.id}">
    <div class="project-name"><strong>${esc(project.name)}</strong><span>${esc(project.path)}</span></div>
    <input name="purpose" value="${esc(project.purpose)}" placeholder="Business / personal">
    <select name="claudeAccountId" aria-label="Claude profile for ${esc(project.name)}">${options('claude', project.claudeAccountId)}</select>
    <select name="codexAccountId" aria-label="Codex profile for ${esc(project.name)}">${options('codex', project.codexAccountId)}</select>
    <div class="launch-buttons">
      <button class="button ghost small" data-save="${project.id}">Save</button>
      <button class="button secondary small" data-launch="claude" data-project-path="${esc(project.path)}">Claude</button>
      <button class="button secondary small" data-launch="codex" data-project-path="${esc(project.path)}">Codex</button>
    </div>
  </div>`;
}

function renderProjects() {
  $('#projects-root').textContent = health.projectsRoot || '~/projects';
  $('#projects-list').innerHTML = state.projects.length ? state.projects.map(projectRow).join('') : '<div class="empty">No projects discovered. Scan your projects directory to begin.</div>';
}

function renderActivity() {
  $('#activity-list').innerHTML = state.launches.length ? state.launches.map((entry) => `<div class="activity"><strong>${esc(entry.provider)}</strong><code>${esc(entry.commandPreview)}</code><time>${new Date(entry.launchedAt).toLocaleString()}</time></div>`).join('') : '<div class="empty">Launches made through the ModelDeck CLI will appear here.</div>';
}

function openProviderDetails(provider) {
  const accounts = state.accounts.filter((account) => account.provider === provider);
  if (!accounts.length) return;
  $('#provider-detail-eyebrow').textContent = `${provider.toUpperCase()} ACCOUNT DECK`;
  $('#provider-detail-label').textContent = `${provider === 'claude' ? 'Claude' : 'Codex'} · ${accounts.length} accounts`;
  $('#provider-detail-copy').textContent = provider === 'claude' ? 'Claude Code and Fable capacity by identity' : 'Codex CLI capacity by identity';
  $('#provider-detail-accounts').innerHTML = accounts.map(providerAccountDetail).join('');
  $('#provider-detail-dialog').showModal();
}

function render() {
  renderStats();
  renderAlerts();
  renderQuickDeck();
  renderAccounts();
  renderProjects();
  renderActivity();
}

async function reload() {
  [health, state] = await Promise.all([api('/api/health'), api('/api/state')]);
  render();
}

async function initialLoad() {
  sessionToken = (await api('/api/session')).token;
  await reload();
  if (!state.projects.length) {
    try { await api('/api/scan', { method: 'POST', body: '{}' }); await reload(); }
    catch (error) { toast(error.message, true); }
  }
}

$('#scan-projects').addEventListener('click', async () => {
  try {
    const result = await api('/api/scan', { method: 'POST', body: '{}' });
    await reload();
    toast(`Found ${result.projects.length} projects.`);
  } catch (error) { toast(error.message, true); }
});

$('#refresh-usage').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Refreshing…';
  try {
    const result = await api('/api/refresh', { method: 'POST', body: '{}' });
    await reload();
    const errors = [result.claude, ...(result.codex?.profiles || [])].filter((item) => item && !item.ok).map((item) => item.error).filter(Boolean);
    toast(errors.length ? `Refresh completed with warnings: ${errors.join(' · ')}` : 'Usage refreshed.', Boolean(errors.length));
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Refresh usage'; }
});

$('#add-account').addEventListener('click', () => $('#account-dialog').showModal());
$('#add-account-quick').addEventListener('click', () => $('#account-dialog').showModal());
$('#account-form [name="provider"]').addEventListener('change', (event) => {
  const codex = event.target.value === 'codex';
  const input = $('#account-form [name="profileRef"]');
  $('#profile-label').textContent = codex ? 'CODEX_HOME directory' : 'Managed automatically';
  input.placeholder = codex ? '/Users/you/.codex-profiles/work' : 'Created under ModelDeck Application Support';
  input.required = codex;
  input.disabled = !codex;
});
$('#account-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify({
      provider: data.get('provider'),
      label: data.get('label'),
      identity: data.get('identity'),
      purpose: data.get('purpose'),
      profileRef: data.get('profileRef') || undefined,
      isDefault: data.get('isDefault') === 'on',
    }) });
    event.currentTarget.reset();
    $('#account-dialog').close();
    await reload();
    toast('Profile added. No credentials were stored.');
  } catch (error) { toast(error.message, true); }
});

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-default], [data-delete], [data-save], [data-launch], [data-provider-details]');
  if (!action) return;
  const { default: defaultId, delete: deleteId, save: saveId, launch: launchProvider, providerDetails } = action.dataset;
  try {
    if (providerDetails) {
      openProviderDetails(providerDetails);
    } else if (defaultId) {
      await api(`/api/accounts/${encodeURIComponent(defaultId)}/default`, { method: 'POST', body: '{}' });
      await reload();
      toast('Default profile changed for new launches.');
    } else if (deleteId) {
      const account = state.accounts.find((item) => item.id === deleteId);
      if (!account || !window.confirm(`Remove ${account.label} (${account.profileRef}) from ModelDeck? Provider credentials and profile files will not be deleted.`)) return;
      await api(`/api/accounts/${encodeURIComponent(deleteId)}`, { method: 'DELETE', body: '{}' });
      await reload();
      toast('Profile reference removed. Provider credentials were untouched.');
    } else if (saveId) {
      const row = action.closest('.project-row');
      await api(`/api/projects/${encodeURIComponent(saveId)}`, { method: 'PUT', body: JSON.stringify({
        purpose: row.querySelector('[name="purpose"]').value,
        claudeAccountId: row.querySelector('[name="claudeAccountId"]').value || null,
        codexAccountId: row.querySelector('[name="codexAccountId"]').value || null,
      }) });
      await reload();
      toast('Project mapping saved.');
    } else if (launchProvider) {
      const result = await api(`/api/launch?provider=${encodeURIComponent(launchProvider)}&project=${encodeURIComponent(action.dataset.projectPath)}`);
      $('#command-context').textContent = `${result.project?.name || 'Project'} → ${result.account.label}`;
      $('#command-preview').textContent = result.command;
      $('#command-dialog').showModal();
    }
  } catch (error) { toast(error.message, true); }
});

$('#copy-command').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#command-preview').textContent);
  toast('Launch command copied.');
});

initialLoad().catch((error) => toast(error.message, true));
