# Legacy data preparation

Required before deploying against an existing database. Extracted from the Batch 5 audit; no production migration has been run.


**Required before enabling this release against an existing database. No production database or media was touched during this batch.**

1. Back up the database and retain referenced image assets. Stop catalog/cart/review writers during cleanup and index installation. Rehearse on a restored staging copy first; do not run new app startup against an unclean dataset and assume indexes will succeed.
2. Inspect OrderItems without `productSnapshot` before changing catalog names/attributes or consolidating variants. Backfill only from reliable purchase records when available. Current catalog values are only a best-effort fallback, not proof of purchase-time facts. Missing/deleted historical facts cannot be reconstructed by this release. Preserve `price`/`quantity`; never overwrite existing snapshots. If no trustworthy historical source exists, retain the documented legacy fallback/placeholder limitation rather than claiming exact history.
3. Compute canonical size/color for **every** legacy variant, including archived records, with the exact rules below. Group by product + canonical size + canonical color **before** writing normalized values; an index on unnormalized legacy strings does not enforce the intended invariant.

   ```javascript
   const clean = value => String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
   const size = value => clean(value).toUpperCase();
   const color = value => clean(value).toLowerCase();
   // Review groups keyed by [String(v.idProduct), size(v.size), color(v.color)].
   // After resolving collisions, persist these canonical fields for every variant.
   ```

   Resolve each collision deliberately. Archiving a duplicate alone does not resolve it because archived combinations remain in the unique index. If consolidating true duplicate variants, first preserve reliable OrderItem snapshots, choose a surviving ID, reconcile stock against inventory records (do not blindly sum), and repoint CartItem, OrderItem and Review references together. Preserve an audit backup of removed duplicate records. Re-group affected cart rows afterwards. Do not arbitrarily rename variants or discard order history to make the index build pass.
4. Inspect duplicates using the read-only aggregation examples below. Cart duplicates for the same valid variant need one retained row and a checked, positive safe-integer quantity sum. Multiple carts for a user must be reconciled first. Review duplicates need a reviewed survivor and an audit copy of removed duplicates. Invalid/missing references must be repaired or quarantined deliberately. The Review partial index excludes legacy records without an ObjectId OrderItem; the API never creates such records. The full CartItem index also groups missing variant references as null, so multiple broken rows in one cart may require cleanup before indexing.

   ```javascript
   db.carts.aggregate([
     { $group: { _id: "$idUser", ids: { $push: "$_id" }, count: { $sum: 1 } } },
     { $match: { count: { $gt: 1 } } }
   ]);
   db.cartitems.aggregate([
     { $group: { _id: { cart: "$idCart", variant: "$idProductVariant" }, ids: { $push: "$_id" }, count: { $sum: 1 } } },
     { $match: { count: { $gt: 1 } } }
   ]);
   db.reviews.aggregate([
     { $match: { idOrderItem: { $type: "objectId" } } },
     { $group: { _id: "$idOrderItem", ids: { $push: "$_id" }, count: { $sum: 1 } } },
     { $match: { count: { $gt: 1 } } }
   ]);
   // Run after canonicalizing variant attributes; use the JS grouping above beforehand.
   db.productvariants.aggregate([
     { $group: { _id: { product: "$idProduct", size: "$size", color: "$color" }, ids: { $push: "$_id" }, count: { $sum: 1 } } },
     { $match: { count: { $gt: 1 } } }
   ]);
   ```

5. Recheck dangling references across Variant→Product, CartItem→Cart/Variant, OrderItem→Order/Variant and Review→OrderItem/Variant/User. Correct invalid price/stock/quantity/rating types and values from authoritative records. Unsupported old references remain visible/removable in carts; an already-broken order cannot be repaired merely by archive fields. No automatic destructive orphan cleanup is included.
6. Build the named unique indexes from the schemas, and verify `getIndexes()` shows the exact keys, `unique: true` and the Review partial filter. If an existing index has incompatible options, review it explicitly during the maintenance window; do not drop constraints as a runtime workaround. Confirm replica set/mongos transaction support and the Batch 2/4 indexes. Startup must complete successfully before reopening writes.
7. Missing `archivedAt` means active and needs no mandatory backfill. If any older import already uses a different inactive/deleted flag, explicitly map it to `archivedAt` and archive the children before reopening writes. Deploy backend and frontend together: admin reads moved to protected routes and Cart now includes nested product data. Smoke-test catalog/admin, stale removal, checkout replay and legacy order views on staging.

No automatic production migration is included: duplicate consolidation, inventory reconciliation and historical snapshots require decisions grounded in the real dataset.

