Current commands are in the [main README](../README.md). Batch sections below are
historical checkpoints; the Batch 7 section supersedes earlier startup limitations.

Notification checkpoint (2026-10-17): **193 backend tests PASS**. The 17 new
`notification.test.js` cases cover real commit/rollback boundaries, concurrent
checkout/IPN/message retries, recipient isolation, role revocation, COD/provider
states, cursor pagination, independent admin read state and socket/HTTP recovery.
The other 176 regression tests remain enabled. See [notification contract](../docs/notifications.md).

Batch 8 current checkpoint: **149 backend tests**. `hardening.test.js` exercises
real inventory CAS/checkout/cancellation races, disabled payment capability before
transaction entry, committed payment response loss and concurrent key uniqueness,
actual OrderItem aggregation, and HTTP/socket session revocation. `auth-rate-limit.test.js`
checks thresholds, expiry, proxy trust, app isolation and bounded storage. Earlier
regression assertions remain enabled; see [Batch 8 report](../docs/batch8-hardening.md).

Security regression tests use Node's built-in test runner, the real Express routes,
Mongoose models, Socket.IO server/client, and a temporary local MongoDB instance.

From this repository, run:

```powershell
npm ci
npm test
```

Verified with Node 24.13.1. The first run downloads MongoDB 7.0.24 into
`.cache/mongodb` (ignored by Git; the Windows download is about 600 MB).
Subsequent runs reuse the binary. The test creates a temporary database, uses a
test-only JWT secret and loopback ports, then closes the server and database.
It does not load `.env`, import the production startup, or contact a real database.

The 13 tests cover cross-user cart/address mutations, address ownership injection,
chat REST access and admin guard, Socket JWT authentication and sender spoofing,
membership/role revocation, token expiration, successful owner/admin operations,
and the existing ownership checks on order cancellation, reviews and payment URLs.

Chat authorization policy: customers need a USER membership in the conversation;
accounts whose current database role is ADMIN can support all customers.
JWT role claims and payload user IDs do not grant access. Message delivery also
rechecks access for sockets already in a room. Reading is the existing REST
`PUT /api/chat/read/:conversationId` endpoint; no new socket read event was added.

Batch 2 adds `checkout.test.js` (20 integration tests on a temporary one-node
replica set) and `checkout-standalone.test.js` (1 test proving checkout refuses
a standalone server). Together with the 13 security tests, `npm test` runs 34 tests.
No new test dependencies are needed. Tests use the cached MongoDB binary and
separate temporary databases; no production configuration is imported.

Checkout tests exercise real commits/rollbacks, final-unit contention, combined
stock decrements, simultaneous identical/different idempotency requests, the
database unique index, cart mutations after the snapshot, quantity ABA, server
pricing and ownership. Controlled gates around order insertion schedule races;
faults after real item creation/cart consumption verify full rollback.

Runtime requirements: replica set or mongos with transaction support, and the
unique `checkout_user_key_unique` index on Orders. Startup/checkout explicitly
check topology and await index creation. Legacy orders without idempotencyKey
are excluded from the partial unique index. No standalone fallback is provided.

Batch 3 adds `order-lifecycle.test.js`: 30 integration tests on a temporary
replica set. The standalone test now also verifies that cancellation refuses
unsupported topology before mutation. The full backend suite has 64 tests:
13 Security, 21 Checkout/standalone, and 30 Order lifecycle.

Lifecycle coverage includes the role-specific transition allowlist, terminal
states, COD/VNPay separation, owner-only/idempotent cancellation, exact quantities,
legacy documents without the new fields, and rollback after the actual order
claim or first/second stock increment. Query barriers force overlapping snapshots
for user/user, user/admin, user/job, job/job, shipping/cancel, duplicate payment,
and checkout/restoration races. Signed local callback fixtures prove both payment
and cancellation winning after the losing transaction has already read old state.
The queries and commits run against real MongoDB; mocks only schedule execution
or inject failures, never substitute database results.

`inventoryRestoredAt` and `statusHistory` are optional additions with no new index
or mandatory backfill. Already-CANCEL legacy orders are replayed without any stock
write, even if the old code did not restore them correctly. Such historical data
needs separate reconciliation. The existing checkout unique index stays unchanged.
The VNPay tests exercise only the guarded browser-return flow, not IPN or refunds.

Batch 4 supersedes the previous browser-return settlement. `payment.test.js`
adds 25 integration tests; the full backend suite now has 89 tests. Existing
Batch 3 payment tests now send signed IPNs using PaymentAttempt fixtures, while
retaining the state, inventory, concurrency and rollback assertions. Late success
now records PAID plus review on a CANCEL order, without reopening or stock writes.

New coverage: server amount, unique references/indexes, GMT+7 rollover, ownership,
expiry and the cap of 3 unresolved attempts (including concurrent creators),
browser absence, sequential/concurrent duplicate IPNs, no acknowledgment before
commit, rollback after each actual attempt/order write, invalid callback fields
and mappings, read-only Return, expiry versus provider failure, extra payments,
provider transaction uniqueness, contradictory callbacks, code 07, status IDOR,
admin-only reconciliation and pagination, and missing configuration. The standalone
test also verifies payment readiness fails before any attempt is written.

Fixtures use test-only credentials and `.test` URLs. No gateway requests are made.
Startup awaits the new PaymentAttempt indexes; no Order index/backfill is added.
Expired unresolved attempts are retained rather than removed by TTL.

Batch 5 adds `catalog.test.js` with 24 integration tests; the backend suite now
has 113 tests. These use a local replica set and actual unique indexes to cover
purchase snapshots, archive visibility, stale cart removal, concurrent first
cart additions, normalized variant collisions, review validation/uniqueness,
legacy reads, index-build failure on duplicates, rollback and deterministic
archive races with checkout, cart addition and variant creation.

The duplicate-row checkout test now checks E11000 and tests the combined quantity
in one row against available stock. Existing Batch 1–4 assertions remain in place.
Before production deployment, normalize/deduplicate legacy catalog/cart/review
data and verify the indexes. See `../CATALOG_BATCH5.md` in the shared workspace for
the pre-deploy procedure and limitations of historical snapshot backfill.

Batch 7 adds `release.test.js`: real startup on a replica set, rejection of
standalone/missing configuration, ready/live behavior after DB disconnect, safe
idempotent seed, real login/catalog bootstrap, and chat message UUID uniqueness.
Chat tests force concurrent identical/conflicting sends, verify sender isolation
and current authorization on replays, and exercise REST-to-socket retry without
a second broadcast. `upload.test.js` checks the maintained Cloudinary adapter
contract with a local stream double; no provider requests are made.

These release tests import the actual exported startup function with explicit test
configuration, without loading `.env`. Existing Batch 1-6 security, transaction,
inventory, order/payment and catalog assertions remain enabled. Browser E2E lives
in the companion frontend repository and runs both actual servers with an isolated
Mongo replica set. See [deployment](../docs/deployment.md) and the self-contained
[legacy data procedure](../docs/legacy-data.md).
