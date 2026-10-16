# Batch 8 — Final hardening before apply

Scope: H01 and M01–M05 only. These changes sit on top of the existing Batch 1–7
working tree. No commit, push, hosted deployment or real gateway transaction was
performed. Local verification uses test databases and local/simulated IPN traffic.

## H01: inventory

`PATCH /api/variants/:id` changes only size/color/price and rejects a `stock` field.
The admin metadata form omits stock; creation still accepts initial stock.
Explicit adjustments use the admin-only `PATCH /api/variants/:id/stock` with
`stock`, `expectedStock` and `expectedVersion`. A single conditional update matches
both current stock and version, sets stock and increments `inventoryVersion`.
Checkout deductions and cancellation restoration also increment that version.
This detects an ABA change even when stock returns to the originally displayed value.

Stale adjustments return 409 `INVENTORY_CHANGED`; missing variants return 404.
The form refreshes the list and requires explicit selection again after a conflict.
It never retries the requested quantity against a newly read version automatically.
Legacy rows without a version are treated as version zero. No inventory backfill
or read-modify-save sequence is used.

## M01: payment feature flag

The backend cart response publishes `paymentMethods` from validated runtime config.
The frontend hides/disables unsupported methods. Backend checkout enforces the
same capability before opening a transaction for a new checkout. Disabled VNPay
returns 409 `PAYMENT_METHOD_UNAVAILABLE` without creating orders/items, changing
stock or consuming the cart; COD remains available. An already committed checkout
key still replays its existing order, without writing another order.

The existing global VNPay route gate remains in place; drain and reconcile pending
payments before disabling it. The feature flag is not an operational kill switch
that leaves callback ingestion enabled.

## M02: payment creation idempotency

Both create/recreate endpoints require a 16–128 character UUID-compatible
`idempotencyKey`. The client stores `{orderId, idempotencyKey}` in sessionStorage,
scoped to user/order, before posting. Network loss, timeouts, HTTP failures or an
invalid response retain that exact intent across reload and checkout/account flows.
Unreadable/unwritable storage blocks submission rather than silently minting a key.

`payment_user_key_unique` is a partial unique index on `(userId, idempotencyKey)`.
The attempt stores the request hash and signed payment URL atomically with its key.
Same key/intent returns the same reference, original URL and expiry; a changed
payload/order returns 409. Changed server order amount/method also conflicts.
The transaction and unique constraint arbitrate concurrent requests, and the
post-transaction lookup resolves a committed winner after an uncertain response.
Only a confirmed response clears the client key. A subsequent deliberate payment
action gets a new key/reference; uncertain retries do not.

Replaying a resolved, cancelled or expired attempt returns the same reference with
`paymentUrl: null`, directing the client to its status. It never extends expiry or
creates a replacement implicitly. The cap of three unresolved attempts still
applies to new keys; replay works at the cap. Existing reference/provider transaction
constraints, late-IPN handling and manual review behavior remain intact. Stored
URLs/creation keys/hashes are excluded from the reconciliation list response.

Session storage is scoped to the current tab, not a durable cross-device queue.
Legacy attempts without a creation key remain readable and outside the new index.

## M03: dashboard definitions

Revenue includes only `status=DONE`, `paymentStatus=PAID`, and no
`paymentReviewRequired=true`. It sums `Order.total`, which already includes shipping.
The 200000 subtotal + 30000 shipping example therefore contributes exactly 230000.
Dashboard total, daily revenue and top-user spend share this eligibility filter.
The existing daily report groups by order creation date, not collection/completion date.

Top products starts from real `OrderItem` records, joins eligible Orders and
ProductVariants, groups by product, and sums quantity and purchase `price * quantity`.
Archived references remain eligible. Product revenue excludes shipping; its sum
does not have to equal order revenue. Ranking is quantity descending with product
ID as a deterministic tie-breaker. No nonexistent embedded `Order.items` is queried.

## M04: session revocation

Login signs `authVersion` into JWTs. Password reset updates the password and
increments the database version atomically. HTTP and socket authentication require
an exact current version. Socket authorization rechecks existing connections on
actions and recipient delivery, rejecting sends and disconnecting revoked recipients.
Ordinary user metadata edits do not revoke sessions. A new login with the new
password gets a usable version. No refresh-token mechanism was added.

Legacy users can log in with version zero. JWTs without a version are rejected:
deployment requires one-time re-login. Do not bypass that check to preserve old tabs.

## M05: auth rate limiting

- POST login: 60 requests per IP per 15-minute fixed window.
- POST register: 20 requests per IP per hour, separate from login.
- IPv6 clients share a /64 budget; dotted IPv4-mapped addresses use their IPv4 key.
- HTTP 429 includes `AUTH_RATE_LIMITED`, `Retry-After`, limit/remaining headers and CORS.
- Checks run before body parsing/password hashing. Other endpoints are unaffected.
- Per-app in-memory storage is bounded to 10000 active buckets. At capacity it
  rejects new buckets instead of evicting live quotas; expired windows recover.
