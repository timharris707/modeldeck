import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMutationToken } from '../src/token.mjs';

test('explicit token option wins over everything', () => {
  const result = resolveMutationToken({
    token: 'explicit-token',
    env: { MODELDECK_MUTATION_TOKEN: 'env-token' },
    lookup: () => 'keychain-token',
  });
  assert.deepEqual(result, { token: 'explicit-token', source: 'option' });
});

test('MODELDECK_MUTATION_TOKEN env var is the test/CI fallback', () => {
  const result = resolveMutationToken({
    env: { MODELDECK_MUTATION_TOKEN: '  env-token  ' },
    lookup: () => 'keychain-token',
  });
  assert.deepEqual(result, { token: 'env-token', source: 'env' });
});

test('keychain lookup is used when no option or env token is present', () => {
  const result = resolveMutationToken({ env: {}, lookup: () => 'keychain-token' });
  assert.deepEqual(result, { token: 'keychain-token', source: 'keychain' });
});

test('MODELDECK_SKIP_KEYCHAIN=1 bypasses the keychain', () => {
  const result = resolveMutationToken({
    env: { MODELDECK_SKIP_KEYCHAIN: '1' },
    lookup: () => { throw new Error('keychain must not be consulted'); },
  });
  assert.equal(result.source, 'ephemeral');
});

test('falls back to a random ephemeral token when nothing is configured', () => {
  const first = resolveMutationToken({ env: {}, lookup: () => null });
  const second = resolveMutationToken({ env: {}, lookup: () => null });
  assert.equal(first.source, 'ephemeral');
  assert.equal(second.source, 'ephemeral');
  assert.ok(first.token.length >= 32);
  assert.notEqual(first.token, second.token);
});
