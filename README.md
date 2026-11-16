# Portable worker

Node.js 24+ runs on Linux, Windows and supported CPU architectures. PHP 8.2+ is a CLI/cron adapter for shared hosting. Both implement `sha256`, `http.request` and streamed binary artifacts. The common text operation uses NFC and Android’s exact whitespace/space-character union; U+0085/U+FEFF remain literal. Both compute operations require a string `input.text`. Node implements `text.normalize`; PHP advertises it only when `intl` is installed. PHP does not advertise JavaScript.

Use one backend and a private state directory per installation. A device/enrollment token is enough for a new installation: the first connection assigns a stable server ID and durably saves it before any heartbeat, claim or completion. Existing device tokens retain their IDs; an existing `worker_id` remains supported. Retrying a connection with the same token recovers the same identity after a lost response. Changing identity while local work is pending is refused and preserves its state. Keep the device token and all deployment addresses in an owner-readable configuration outside this repository.

```json
{
  "gateway": "https://gateway.example.invalid",
  "token": "configure-privately",
  "state_directory": "/var/lib/portable-worker",
  "trusted_javascript": false,
  "chunk_bytes": 262144,
  "update_poll_seconds": 900
}
```

Connections, worker heartbeats and claims carry `X-Worker-Profile`, a base64url JSON header with schema 1, exact advertised capabilities and numeric resource fields. CPU availability applies visible affinity/cgroup quotas; RAM applies visible cgroup/runtime limits, including Node's actual V8 heap headroom and PHP `memory_limit`. Disk space describes the state directory's filesystem. GPU VRAM is reported where Linux DRM exposes it; compute units and unified memory remain `null` when unknown. CUDA core counts are not inferred from GPU models. An unavailable GPU probe reports `unknown`, not `none`. Discovery failures leave nullable values and do not prevent ordinary work. Profiles contain no hostnames, models or serial numbers. Devices use only their own token; administrative enrollment creation and other workers' data are outside this runtime.

Start Node with `node node/bootstrap.mjs /private/worker.local.json`. On shared hosting, schedule `php php/bootstrap.php /private/worker.local.json --once` using the provider's cron. The PHP runtime needs `curl`, `openssl`, `zlib` and `Phar`; `intl` is optional. A provider's actual wall-time allowance may be supplied as `host_window_seconds`. It is a resumable execution window, not a task deadline. PHP's `max_execution_time` has platform-dependent CPU/wall-time semantics; do not assume it describes the hosting provider's cron limit.

The bootstrap selects the last verified installed version. A Node child exit 75 reloads that version. PHP cron loads it at the next invocation; a PHP daemon supervisor should restart exit 75. A service supervisor must allow healthy long jobs to drain or retain their durable state rather than impose an unrelated startup/job timeout.

