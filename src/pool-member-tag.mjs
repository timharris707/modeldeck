// Issue #827: one-way tag that pairs a remote Mac's account with the pool
// hub's record of the same subscription without sending the identity.
// The hub page and the remote daemon both import this, so they always agree.
// Claude identity: the account email, lowercased. Codex: the remembered
// `tokens.account_id`. Display names differ between Macs and are never used.
import { createHash } from 'node:crypto';

export const POOL_MEMBER_TAG_LENGTH = 24;

/// The only credential detail a remote Mac shows for a hub member, so the
/// proxy's own status text (which can carry tokens, ids or paths) never
/// leaves the hub. The deck needs just two facts from it.
export const POOL_OVERLOADED_DETAIL = 'provider overloaded';
export function poolCredentialDetail(credential, detail) {
  if (typeof detail !== 'string' || !detail.trim()) return null;
  if (credential === 'resting') {
    // The proxy's retry time, which the deck shows as "back at <time>".
    const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(detail) ? Date.parse(detail) : NaN;
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  if (credential === 'error') {
    // Same rule as the deck's ProxyRelogin.detailIsProviderOverload.
    const lower = detail.toLowerCase();
    if (lower.includes('invalid_grant') || lower.includes('refresh token')) return null;
    return /overloaded|service_unavailable|try again later/.test(lower) ? POOL_OVERLOADED_DETAIL : null;
  }
  return null;
}

/** The tag for one provider identity, or null when there is no identity. */
export function poolMemberTag(provider, identity) {
  const value = typeof identity === 'string'
    ? (provider === 'claude' ? identity.trim().toLowerCase() : identity.trim())
    : '';
  if (!value || (provider !== 'claude' && provider !== 'codex')) return null;
  return createHash('sha256')
    .update(`modeldeck-pool-member-v1\n${provider}\n${value}`)
    .digest('hex')
    .slice(0, POOL_MEMBER_TAG_LENGTH);
}
