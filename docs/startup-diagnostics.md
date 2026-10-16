# Temporary Render startup diagnostics

This patch records startup failures; it does not fix the unresolved Render failure.
It preserves connection options, topology requirements, index definitions, model
order, readiness caching/retries, disconnect behavior and public error messages.

## Enable on Render

Deploy the diagnostic patch with the normal Start Command:

```text
node server.js
```

Add this environment variable:

```text
DB_STARTUP_DIAGNOSTICS=true
```

Only the exact value `true` enables diagnostics. Removing the variable or setting
it to `false` disables logging and restores the original helper error shape.
No other environment variables need changing for this patch.

This is normal application startup: its existing auto-create/index operations
still run. The separate read-only probe from the investigation is not the Start
Command for this diagnostic redeploy. No deployment or remote writes were
performed while preparing this patch.

## Log contract

Each line begins with `[db] ` followed by JSON. Successful stages emit `START`
and `PASS`; failed stages emit `FAIL`. Stages cover:

- `Mongo connect`
- `hello/topology` (the existing hello command and topology acceptance check)
- `checkout readiness`, `catalog readiness`, `payment readiness`, `message readiness`
- Each helper's explicit model `createIndexes` call
- The final `createIndexes:<Model>/<collection>` loop over all registered models
- `database startup` on failure, before the existing disconnect/wrap path

Failures contain only `stage`, `status`, `name`, `code`, `message`, and `cause`.
`cause` is `null` or an object with `name`, `code`, and `message`; absent codes
are `null`. Raw error objects, stacks, driver topology dumps and documents are
never serialized. URI credentials (including encoded and multi-host credentials),
configured secrets and duplicate-key values are redacted.

With diagnostics enabled, checkout/catalog/payment wrappers preserve the original
error in a non-enumerable `cause`; nested causes are retained in memory. Each stage
logs its own error and immediate cause before the existing wrapper propagates.
Message readiness already propagates its original error and continues doing so.
With diagnostics disabled, wrapped readiness errors have their original shape,
and the logging adapter returns operation results/promises directly. Diagnostic
output failures do not change operation success or replace the original error.

## What to send back

Send all lines from the first `[db]` line through the last failure and Render's
process exit line. Keep the stage, error code and redacted message. Do not paste
environment values or credentials.

The following is an **illustration using a hypothetical duplicate**. It is not a
finding about the actual Render failure. Intermediate successful stages have
been omitted from this example:

```text
[db] {"stage":"Mongo connect","status":"PASS"}
[db] {"stage":"hello/topology","status":"PASS"}
[db] {"stage":"checkout readiness","status":"PASS"}
[db] {"stage":"catalog readiness","status":"START"}
[db] {"stage":"catalog createIndexes:CartItem/cartitems","status":"FAIL","name":"MongoServerError","code":11000,"message":"E11000 duplicate key error collection: test.cartitems index: cart_variant_unique dup key: [REDACTED]","cause":null}
[db] {"stage":"catalog readiness","status":"FAIL","name":"Error","code":"CATALOG_UNAVAILABLE","message":"Catalog cần unique indexes; kiểm tra dữ liệu trùng trước khi khởi động","cause":{"name":"MongoServerError","code":11000,"message":"E11000 duplicate key error collection: test.cartitems index: cart_variant_unique dup key: [REDACTED]"}}
Database startup failed: connection or required indexes unavailable
==> Exited with status 1
```

After obtaining the real error, remove `DB_STARTUP_DIAGNOSTICS` or set it to
`false`. Decide any connection/data/index fix from that evidence separately.

## Validation

```sh
node --test test/startup-diagnostics.test.js test/release.test.js test/checkout-standalone.test.js test/catalog.test.js test/payment.test.js
node scripts/check.js
git diff --check
```

The diagnostic tests inject connection/topology/index errors without network or
`.env` access. They check error/cause redaction, opt-in behavior, unchanged operation
order and fail-fast behavior, preservation of wrapper codes and messages, per-client
readiness caching/retry and resilience to a failing logging sink. Related integration
tests use temporary local MongoDB instances; they do not connect to Atlas.
