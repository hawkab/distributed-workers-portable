# Portable worker release CI

`portable_release.py` extends the unchanged shared `fleetci.py` publisher.
GitFlic builds canonical bytes; Gitea/GitHub independently verify and mirror them.
The public ZIP and manifest are `fleet-worker-portable.zip` and
`portable-manifest.json`. `ci/version.json` and runtime `VERSION.json` must match;
version 0.4.0 has monotonic code1. The source checkout must equal its immutable tag.

The unprivileged `portable_unsigned` job runs Python publisher tests and actual
Node/PHP runtime tests, then packages selected exact Git blobs in a deterministic
ZIP. It needs Node24+, native PHP8.2+ with required curl/intl modules, Python3 and
OpenSSL in the generic `FLEET_CI_IMAGE`. `PHP_BINARY` selects native PHP for the
fixture harness; local tests may use cached official Docker images instead.
A host Docker socket must not be mounted in CI. No signing key is available to
this build job. Test logs and unsigned metadata are retained as native artifacts.

The separate protected `fleetsigning` job receives `dist/unsigned`. It does not
execute worker code/tests or run package hooks: it inspects the ZIP without
extraction, compares members/modes/bytes with the exact tag, checks safe public
configuration and known-secret absence, then signs with read-only
`/run/fleet-signing/release-signing.pem`. The pinned public key is
`assets/release-public.der`. The manifest signs UTF-8, each field followed by LF:

```text
component\nversion_code\nversion_name\nurl\nsha256\n
```

The component is `worker-portable`; algorithm is `SHA256withRSA`. The canonical
URL is the immutable public GitHub URL
`https://github.com/hawkab/distributed-workers-portable/releases/download/<tag>/fleet-worker-portable.zip`.
Mirrors never rewrite it. Public packages use only the safe example release
chain. Actual gateway/Gitea endpoints and credentials are runtime-private files,
never signing/build inputs or public assets.

Common publishing uploads the canonical ZIP first and deterministic
`release-metadata.zip` last as the GitFlic ready marker. The metadata archive
contains the original signed manifest, checksums and source-bound release record.
Mirrors read the public canonical release, verify tag/commit/member hashes plus
pinned RSA/ZIP/source checks, then attach identical bytes. They have no private
signing keys. Existing equal assets are reused; conflicts never overwrite tags
or assets. Uncertain writes are reconciled before retry, without attempt caps.

After anonymous canonical verification the signer pushes a GPG-signed
`release-channel` commit. Its `stable.json` has `archive_url`, `manifest_url`,
`canonical_record_url`, tag, source_commit, version_code and sha256. Versioned raw
metadata uses `commit=release-channel`; `branch=` does not select that ref on
GitFlic. Both raw files are anonymously checked after push. A newer version is
never replaced by an older one, and equal-version hash conflicts stop publishing.
`FLEET_GPG_PRIVATE_KEY_FILE` points to the isolated release-bot key, imported into
an ephemeral GPG home. No user's SSH/GPG home or main project queue is used.

Entrypoints are `gitflic-ci.yaml`, `.gitea/workflows/release.yml` and
`.github/workflows/release.yml`. Mirrors need only Python3/OpenSSL. Existing
version tags can be retried using native dispatch; `--once` returns75 for a
pending nonblocking operator check. Actual native workflow receipts, public
asset equality and runtime acceptance remain separate from YAML/unit checks.