`trusted_javascript: true` adds `javascript` and `javascript.portable.v1`. A task uses synchronous ES5.1 `run(input, resume, ctx)`. `ctx.progress`, `ctx.checkpoint` and `ctx.http.request` are synchronous host calls; legacy global `progress` and `checkpoint` work as well. The Node task process receives no worker token/config/environment. It uses a separate process and Node permissions as protection against accidental access. **Node `vm` and Node permissions are not security boundaries for hostile code.** Enable this capability only for trusted operator code; use a separate OS account/container with its own restrictions for stronger isolation. See the [Node security guidance](https://nodejs.org/api/permissions.html).

A declarative HTTP task and `ctx.http.request` share this object:

```json
{
  "effect_id": "download-document",
  "url": "https://example.org/document.pdf",
  "method": "GET",
  "replay": "safe",
  "response": {"mode": "artifact", "name": "document.pdf"}
}
```

`body_text` is supported; `body_artifact_id` is not advertised in this version. Response header names are lowercase and every value is a string array, retaining duplicate headers. Responses contain status, headers, final URL and a sealed `{artifact_id,length,sha256,media_type,name}` reference. `text`/`json` inline modes require an explicit `max_bytes`. When the encoded completion exceeds the gateway’s actual 16 MiB JSON budget, HTTP inline views fall back to their full source artifact; other computed results stream into a JSON artifact with `result_format: "json"`. Both expose `control_budget_exceeded`. Overflow, invalid UTF-8 or invalid JSON return the **full** artifact and a `body_error`, without truncation. HTTP error responses remain inspectable HTTP results.

Source entity bytes are preserved after transfer framing and before content decoding. Default source headers are `Accept: */*`, `Accept-Encoding: identity`, `User-Agent: DistributedWorker/1`. Explicit compressed responses retain their compressed bytes and `Content-Encoding`.

Network restrictions can be set in the worker config and in `job.network`: `origins`, `methods`, `request_headers`, `response_modes`. Restrictions intersect. A missing dimension is unrestricted; `[]` denies it. Redirects recheck restrictions. Cross-origin redirects remove caller headers except Accept, Accept-Encoding, User-Agent and Content-Type, and are followed only when the resulting method is GET/HEAD. Unsafe cross-origin redirects return the original response for an explicit new request/effect. Rewrites to GET remove entity headers. `redirect: "manual"` returns the original response. Optional `timeouts.connect_ms` and `timeouts.read_idle_ms` control connection setup and actual source-read inactivity, with zero disabling the framework timer. Deliberate gateway backpressure is excluded from source idle time. Redirect cycles return their response; no fixed redirect-attempt budget terminates legitimate chains.

Before any vendor HTTP, the gateway reserves the effect using a fresh execution UUID and computes the normalized request hash. The same UUID is reused only for an uncertain reservation RPC before vendor dispatch. A restarted call has a new UUID. `never` effects with an uncertain previous dispatch are not automatically repeated. `idempotent` requires a nonempty `idempotency_key`; the actual outgoing header must match it. This is an assertion about the vendor's idempotency contract, not a claim of universal exactly-once HTTP.

Binary task bodies flow from source to bounded chunks to the gateway. Workers never stage task binaries in files or completion JSON. Each durable chunk ACK advances the checkpoint. Strong ETag + Range allow resumption; a changed/non-rangeable source starts a new retained upload. A lost finish ACK is recovered from the sealed artifact without requesting the source again. Partial artifacts and uncertain external effects remain evidence rather than being presented as successful tasks. Local JSON metadata and completion outbox use atomic replacement and fsync. Only a matching committed/candidate-saved receipt removes a completion. Permanent non-authentication 4xx conflicts are moved atomically into a local forensic quarantine, retaining payload and server response while allowing future tasks. Checkpoints and sealed artifact ownership persist per job, including a resumed script returning a saved artifact without a fresh HTTP call; cleanup happens only after the matching durable completion ACK. Leases renew independently of long Node compute; cancellation closes streams/child execution. A host interruption may leave an uncertain external effect, which must be reconciled rather than blindly retried.

Self-updates check the configured Gitea → GitFlic → GitHub sources. Public defaults contain a reserved Gitea hostname; provision a real Gitea URL only in private config. The same pinned RSA key verifies every source, and a durable version floor prevents rollback. A source reporting the installed version does not hide a newer fallback. The signed ZIP/hash is verified, paths/links/CRC/package identity are checked, then a version directory and activation pointer are installed atomically. Updates run only outside an active task with an empty outbox. `runtime/pending.zip` is an updater package cache, not a task payload. A different payload never overwrites an already installed version.

Tests use controllable localhost fixtures only:

```sh
node --test tests/*.test.mjs
PHP_BINARY=/usr/bin/php node --test tests/*.test.mjs
```

The first command uses an already installed official `php:8.3-apache` Docker image when `PHP_BINARY` is absent. CI uses native PHP 8.2 with no Docker socket. Tests exercise 64 MiB binary transfers, bounded memory, lost ACKs, resumed ranges, cancellation, real PHP execution windows, durable outboxes, redirect credential handling, compressed entity bytes and signed updates. They do not contact deployment services or public release APIs.
