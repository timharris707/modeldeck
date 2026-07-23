# Sparkle test fixtures (issue #121)

`TEST_ed25519_private_key.txt` is a CLEARLY FAKE placeholder used only to
exercise the `--key-file` plumbing of `scripts/generate-appcast.mjs` in tests
(with a stubbed `sign_update`). It is not a valid EdDSA key and can sign
nothing. The real private key exists only in Tim's login Keychain, written by
Sparkle's one-time `generate_keys` run — never in this repository.