- `TRUST_PROXY` defaults off. Only explicit proxy IPs/CIDRs are accepted; arbitrary
  X-Forwarded-For is ignored without a trusted peer. Configure the actual proxy chain.

This is a single-instance public-demo policy. Successful requests consume quota;
clients behind a shared NAT share it. Restart resets quotas; no Redis was introduced.

## Verification

Local run: 2026-10-16, Node 24.13.1, MongoDB 7.0.24.

| Check | Result |
| --- | --- |
| Backend: security, checkout, lifecycle, payment/IPN, catalog, release, upload, Batch 8 | PASS — 149/149 |
| Frontend: security, checkout, lifecycle, catalog, payment/recovery, release, Batch 8 | PASS — 116/116 |
| Real Chromium E2E with isolated replica set | PASS — 10/10 |
| Syntax | PASS — 90 backend / 60 frontend scripts, including inline scripts |
| Dependency audit, both repos, `--audit-level=high` | PASS — 0 vulnerabilities |
| Secret-pattern scan including available Git history | PASS — best-effort detection, values withheld |
| Docker build/start, seed twice, smoke and Mongo outage/recovery | PASS — isolated Compose project; live=200/ready=503 during outage, recovered afterwards |
| `git diff --check`, both repos | PASS |

The Batch 1–7 assertions remain enabled: final-unit/concurrent checkout, cancellation
restore exactly once, IPN settlement/duplicates, late money and review, archive and
purchase snapshots, authorization, chat UUID idempotency and frontend recovery.
Fixtures were adapted only for required JWT/payment keys and metadata separation.

The new E2E tests race admin metadata/stock forms with actual checkout/cancellation
and drop the payment-create response after commit, then reload/retry and deliberately
request a new attempt. Local gateway navigation is fulfilled by the test; no VNPay
production or sandbox server is contacted. GitHub Actions and hosted deployment
remain unrun until the compatible repositories are committed/pushed.

Docker ran as project `clothing-batch8-20261016` with a new local database volume
and generated test-only environment under ignored `.cache/batch8`. It did not read
the existing `.env`/`.env.local`; VNPay and Cloudinary were disabled. The smoke
verified the three-product seed, login, assets and health endpoints after both seed
runs and again after the actual Mongo restart. Other projects' containers/data
were left untouched. The test stack is stopped after verification; its local volume
is retained. Host checks plus the Docker production dependency install cover the
available local release checks; this is not a claim that remote GitHub CI has run.

## Batch 8 files changed

Paths below identify this batch's scope, not all pre-existing dirty files.

Backend runtime:

- `src/app.js`, `src/config/env.js`
- `src/controllers/{admin,auth,cart,order,productVariant,user,vnpay}.controller.js`
- `src/middlewares/auth.middleware.js`, new `src/middlewares/authRateLimit.js`
- `src/models/{ProductVariant,PaymentAttempt,User}.js`
- `src/routes/productVariant.route.js`, `src/validators/productVariant.validate.js`
- `src/services/checkout.service.js`, `src/services/orderTransition.service.js`, `src/services/payment.service.js`, `src/services/paymentReconciliation.service.js`
- `src/utils/chatAuthorization.js`, new `src/utils/sessionVersion.js`

Backend tests/docs:

- New `test/hardening.test.js`, `test/auth-rate-limit.test.js`
- `test/{catalog,checkout,order-lifecycle,payment,release,security}.test.js`
- `.env.example`, `README.md`, `test/README.md`, `docs/deployment.md`, this report

Frontend runtime:

- `public/admin/variants.html`, `public/admin/js/{variants,dashboard}.js`
- New `public/js/payment-create.js`, `public/js/{checkout,account-orders}.js`
- `public/pages/{checkout,account}.html`

Frontend tests/docs:

- New `test/payment-creation.test.js`
- `test/{catalog,checkout,order-lifecycle,reliability,security}.test.js`
- `e2e/critical.spec.js`, `README.md`, `test/README.md`

## Deferred audit backlog

Unchanged by this batch: M06 duplicate conversation; M07 category delete; M08
pagination/performance; M09 empty variant; M10 accessibility; M11 default-address
race. Low-priority phone/ward/note issues remain deferred as in the final audit.
No Redis, new gateway, refunds, recommendation engine, framework migration or
other feature was added.

## Release conditions

Commit/push the compatible frontend/backend pair and select the matching companion
commit in GitHub CI. Startup must create the new payment key index. Reload old
browser tabs and log in again; old metadata/payment request shapes are rejected.
Apply the documented proxy allowlist only when actually behind that proxy.
Deployment and a real provider sandbox transaction require their own verification.

Final local verdict: **READY** to review, commit/push the compatible pair, run GitHub
CI and begin portfolio applications. All requested local gates passed; this verdict
does not close the deferred audit backlog or claim a production deployment.
