# Yangon TV — Stream Server 1

A single-instance Node.js service for **Bot 1 only**. It accepts video/document uploads in a Telegram bot's private chat, forwards them to one private storage channel, caches them in Cloudflare R2 on first playback, and serves signed playback/download links at `https://stream-server-1.ygntv.org`.

Telegram intake, message forwarding, storage-channel access, and bot replies all use **MTProto via Teleproto**. The BotFather token is used only as the MTProto bot authorization credential; the code does not call Telegram's HTTP Bot API. Bots 2–5, multi-account load balancing, and Laravel integration are out of scope.

## Architecture

```text
Allowlisted user sends a video/document in a private Telegram chat
                      │
                      ▼
       Teleproto bot account (MTProto updates)
                      │ MTProto forwardMessages
                      ▼
       Private Telegram storage channel (master)
                      │
           Teleproto user account (MTProto)
                      │ on first URL request: 512 KiB chunks
                      ▼
       Node.js 22 + Fastify → Cloudflare R2
                                  │ range reads
                                  ▼
                     Cloudflare CDN / domain
                                  │
                      signed URL to the user
```

The bot returns the link through its MTProto connection. Media bytes are not downloaded to the web server during the upload/forwarding step. The existing streaming service later reads the channel file with MTProto, streams bounded chunks into R2, and serves byte ranges from R2. Files larger than 50 MB therefore do not rely on Telegram Bot API `getFile` downloads or a full-file RAM buffer.

## Telegram MTProto setup

The service uses two Teleproto MTProto clients:

- A **user account** uses `TELEGRAM_SESSION` to read the private channel and download files in chunks.
- A **bot account** uses the BotFather token as Teleproto's `botAuthToken` for MTProto bot authorization. It receives private incoming messages over a persistent MTProto connection, forwards media to the private storage channel, and replies with the signed URL. It does not use HTTP webhooks or Bot API polling.

