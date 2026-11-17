# Private task egress

Proxy selection is a worker-local operator setting, never an untrusted job URL
or a gateway credential. Keep this configuration, source URL list, verified
cache and runtime state outside Git, readable only by the worker account.

```json
{"proxy":{
  "mode":"required",
  "servers":[{"url":"http://proxy.example.invalid:8080","username":"configure-privately","password":"configure-privately"}],
  "sources_file":"/private/proxy-sources.txt",
  "cache_file":"/private/proxy-cache.json",
  "required_country":"RU"
}}
```

`off` makes task requests directly; `prefer` allows direct task egress when no
healthy configured proxy is available; `required` never falls back to direct.
Only a usable required pool advertises `proxy.egress.v1`. Require that capability
on jobs that must use a proxy. Gateway, artifact storage, enrollment, heartbeats,
release downloads and source-list discovery remain direct. Ambient HTTP/SOCKS
proxy variables do not redirect those control connections. Origin and proxy TLS
certificate verification stay enabled. Proxy credentials are attached only to
the proxy handshake, not vendor headers or worker control requests.

Explicit `servers` are trusted operator entries. `url` accepts HTTP, HTTPS-to-
proxy and SOCKS4/4a/5/5h where the backend supports them. `host`, `port`, optional
`scheme` may be used instead of `url`; credentials remain separate. An unsupported
transport never changes into a different scheme or a direct connection.
SOCKS5h/4a delegate vendor DNS to the proxy. SOCKS5/4 resolve it locally.

A source file can contain one HTTP(S) list URL per line (blank/comment lines are
ignored), or a JSON array of URL strings / `{url,scheme}` objects. The scheme
hint interprets bare `ip:port` entries from transport-specific feeds. Source
payloads can be newline proxy URLs or a JSON array with `proxy` and optional
`geolocation.country`. These labels are **untrusted hints**. Discovery records
candidates; it does not claim to verify exit geography or activate a public
proxy. Automatic deployments pair discovery with a recurring external verifier
and private cache distribution. The verifier checks the actual HTTPS exit and
country, then writes matching entries into `verified`. `required_country` is
optional; no country is hardcoded in the worker.

```json
{"schema":1,"verified":[{
 "url":"socks5h://proxy.example.invalid:1080",
 "verified_at":"2026-01-01T00:00:00Z",
 "exit_ip":"192.0.2.10","exit_country":"RU"
}],"candidates":[],"health":{}}
```

A discovered endpoint is usable only from this verified cache, with nonempty
verification time/exit IP/country and a matching optional country filter.
Private explicit servers need no cache. Cache reloads observe atomic verifier
replacement without a restart. Runtime health is stored separately in the
worker state to avoid overwriting a concurrently refreshed verifier cache.
Failed endpoints receive exponential retry backoff; successful transfers clear
it. There is no attempt count or overall job deadline. Selection is deterministic
and round-robin, initially seeded by the persisted server-assigned worker ID.
A required pool outage leaves work pending; it does not invent a successful
result or issue a direct vendor request. Standard effect `never` uncertainty
rules still apply after a possibly dispatched mutation.

Endpoint identity is SHA-256 of UTF-8:
`canonical_credential_free_url + "\n" + username + "\n" + password`.
Canonical URLs use lowercase scheme/hostname, IPv6 brackets, and an explicit
port (HTTP 80, HTTPS 443, SOCKS 1080); credentials containing CR/LF/NUL are rejected.
`health[id].retry_after_ms` and `last_ok` are UTC epoch milliseconds;
`verified_at` is ISO8601 UTC. IDs/credentials/addresses are not telemetry.

Opt-in native programs additionally set `proxy_env:true` in their private
program entry. They receive the selected authenticated URL through
`FLEET_TASK_PROXY_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and lowercase
aliases; `FLEET_TASK_PROXY_REQUIRED` is `1` in required mode. `NO_PROXY` is empty
(or absent on PHP platforms that omit empty environment entries). No ambient
parent environment is inherited. The native program must honor these trusted
settings; native code is not an HTTP sandbox. A required worker does not
advertise native programs that have not opted in.

`proxy_failure_exit_codes:[75]` is an optional private program contract: use
such codes **only** when that program identifies a proxy transport failure.
Ordinary domain/HTTP/captcha/process failures must have a different code.
Only a `safe` program may rotate and re-execute after this signal. Every output
generation is retained as its own artifact, never appended to the previous
stream. `never` programs retain the failure/uncertainty without automatic replay.
Bounded stderr redacts configured proxy credentials; it is not logged in full.

Native programs may support a subset of the generic HTTP proxy transports.
Provision only compatible schemes in their private pool; an unsupported native
transport is not a signal to bypass the proxy.
