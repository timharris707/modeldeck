// Issue #8 — shared helpers for the add-account flow's step 3 ("read back
// authenticated identity"). The provider CLIs own the login; ModelDeck only
// reads the status output that the provider chooses to print. Nothing here
// reads credential files or tokens.

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IDENTITY_KEYS = ['email', 'identity', 'account', 'user', 'login', 'signedInAs', 'signed_in_as'];

function fromJson(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') return value.match(EMAIL_PATTERN)?.[0] || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = fromJson(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of IDENTITY_KEYS) {
    if (key in value) {
      const found = fromJson(value[key], depth + 1);
      if (found) return found;
    }
  }
  for (const item of Object.values(value)) {
    const found = fromJson(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/// Best-effort identity extraction from a provider status command's output:
/// prefers well-known JSON fields, falls back to the first email-shaped token
/// in plain text, returns null when the provider doesn't reveal an identity.
export function extractIdentity(output) {
  const text = String(output ?? '').trim();
  if (!text) return null;
  try {
    return fromJson(JSON.parse(text));
  } catch {
    return text.match(EMAIL_PATTERN)?.[0] || null;
  }
}