Telegram documents bot authorization through [`auth.importBotAuthorization`](https://core.telegram.org/api/bots). Teleproto documents [bot-token authentication](https://docs.teleproto.dev/authentication), [incoming message events](https://docs.teleproto.dev/guides/events), and persistent [sessions](https://docs.teleproto.dev/sessions). Telegram's [`messages.forwardMessages`](https://core.telegram.org/method/messages.forwardMessages) method is available to both users and bots.

Requirements:

1. Obtain `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` at [my.telegram.org/apps](https://my.telegram.org/apps). Keep the hash secret.
2. Create the bot with [@BotFather](https://t.me/BotFather) and put its token in the deployment secret manager as `TELEGRAM_BOT_TOKEN`. Do not paste the token into chat or commit it.
3. Add the bot account as an administrator of `TELEGRAM_STORAGE_CHAT_ID` with permission to post messages. The user account holding `TELEGRAM_SESSION` must be able to read that channel.
4. Set `TELEGRAM_BOT_ALLOWED_USER_IDS` to comma-separated numeric Telegram user IDs. An empty value **denies all uploads** (fail-closed). Only allowlisted users can receive links. The bot accepts files in private chats, not group uploads.
5. Keep the directory configured by `TELEGRAM_BOT_SESSION_PATH` on persistent writable storage. Teleproto's `StoreSession` stores the bot's MTProto auth key there; protect it like a password. The default is `./data/telegram-bot-session`.

The existing user session is a persistent Teleproto `StringSession`. Provision it securely on an operator workstation using Teleproto's authorization flow, store it directly in a secret manager, and never log or commit it. Neither client prompts for interactive login during server startup.

## Cloudflare R2 setup

Create one R2 bucket for this instance and an API token limited to the bucket/object permissions the service needs. Supply:

- `CF_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

`CloudflareR2Storage` uses the AWS SDK S3-compatible endpoint at `https://<account-id>.r2.cloudflarestorage.com`. Objects use stable keys `videos/{internal-uuid}.mp4`. Uploads use an S3-compatible multipart uploader with 8 MiB parts and a queue size of 2; playback uses Node streams and forwards byte ranges. Confirm the maximum expected file size, account/storage limits, bandwidth, and Telegram limits before production. See [Cloudflare R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

## Environment configuration

Copy `.env.example` to `.env` for local use and use a platform secret manager in production. `.env`, the `data/` directory, SQLite files, and session state are git-ignored.

| Variable | Purpose |
| --- | --- |
| `APP_ENV` | `development`, `test`, or `production` |
| `APP_URL` | Public base URL; production: `https://stream-server-1.ygntv.org` |
| `HOST`, `PORT` | Bind interface and service port |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Telegram MTProto application credentials |
| `TELEGRAM_SESSION` | Authorized user-account Teleproto StringSession |
| `TELEGRAM_STORAGE_CHAT_ID` | The single private master channel |
| `TELEGRAM_BOT_TOKEN` | BotFather token, used only for Teleproto MTProto bot authorization |
| `TELEGRAM_BOT_SESSION_PATH` | Persistent bot MTProto session directory; default `./data/telegram-bot-session` |
| `TELEGRAM_BOT_ALLOWED_USER_IDS` | Comma-separated numeric user IDs; empty means deny all |
| `CF_ACCOUNT_ID` | Cloudflare account identifier |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3-compatible credentials |
| `R2_BUCKET_NAME` | Cache bucket |
| `STREAM_TOKEN_SECRET` | Random secret of at least 32 characters for HMAC-signed URLs |
| `MANAGEMENT_API_TOKEN` | Random bearer token (at least 24 characters) for management/diagnostics |
| `DATABASE_PATH` | Persistent SQLite catalog path; default `./data/catalog.sqlite` |
| `LOG_LEVEL` | Pino log level; default `info` |

Generate independent secrets with a cryptographically secure random generator (for example `openssl rand -hex 32`). Do not reuse the bot token, signing secret, or management token. Rotate credentials if exposed.

## Local development and build

Requires Node.js 22+ and npm.

```bash
cp .env.example .env
npm ci
npm run check
npm test
npm run build
npm start
```

With external credentials omitted, `/health` still works and Telegram/R2-dependent features stay unavailable. The upload bot starts only when the user MTProto session, storage channel, R2, bot token, and signing secret are configured. A blank allowlist leaves uploads denied.

## Production deployment

1. Deploy as a persistent Node.js 22 process/container with outbound access to Telegram MTProto and Cloudflare R2. Keep the service running; this is not a short-lived Worker workload.
2. Set secrets in the host's secret manager. Persist both the directory at `TELEGRAM_BOT_SESSION_PATH` and the SQLite database path (by default, both live under `./data`).
3. Terminate TLS at Cloudflare or a reverse proxy and route `stream-server-1.ygntv.org` to the backend. Expose `GET /health` for load-balancer checks. Ensure proxies preserve `Range`, `Content-Range`, and streaming responses without buffering or short timeouts.
4. Check `/api/diagnostics` with the management bearer token. Verify the user account can read the channel, the bot account can post there, R2 is reachable, and the allowlist contains the intended users.
5. Test with one allowlisted account, first a small clip and then a representative file over 50 MB. Seek into the large file and monitor process memory, R2 multipart cleanup, network use, and proxy timeouts.

Production secrets, live Telegram/R2 access, DNS, webhook setup, and deployment are **not** modified by the code build itself. No webhook is required for the MTProto bot.

## Playback and management API

Public routes:

- `GET /health` → `{ "status": "ok" }`
- `GET /file/{id}` → inline playback
- `GET /download/{id}` → attachment download
- `GET /v/{token}` → inline playback using an expiring signed token

Authenticated management routes use `Authorization: Bearer $MANAGEMENT_API_TOKEN`:

- `POST /api/files` with `{ "messageId": "123" }` registers a message already in the configured private channel and returns an opaque UUID plus a one-hour signed URL.
- `GET /api/files/{id}` returns safe metadata and a fresh signed URL.
- `DELETE /api/files/{id}` deletes its R2 cache object and catalog mapping, but does not delete the Telegram master message.
- `GET /api/diagnostics` checks application, user MTProto connection, storage-channel access, and R2 without disclosing credentials.

Signed tokens contain a versioned UUID/expiry payload and an HMAC-SHA-256 signature. They are bearer links: anyone who receives a link can use it until its one-hour expiry. Invalid or expired tokens return `403`.

## Large-file behavior and cache

The MTProto bot forwards the Telegram message into the channel; it does not retrieve bytes using the Bot API. On the first URL request, the user-account MTProto client fetches the document and iterates 512 KiB chunks directly into an R2 multipart upload. The server does not buffer a whole video in memory or create a full temporary copy. Subsequent requests use R2 while the object remains cached. A per-process single-flight map de-duplicates simultaneous cache misses; it is not a distributed lock, so multi-replica deployments need a shared lock.

`GET /file/{id}` and `/download/{id}` support single byte ranges, including bounded, open-ended, and suffix ranges. Valid ranges return `206 Partial Content` with `Accept-Ranges`, `Content-Length`, `Content-Range`, `Content-Type`, and `ETag`; unsatisfiable ranges return `416` with `Content-Range: bytes */{size}`. Multiple ranges are not implemented. Browser video controls can play, seek, and resume using byte ranges.

## Security and reliability

- The bot handles private incoming MTProto messages and checks the allowlist before forwarding any media. Empty allowlist means deny all.
- A new SQLite table records bot message processing state using source chat/message IDs, preventing duplicate channel copies on retries after a partial failure. Table creation is additive; existing file catalog records are unchanged.
- `.env`, Telegram user/bot sessions, SQLite files, `node_modules`, and build output are excluded from Git/Docker contexts as configured.
- Management authentication uses constant-time bearer comparison. Public routes accept registered UUIDs only; signed tokens are HMAC-protected and expire.
- Logs do not contain bot tokens, session strings, URL tokens, or secret values. Use TLS, least-privilege R2 credentials, a protected management token, and persistent encrypted secret storage.

## Cloudflare Worker note

A Worker may be added later for edge routing or R2 delivery, but it is not used for Telegram ingest. Keep MTProto and the large-file chunk-to-R2 path in the persistent Node backend; any edge layer should receive a separate end-to-end range/auth/cache/large-file soak test.

## Troubleshooting

| Symptom | Likely action |
| --- | --- |
| `/health` works but diagnostics report Telegram false | Check API ID/hash, authorized user StringSession, outbound access, and session revocation. |
| Bot does not start | Check BotFather token, API credentials, user session, R2/signing configuration, channel ID, and persistent writable bot-session path. |
| Bot upload is denied | Add the sender's numeric Telegram user ID to `TELEGRAM_BOT_ALLOWED_USER_IDS`; empty means deny all. |
| Bot cannot forward into storage channel | Make the bot an admin with post permission; ensure the private message is not protected from forwarding. |
| Playback fails after a cache miss | Check user MTProto channel access, R2 credentials, and host egress. Inspect sanitized logs and try a small clip. |
| `416` or seeking fails | Check the requested range and confirm the reverse proxy preserves Range/Content-Range headers without buffering. |
| SQLite catalog disappears after restart | Persist and back up the volume containing `DATABASE_PATH`. Also persist the bot session directory. |

## Tests and project structure

The tests use in-memory fakes and do not contact Telegram or Cloudflare. They cover API auth, file registration, R2 cache hit/miss, range streaming, signed URLs, Telegram/R2 failure mapping, MTProto bot authorization, allowlist enforcement, forwarding, update deduplication, and retry after a partial failure. A live large-file test still requires real Telegram/R2 credentials and deployed infrastructure.

```text
src/
├── app.ts
├── index.ts
├── config/env.ts
├── security/{auth,signed-url}.ts
├── services/
│   ├── file-catalog.ts
│   ├── types.ts
│   ├── telegram/{telegram-mtproto-service,telegram-mtproto-bot-service}.ts
│   └── r2/{r2-storage-service,types}.ts
├── streaming/{cache-coordinator,range}.ts
└── utils/errors.ts
tests/{app,range,telegram-mtproto-bot}.test.ts
```
