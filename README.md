# Yangon TV — Stream Server 1

A single-instance Node.js service for **Bot 1 only**. It uses a user-authorized Telegram MTProto session to read video messages from one private storage channel, caches them in Cloudflare R2, and serves playback/downloads from `https://stream-server-1.ygntv.org`.

This repository does **not** implement Bots 2–5, multi-account support, round-robin, load balancing, or Laravel integration.

## 1. Overview and architecture

```text
Private Telegram storage channel (master copy)
                 │ Telegram MTProto / Teleproto
                 ▼
       Node.js 22 + Fastify backend
                 │ chunked multipart upload (cache miss)
                 ▼
       Cloudflare R2 (cache/delivery)
                 │ range-aware reads
                 ▼
 stream-server-1.ygntv.org → browser/player
```

The Telegram channel remains the master. R2 is the delivery cache. File registration stores a random UUID in a local SQLite catalog; public endpoints accept only that UUID, not arbitrary Telegram chat/message identifiers. Message IDs are only read from the configured storage channel.

The backend is a conventional long-running Node.js process because it needs persistent MTProto authorization and reliable, long-lived, chunked source ingest. The public domain should terminate TLS at a reverse proxy/Cloudflare and forward to this backend. A Worker can be added later for edge routing or R2 delivery without moving MTProto ingest into it.

## 2. MTProto and Teleproto

The server uses **Teleproto**, the actively maintained successor to GramJS, which implements Telegram MTProto and keeps a GramJS-compatible API. It is a user-account MTProto client, not a Telegram Bot API file-download implementation. `TelegramMTProtoService` owns connection, authorization, private-channel resolution, message lookup, document metadata, and chunk iteration. HTTP routes do not contain MTProto logic.

The service uses the provided `TELEGRAM_SESSION` as a persistent `StringSession`. Startup uses `connect()` and verifies authorization; it does not call an interactive login flow and will not prompt on restart. An absent/expired session is reported as an MTProto error.

- Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org/apps](https://my.telegram.org/apps). Treat the hash as a secret.
- Create a user StringSession with Teleproto's [authorization guide](https://docs.teleproto.dev/) on a secure, one-time operator workstation. Complete the normal Telegram login/2FA flow there, copy the resulting session directly into a secret manager, and do not paste it into source control, tickets, chat, or shell history. Never run session provisioning in the web server process.
- The Telegram user account must be a member of the private storage channel and able to read its video messages.
- Provide the channel's ID in `TELEGRAM_STORAGE_CHAT_ID`. The app resolves and checks access at startup/diagnostics.

The implementation never serializes or logs the session. Session strings and `.session` files are ignored by Git.

## 3. Cloudflare R2 setup

Create one R2 bucket for this instance and an R2 API token with only the bucket/object permissions the service needs (read, write, list/head, and delete for the chosen bucket). Supply:

- `CF_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

`CloudflareR2Storage` uses the AWS SDK S3-compatible endpoint at `https://<account-id>.r2.cloudflarestorage.com`. The stable key is `videos/{internal-uuid}.mp4`. Uploads use an S3-compatible multipart uploader with an 8 MiB part size and a queue size of 2, avoiding whole-file RAM buffers. Playback reads return Node streams and pass through byte ranges to R2.

R2 supports objects up to 5 TiB and multipart uploads up to 4.995 TiB (10,000 parts), subject to the current [R2 limits](https://developers.cloudflare.com/r2/platform/limits/). Confirm the intended max video size, available disk/database storage, bandwidth, and Telegram account limits before production.

## 4. Environment variables

Copy `.env.example` to `.env`, fill it locally, and use a platform secret manager in production. `.env` is git-ignored. Do not expose these values to browsers or logs.

| Variable | Purpose |
| --- | --- |
| `APP_ENV` | `development`, `test`, or `production` |
| `APP_URL` | Public base URL; production value is `https://stream-server-1.ygntv.org` |
| `HOST`, `PORT` | Bind interface and service port |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Telegram MTProto application credentials |
| `TELEGRAM_SESSION` | Persistent authorized Teleproto StringSession |
| `TELEGRAM_STORAGE_CHAT_ID` | The single private master channel for this instance |
| `CF_ACCOUNT_ID` | Cloudflare account identifier for the S3-compatible endpoint |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 API credentials |
| `R2_BUCKET_NAME` | This instance's cache bucket |
| `STREAM_TOKEN_SECRET` | Random secret of at least 32 characters for HMAC-signed URLs |
| `MANAGEMENT_API_TOKEN` | Random bearer token (at least 24 characters) for management/diagnostic endpoints |
| `DATABASE_PATH` | Persistent SQLite catalog path; default `./data/catalog.sqlite` |
| `LOG_LEVEL` | Pino log level; default `info` |

Generate independent secrets with a cryptographically secure random generator (for example `openssl rand -hex 32`). Use a different management bearer token and signing secret. Store all credentials in the hosting platform's secret manager; rotate them if exposed.

## 5. Local development

Requires Node.js 22+ and npm.

```bash
cp .env.example .env
# Set the secrets/IDs above; for health-only local startup, the external credentials may remain blank.
npm ci
npm run dev
```

The local server starts on `0.0.0.0:3000` by default. With credentials omitted, `/health` still works, while MTProto/R2-dependent operations return safe errors. Add valid external credentials and a persistent session to exercise Telegram and R2.

Commands:

```bash
npm run check   # strict TypeScript type check
npm test        # unit/API tests using in-memory fakes; no external credentials required
npm run build   # compile to dist/
npm start       # run compiled server
```

A SQLite catalog needs persistent writable storage. For containers, mount a durable volume at the chosen `DATABASE_PATH` location.

## 6. Production deployment and domain

1. Deploy on a persistent Node.js 22 host/container with outbound network connectivity to Telegram MTProto and Cloudflare R2's S3 endpoint. Provide enough memory for the Node runtime plus bounded multipart buffers; do not impose short request timeouts on cache-miss ingest.
2. Configure all secrets through the deployment secret manager. Set `APP_ENV=production`, `APP_URL=https://stream-server-1.ygntv.org`, and a durable SQLite path/volume.
3. Terminate HTTPS at Cloudflare or a reverse proxy and route `stream-server-1.ygntv.org` to the backend. Permit `GET /health` for load balancer health checks. Set proxy/read timeouts for large downloads, and ensure proxies preserve `Range`, `If-Range`, `Content-Range`, and streaming response bodies.
4. Restrict `/api/*` management paths at the network layer where practical in addition to bearer authentication. Keep R2 credentials limited to the one bucket.
5. Check `/api/diagnostics` using the management bearer token before opening public traffic. Verify the backend can reach Telegram and the private channel and can head the R2 bucket.
6. Use a persistent volume and backup/monitor the SQLite catalog. The R2 object cache can be repopulated from Telegram, but catalog UUID-to-message mappings are required to identify media.

The app listens on `HOST`/`PORT` and exposes `/health` for probes. The included Dockerfile compiles the TypeScript app and runs as a non-root user; configure runtime env/secrets and a persistent data mount outside the image.

## 7. API, playback, and downloads

### Public endpoints

- `GET /health` → `{ "status": "ok" }`
- `GET /file/{id}` → inline video playback
- `GET /download/{id}` → attachment download, preserving the Telegram filename when available
- `GET /v/{token}` → inline playback using an expiring signed token

### Authenticated management endpoints

Send `Authorization: Bearer $MANAGEMENT_API_TOKEN`:

- `POST /api/files` with JSON `{ "messageId": "123" }`: inspect that message in the configured private channel and register an opaque UUID. Re-registering the same Telegram message returns the existing mapping.
- `GET /api/files/{id}`: return public-safe file metadata and a one-hour signed playback URL.
- `DELETE /api/files/{id}`: delete its R2 cache object and catalog mapping. This does not delete the master Telegram message.
- `GET /api/diagnostics`: checks application, MTProto connection, storage-channel access, and R2 without disclosing credentials.

Example:

```bash
curl -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messageId":"123"}' \
  https://stream-server-1.ygntv.org/api/files
```

A signed token contains a versioned UUID/expiry payload and an HMAC-SHA-256 signature. It is not a Telegram ID. Invalid or expired tokens return `403`. Tokens expire after one hour by default. Signed responses are `private, no-store` to reduce token leakage through shared caches.

## 8. Cache and large-file handling

On the first request, the service validates the UUID, checks R2, fetches the configured Telegram message using MTProto if the object is absent, streams Telegram chunks (512 KiB requests) into an R2 multipart upload, then serves from R2. Subsequent requests do not fetch Telegram again while the object remains cached. A per-process single-flight map de-duplicates simultaneous misses for the same UUID. This is not a distributed lock; multiple backend replicas require a shared lock if duplicate cross-process downloads become a concern.

The initial cache-miss request waits for Telegram-to-R2 ingest to finish before playback begins, by design. It does not buffer the complete video in RAM or create a temporary video copy. R2 uploads use bounded multipart concurrency; R2 playback uses a stream. Ensure the hosting platform/reverse proxy supports long-lived streamed HTTP responses and does not buffer them to disk.

`GET /file/{id}` and `/download/{id}` support single HTTP byte ranges, including bounded, open-ended, and suffix ranges. For valid ranges, the service returns `206 Partial Content` with `Accept-Ranges`, `Content-Length`, `Content-Range`, `Content-Type`, and `ETag`. Unsatisfiable ranges return `416` with `Content-Range: bytes */{size}`. Multiple ranges are not implemented. Standard browser video controls can play, pause, seek, and resume through these requests.

## 9. Cloudflare Worker feasibility

A Worker is suitable as an optional edge layer for routing, short-lived token validation, cache policy, and R2-bound delivery. It is **not used for Telegram origin ingest in this implementation**. A persistent Node backend is a better fit for the MTProto client/session and large Telegram chunk-to-R2 multipart stream; it can operate independently of a browser request-body limit.

Cloudflare's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) list 128 MiB memory, plan-dependent CPU limits (10 ms Free, 5 min Paid by default), and HTTP request-body limits based on Cloudflare zone plan (100 MB Free/Pro, 200 MB Business, up to 5 GB Enterprise). The response body is not hard-limited, and Workers can stream responses, but resource and client-disconnect behavior still need to be considered. R2 itself supports multipart uploads, including through Workers, but that does not remove MTProto session/runtime integration constraints. Keep the origin ingest on Node; use a Worker only after a separate end-to-end range, auth, caching, and large-file soak test.

## 10. Security and logging

- `.env`, MTProto session files, SQLite files, `node_modules`, and build output are ignored.
- Never commit Telegram/R2 credentials, signing/admin secrets, a session string, private keys, or production database contents.
- Management routes and diagnostics use constant-time bearer comparison. Public video routes address only registered UUIDs; signed tokens use HMAC and expiry.
- Pino structured request logs include request ID, route template, file UUID (where applicable), status, latency, and whether a range was requested. Cache HIT/MISS is logged. Auth headers, URL token values, and secret values are not logged.
- Use TLS, least-privilege R2 keys, a protected admin token, and encrypted secret storage. Apply rate limits/IP controls at the edge for management endpoints.

## 11. Troubleshooting

| Symptom | Likely cause / action |
| --- | --- |
| `/health` succeeds, diagnostics show Telegram false | Verify API ID/hash, authorized persistent session, outbound connectivity, and that the session has not been revoked. No interactive login occurs on server restart. |
| Telegram connection works but storage access fails | Confirm the authenticated account belongs to `TELEGRAM_STORAGE_CHAT_ID`, the ID is correct, and the channel has not restricted access. |
| Registration returns 404 | The message ID may not exist in the configured private channel or may not contain document media. |
| Playback misses then returns 502 | Telegram source fetch failed; inspect sanitized request logs and test a small video/message. |
| R2 diagnostics false or request returns 503 | Verify account ID, endpoint, bucket name, token permissions, and host egress to R2. |
| 416 response | The requested byte range is outside the object size or malformed. Retry with a valid single range. |
| Seeking fails behind a proxy | Ensure the proxy forwards the `Range` header and does not buffer/truncate streamed responses. |
| Signed URL returns 403 | The token expired, was altered, the signing secret changed, or the URL was copied incompletely. Request a new management URL. |
| SQLite errors after restart | Persist and back up the volume containing `DATABASE_PATH`; ephemeral container storage loses the UUID map. |

## 12. Tests and production readiness

The test suite covers health and diagnostic authorization, authenticated registration and Telegram-message metadata flow, R2 cache hit/miss, Telegram-to-R2 caching, range streaming, attachment download, signed/expired/invalid tokens, 404, and Telegram/R2 error mapping. The tests use local in-memory adapters; they do not contact Telegram or Cloudflare.

Before production traffic, provision real Telegram and R2 secrets, verify the private channel from the service account, register and play a small test clip, then test a representative large file and seek from the middle while monitoring memory, process restarts, proxy timeouts, and R2 multipart cleanup. This live integration/large-file test cannot be completed without the operator's credentials, channel message, and deployed infrastructure.

## 13. Project structure

```text
src/
├── app.ts
├── index.ts
├── config/env.ts
├── security/{auth,signed-url}.ts
├── services/
│   ├── file-catalog.ts
│   ├── types.ts
│   ├── telegram/telegram-mtproto-service.ts
│   └── r2/{r2-storage-service,types}.ts
├── streaming/{cache-coordinator,range}.ts
└── utils/errors.ts
tests/{app,range}.test.ts
```
