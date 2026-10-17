# Browser notifications

Notifications reuse the existing MongoDB connection, JWT authentication and
Socket.IO server. Deploy the matching frontend/backend pair. Startup creates the
Notification collection and awaits its indexes through the existing model-index
bootstrap; no environment variable, package or manual data migration is required.
There is no automatic historical backfill.

## Events

| Committed fact | Recipient | Type |
| --- | --- | --- |
| New checkout Order | Each current admin | ORDER_CREATED |
| Customer cancellation in statusHistory | Each current admin | ORDER_CANCELLED |
| Actual Order status change, including automatic cancellation or IPN settlement | Order owner | ORDER_STATUS_CHANGED |
| Normal verified successful payment | Order owner | PAYMENT_PAID |
| COD completed and cash collected by the existing transition policy | Order owner | PAYMENT_PAID |
| Verified provider failure | Order owner | PAYMENT_FAILED |
| Verified provider failure code 11 (payment timeout) | Order owner | PAYMENT_EXPIRED |
| Attempt requires review, including provider risk, late/additional payment or conflicting callback | Each current admin and Order owner | PAYMENT_REQUIRES_REVIEW |
| Persisted customer chat message | Each current admin | CHAT_MESSAGE |
| Persisted admin chat message | Current USER conversation members | CHAT_MESSAGE |

Review takes precedence over a normal PAID/FAILED notification for that attempt.
A previously delivered failure/paid notification remains historical when a later
contradictory report adds a review notification. A pending attempt merely passing
expiresAt, browser Return, payment-status GET and reconciliation GET create no
payment notification. Payment business state and stock behavior are unchanged.

## Model and deduplication

Notification stores recipientUserId, recipientRole, type, bounded title (120) and
message (300), relatedEntityType/relatedEntityId, optional relatedOrderId for the
admin payment link, readAt, createdAt and dedupeKey. Chat bodies and gateway payloads
are not copied. Every admin has an independent inbox/read timestamp.

Indexes:

- `{ recipientUserId: 1, recipientRole: 1, createdAt: -1, _id: -1 }`
- `{ recipientUserId: 1, recipientRole: 1, readAt: 1 }`
- Unique `{ dedupeKey: 1 }`

Keys append `:<recipientRole>:<recipientUserId>` to these event keys:

| Event | Event key |
| --- | --- |
| Checkout | `order:<id>:created` |
| Status | `order:<id>:status:<historyIndex>` |
| Customer cancellation for admin | `order:<id>:status:<historyIndex>:cancel` |
| Paid | `order:<id>:paid` |
| Provider failed/expired | `payment:<attemptId>:failed` |
| Review | `payment:<attemptId>:review` |
| Chat | `message:<messageId>` |

The unique database index resolves concurrent retries. Only the insert winner
emits. Order state history is append-only under the existing business services.
Checkout replays, order transition replays, duplicate valid IPNs and message
clientMessageId replays rerun the idempotent hook using persisted facts, allowing
a failed notification insert to be repaired without repeating the business write.

Checkout/transition hooks run after the transaction promise resolves. IPN hooks
run after its attempt/order transaction resolves. Chat's existing single-document
message write is already committed before the hook; chat still has no transaction
covering conversation preview updates. No notification is inserted or emitted
inside an order/payment transaction callback.

## HTTP and authorization

All endpoints use the existing auth middleware, its current database user/role,
and `Cache-Control: no-store`. JWT role claims, payload userId, query recipientUserId
and arbitrary client rooms do not select recipients. Admin items require both
matching recipientUserId and the current ADMIN database role. One admin cannot
read another admin's item. A demoted admin cannot read former admin notifications.

- `GET /api/notifications?limit=20&before=<cursor>`: limit 1–50, newest first,
  response `{ items, unreadCount, nextCursor }`. Cursor is opaque base64url JSON
  containing the last row's createdAt and _id; ties sort by _id descending.
  A Mongo snapshot aggregation returns the page and full-inbox unread count from
  the same view. `scope=admin` additionally requires ADMIN; it never grants a role.
- `PATCH /api/notifications/:id/read`: returns `{ item }`; foreign/missing item is
  404. Conditional update preserves the first readAt on retry.
- `PATCH /api/notifications/read-all`: marks only this user's current-role unread
  items, returns `{ modifiedCount }`; repeating it is harmless.

## Socket and HTTP recovery

The existing server handles `joinNotifications` and ignores its payload. It
reauthenticates the JWT against the account/session version and joins
`notifications:<DB role>:<DB user id>`. There is no client-supplied room/user ID.
Before every delivery, it rechecks current credentials and role and removes
ineligible sockets from the room. Expiration uses the existing socket timer.

`notification:new` contains the persisted public notification fields, excluding
recipient identity and dedupeKey. `notification:changed` invalidates snapshots
after a read/read-all mutation so other connected tabs can refresh.

The frontend's existing ChatSync helper supplies one Socket.IO connection per
login scope to chat and notifications. After reconnect it refreshes auth, awaits
the authorized room join ACK, then fetches HTTP items/unreadCount. Initial HTTP,
dropdown open, focus/visibility and the retry button also recover snapshots even
if sockets are unavailable. Socket callbacks never substitute for persistent HTTP
state. Rows merge by ID, readAt is monotonic, and an event overlapping HTTP forces
another snapshot before accepting its unread count. A refresh resets loaded older
pages to the latest page; the user can page again using Xem thêm.

## UI

One shared bell/dropdown is mounted in the customer header/checkout header and
every admin topbar. It uses existing CSS tokens, line SVG icons, safe text nodes,
unread/read labels, a contextual screen-reader count, loading/empty/error/retry
states, pagination, Escape/outside-click close and preserved link focus on updates.
Order links open the customer's order details or filter admin orders. Payment
links open the existing result page or filter admin orders. Chat links open the
existing customer widget or the selected admin conversation.

## Limits

- Notification persistence is a separate post-commit write. A process crash or
  database error between business commit and notification insert can lose the
  notification until that committed request is replayed. Without a replay there
  is no automatic repair worker/outbox. The business result remains successful;
  notification failures log only the error code/name. This is not guaranteed
  exactly-once delivery.
- A crash/transport error after insert but before emit is recovered by the next
  HTTP snapshot. Duplicate retries do not rebroadcast a stored notification.
- Realtime has the same single-server/adapter boundary as existing chat. With
  separate Node processes and no shared adapter, cross-process socket delivery is
  not guaranteed; HTTP still reads MongoDB. No Redis/queue has been added.
- No retention policy, deletion, preferences, email, SMS, browser permission,
  service worker, Firebase or Web Push. Inbox query cost grows with stored history;
  this implementation targets the shop's small notification volume.

Run `npm test` for the backend suite (including notification.test.js). Run
`npm test` and `npm run test:e2e` in the companion frontend for DOM/race tests and
real browser coverage. Tests use isolated temporary replica sets and signed local
gateway fixtures, never production data or real provider calls.
