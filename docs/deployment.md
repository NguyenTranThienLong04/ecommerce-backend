# Deployment checklist

This repository is prepared for release; local checks do not imply that a hosted
deployment or GitHub Actions run has already succeeded. The Compose file is a local
demo, not cloud infrastructure. No production credentials are required in CI.

## Before release

1. Review and commit the backend/frontend changes as a compatible pair. Set
   `FRONTEND_REF` / `BACKEND_REF` repository variables to those immutable commits
   (or dispatch with `companion_ref`). Wait for both Release checks workflows.
   The workflow checks out full history for its best-effort secret scan. Review
   findings without printing values; rotate any confirmed exposed secret.
2. Back up existing data. Rehearse [legacy data preparation](legacy-data.md) on a
   staging copy, resolve normalized variant/cart/review duplicates deliberately,
   and verify the checkout/payment indexes. Startup fails if required indexes
   cannot be installed; do not bypass them. The new partial message index excludes
   old messages without `clientMessageId`.
   Batch 8 adds `payment_user_key_unique` on `(userId, idempotencyKey)`; legacy
   attempts without a key remain outside the partial index. Stock versions and
   user auth versions start at zero when absent; no destructive backfill is needed.
3. Use Node 24.13.1 and MongoDB with transactions (replica set or supported mongos),
   authenticated access, TLS and suitable backups. The application DB user needs
   the permissions required to create indexes. The local Docker volume is not a
   production backup or a high-availability deployment.

## Environment

| Service | Variables |
| --- | --- |
| Backend required | `NODE_ENV=production`, `MONGO_URI`, fresh `JWT_SECRET` (minimum 32 characters), `FRONTEND_URL=https://<frontend-origin>` |
| Backend server | `PORT` (default 5000), `HOST` (default 0.0.0.0) |
| Backend reverse proxy | Optional `TRUST_PROXY`: comma-separated proxy IPs/CIDRs; empty disables proxy trust |
| Frontend required | `NODE_ENV=production`, `BACKEND_URL=https://<backend-origin>` |
| Frontend server | `PORT` (default 3000), `HOST` (default 0.0.0.0) |
| Optional uploads | `CLOUDINARY_ENABLED=true`, `CLOUD_NAME`, `CLOUD_API_KEY`, `CLOUD_API_SECRET` |
| Optional VNPay | `VNPAY_ENABLED=true`, `VNP_TMN_CODE`, `VNP_HASH_SECRET`, `VNP_URL`, `VNP_RETURN_URL`, `VNP_RESULT_URL` |

Origins must not contain credentials, query strings or application paths. Production
HTTP URLs are rejected. Flags default to false and accept only `true`/`false`.
Missing enabled-integration settings fail startup. Keep credentials in the hosting
environment/secret store. `.env.local` and actual `.env` files are ignored by Git
and excluded from images. `DEMO_PASSWORD` is local seed configuration only.

Configure `TRUST_PROXY` only for the actual proxy addresses/subnets, with the proxy
replacing untrusted forwarding headers. Never use `true`, hop counts, or a broad
client subnet. Without a trusted proxy, `X-Forwarded-For` is ignored. Login permits
60 requests per 15 minutes and registration 20 per hour per client IP (IPv6 /64),
with separate fixed windows, HTTP 429 and `Retry-After`. Quotas include successful
and unsuccessful requests. Shared NAT clients share a quota. The bounded in-memory
store is per backend instance and resets on restart; use one instance for this demo.

When enabling VNPay, configure the gateway endpoint for the intended environment,
set Return to `https://<backend>/api/vnpay/return`, Result to
`https://<frontend>/payment-result`, and register the public backend
`https://<backend>/api/vnpay/ipn` with VNPay. Return never settles an order. Drain and
reconcile any legacy links without a PaymentAttempt before switching versions.
Run an authorized sandbox transaction on staging to verify provider delivery and
signing; the automated suite uses signed local callbacks and makes no gateway call.
Disabling VNPay removes it from the cart's `paymentMethods` capability and rejects
new VNPay checkout before a transaction. Drain/reconcile outstanding attempts before
turning it off: the existing flag also disables the VNPay callback/status routes.

## Deploy and verify

1. Build each Dockerfile or run `npm ci --omit=dev` then `npm start` in each service.
   Inject environment variables; do not copy the local demo config to production.
   Serve HTTPS and support Socket.IO WebSocket upgrades and HTTP polling.
2. Deploy backend and frontend together. New chat sends require `clientMessageId`;
   old browser tabs should reload. Use a single backend instance for room delivery:
   no cross-instance Socket.IO adapter is included.
   Batch 8 payment create/recreate requests require `idempotencyKey`, and variant
   metadata PATCH rejects `stock`; reload old tabs. Existing JWTs without
   `authVersion` are intentionally rejected, so all users must log in again once.
   Subsequent password resets atomically increment the version and revoke older
   HTTP/socket credentials. Existing sockets recheck on actions and room delivery.
3. Configure backend readiness routing with `/health/ready` and process liveness
   with `/health/live`. The frontend has `/health/live`; it does not claim backend
   dependency health. Check that failed DB access removes backend readiness.
4. Smoke-test login, public catalog, authorized admin access, COD checkout/replay,
   stale cart removal and chat reconnect. Verify `/runtime-config.js` has the right
   public API/socket origin, no secret, and `Cache-Control: no-store`.
5. If enabled, verify upload/cleanup and VNPay sandbox IPN independently. Check the
   admin reconciliation API for unresolved attempts before allowing real payments.
   Refunds and provider reconciliation remain manual responsibilities.
6. Retain the previously compatible BE/FE version pair for rollback. Do not remove
   new data or indexes just to roll back code; assess schema and payment-link
   compatibility against the backup/staging copy first.

Local reproducibility check, from the backend after setup and build:

```sh
docker compose run --rm seed
docker compose run --rm seed
node --env-file=.env.local scripts/smoke.js
docker compose stop mongo
node scripts/smoke.js --database-down
docker compose up -d --wait mongo
node --env-file=.env.local scripts/smoke.js --wait
```

The smoke check expects the untouched three-product demo fixture and verifies
readiness, login and frontend assets. It is not a production probe.

See [Batch 8 contracts and verification](batch8-hardening.md) for inventory CAS,
payment retry behavior, revenue definitions and the deferred audit backlog.

CI dependency ordering follows [Docker Compose health dependencies](https://docs.docker.com/compose/how-tos/startup-order/).
Browser setup follows [Playwright CI guidance](https://playwright.dev/docs/ci-intro).
