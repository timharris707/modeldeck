// #808: `modeldeck signin <account>` for a box with no desktop. It asks the
// running daemon for the provider's own sign-in command, runs it in this
// terminal (the provider prints a URL or a device code to finish on another
// machine), then asks the daemon to verify. ModelDeck never sees, writes or
// copies the sign-in (decisions 0014, 0016). Mirrors the Mac app's sheet:
// when the daemon says the account must be active for the login, the
// previously active account is restored afterwards.
import { spawn } from 'node:child_process';

/// Runs the provider's command in this terminal. The provider never inherits
/// the mutation token, and Ctrl-C stops only the provider, so the previous
/// account is still switched back (Codex review of #813).
export function runInTerminal(shellCommand, { env = process.env, spawnImpl = spawn, signals = process } = {}) {
  const { MODELDECK_MUTATION_TOKEN: _token, ...childEnv } = env;
  return new Promise((resolve, reject) => {
    const ignore = () => {};
    signals.on('SIGINT', ignore);
    const child = spawnImpl('/bin/sh', ['-c', shellCommand], { stdio: 'inherit', env: childEnv });
    child.on('error', (error) => { signals.off('SIGINT', ignore); reject(error); });
    child.on('exit', (code, signal) => { signals.off('SIGINT', ignore); resolve(signal ? 1 : code); });
  });
}

/// The headers a daemon mutation needs: the token twice (header and cookie)
/// and a loopback Origin. Never logged.
export function mutationHeaders(token, daemonUrl) {
  const origin = new URL(daemonUrl).origin;
  return {
    'x-modeldeck-token': token,
    Cookie: `modeldeck_session=${encodeURIComponent(token)}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

/// One account by id, or by label (case-insensitive) when exactly one matches.
export function findAccount(accounts, ref) {
  const byId = accounts.find((account) => account.id === ref);
  if (byId) return byId;
  const wanted = String(ref).trim().toLowerCase();
  const matches = accounts.filter((account) => account.label?.trim().toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  const known = accounts.map((account) => `${account.label} (${account.provider}, ${account.id})`).join('\n  ');
  if (matches.length > 1) throw new Error(`more than one account is labelled "${ref}"; use its id:\n  ${known}`);
  throw new Error(`no account "${ref}". Accounts:\n  ${known || '(none)'}`);
}

/// #811: add an account through the running daemon. A second account of a
/// provider needs ModelDeck to manage that provider's home; that move only
/// happens with `manage`, after the daemon says it is needed.
export async function addAccount(provider, label, { daemonUrl, token, manage = false, fetchImpl = fetch, out = console.log }) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('provider must be claude or codex');
  if (!label?.trim()) throw new Error('an account label is required');
  const response = await fetchImpl(new URL('/api/accounts', daemonUrl), {
    method: 'POST',
    redirect: 'error',
    headers: mutationHeaders(token, daemonUrl),
    body: JSON.stringify({ provider, label, ...(manage ? { manageProvider: true } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409 && data.code === 'manage-required') {
    out(`A second ${provider} account needs ModelDeck to manage ~/.${provider}: it moves that folder into ModelDeck's profiles and leaves a link in its place, so the current sign-in keeps working as the first account. Run again with --manage to do that.`);
    return 1;
  }
  if (!response.ok) throw new Error(`POST /api/accounts: ${data.error || response.status}`);
  out(`Added ${data.account.label} (${provider}, ${data.account.id}). Sign it in with: modeldeck signin ${data.account.id}`);
  return 0;
}

export async function signin(ref, {
  daemonUrl, token, fetchImpl = fetch, run, out = console.log,
}) {
  const call = async (method, pathname, body) => {
    // A redirect would resend the token header elsewhere (Codex review of #813).
    const response = await fetchImpl(new URL(pathname, daemonUrl), {
      method,
      redirect: 'error',
      headers: method === 'GET' ? {} : mutationHeaders(token, daemonUrl),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${pathname}: ${data.error || response.status}`);
    return data;
  };
  const state = await call('GET', '/api/state');
  const account = findAccount(state.accounts ?? [], ref);
  const id = encodeURIComponent(account.id);
  const spec = await call('GET', `/api/accounts/${id}/login?headless=1`);

  let prior = null;
  let restoreFailed = false;
  if (spec.requiresActivation) {
    const active = state.activation?.[account.provider]?.resolvedProfileRef;
    prior = (state.accounts ?? []).find((other) => other.provider === account.provider
      && other.id !== account.id && active && other.profileRef === active) ?? null;
  }
  let verification;
  let code;
  try {
    // Inside the try: activation can fail after the daemon switched profiles.
    if (spec.requiresActivation) await call('POST', `/api/accounts/${id}/activate`);
    out(`Signing in ${account.label} (${account.provider}). Finish the sign-in in your browser when the provider asks.`);
    out(`$ ${spec.command}`);
    code = await run(spec.command);
    if (code !== 0) out(`The sign-in command exited with ${code}; checking anyway.`);
    verification = await call('POST', `/api/accounts/${id}/verify`);
  } finally {
    if (prior) {
      try {
        await call('POST', `/api/accounts/${encodeURIComponent(prior.id)}/activate`);
      } catch (error) {
        restoreFailed = true;
        out(`Could not switch back to ${prior.label}: ${error.message}. Activate it again before starting new sessions.`);
      }
    }
  }
  if (verification.identityMismatch) {
    const { expected, actual } = verification.identityMismatch;
    out(`Signed in as ${actual}, but this account is ${expected}. Nothing was recorded; sign in again with ${expected}.`);
    return 1;
  }
  if (verification.authenticated && code !== 0) {
    out('The sign-in command failed, so this is still the earlier sign-in. Run the command again to sign in afresh.');
    return 1;
  }
  if (verification.authenticated) {
    out(`Signed in as ${verification.identity ?? verification.account?.identity ?? 'an unnamed account'}.`);
    return restoreFailed ? 1 : 0;
  }
  out(verification.verifyHint || verification.error || 'Not signed in yet. Run the command again to retry.');
  return 1;
}
