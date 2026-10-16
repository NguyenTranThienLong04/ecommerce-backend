# Điều tra Render startup — 16/10/2026

## Exact failing stage

**Chưa xác định được stage thất bại của tiến trình trên Render.** Log được cung cấp không chứa lỗi gốc. Không được chuyển kết quả từ máy local thành kết quả đã quan sát trên Render.

Đã kiểm tra commit `fb584f16ef05651bf793cc71df3df39522de4732`. Người dùng xác nhận URI trong `.env` dùng cùng Atlas cluster và tài khoản với Render. Tại 15:34 ngày 16/10/2026 (Asia/Saigon), chẩn đoán chỉ đọc từ máy local cho kết quả:

```text
Atlas connect/auth                  PASS (local, DNS resolver 1.1.1.1)
Selected database                   test
Replica-set/hello gate              PASS
Privileges createCollection/index   PRESENT
Order index definition              MATCH
Catalog index definitions           MATCH (Cart, CartItem, ProductVariant, Review)
PaymentAttempt collection/indexes   ABSENT (chưa thử tạo)
Message index definition            MATCH
Other declared indexes              MATCH (User, Product)
Duplicate unique-key groups         0
Normalized variant duplicate groups 0
Remote startup/index creation       NOT EXECUTED
Render server.listen                NOT REACHED (theo log lỗi được cung cấp)
```

`MATCH` là kết quả `listIndexes`, không có nghĩa đã chạy readiness helper thành công trên Atlas. Các helper gọi `createIndexes`, vì vậy không được gọi chúng trong điều tra chỉ đọc này.

## Exact root cause

**Chưa có bằng chứng xác định nguyên nhân gốc của lần exit 1 trên Render; dữ liệu/index hiện tại không chứng minh lỗi duplicate hoặc index-definition conflict.**

Cơ chế exit đã xác định: lỗi trong `connectDB` → disconnect → throw lỗi tổng quát → `server.js:37` chỉ log `error.message` và đặt `process.exitCode = 1`; HTTP server chưa được tạo/listen. Cơ chế này không chỉ ra thao tác gốc đã thất bại.

Không kết luận thiếu `paymentattempts` là nguyên nhân: startup được thiết kế để tạo collection/index chưa có. Không có dữ liệu PaymentAttempt nên không có duplicate payment key; cũng không có index payment cũ để xung đột. Việc tạo thực tế chưa được thử vì đó là thao tác ghi.

## Evidence

### Startup pipeline thực tế

```text
server.js main
  ├─ Nếu process.env.MONGO_URI chưa có: dotenv đọc .env (không phải .env.local)
  └─ start()
      ├─ configuration(env): validate NODE_ENV, URI prefix, JWT, URL, flags, ...
      ├─ require(src/app)(config): import routes/services và đăng ký 15 models
      ├─ connectDB(config.mongoUri)
      │   ├─ mongoose.connect: selection/connect timeout đều 5000 ms
      │   ├─ checkoutReady
      │   │   ├─ readyState/client
      │   │   ├─ admin hello: setName hoặc msg === isdbgrid
      │   │   └─ Order.createIndexes()
      │   ├─ catalogReady
      │   │   └─ Cart → CartItem → ProductVariant → Review.createIndexes()
      │   ├─ paymentReady
      │   │   ├─ checkoutReady (cache theo MongoClient)
      │   │   └─ PaymentAttempt.createIndexes()
      │   ├─ messageReady → Message.createIndexes()
      │   └─ createIndexes() lần lượt cho TẤT CẢ mongoose.modelNames()
      ├─ http.createServer + Socket.IO
      ├─ server.listen()
      └─ scheduler auto-cancel
```

Vòng cuối lặp lại cả những model đã được readiness helpers xử lý. Thứ tự model khi import app: `User, Category, Product, ProductVariant, Order, Cart, CartItem, Review, OrderItem, UserAddress, Conversation, ConversationUser, Message, Banner, PaymentAttempt`.

Ngoài chuỗi await trên, Mongoose 9.11.2 có `autoCreate=true`, `autoIndex=true` mặc định, nên model initialization còn tự tạo collection/index sau connect. Không được chạy `node server.js` trên Atlas như một phép kiểm tra chỉ đọc. Trình chẩn đoán dùng native `MongoClient`; Mongoose chỉ dùng để đọc schema khi chưa kết nối và đã tắt auto-create/index trong riêng tiến trình chẩn đoán.

`/health/ready` còn yêu cầu writable primary hoặc mongos, nhưng route chỉ chạy sau khi listen; không phải nguồn của log startup đã cung cấp. Startup chỉ kiểm tra `hello`, không mở transaction để chứng minh bằng thao tác ghi.

### Connection/config/topology

- `src/config/env.js` chỉ kiểm tra prefix `mongodb://` hoặc `mongodb+srv://`, rồi chuyển nguyên URI vào `mongoose.connect`. Không có override `dbName`.
- URI `.env` không có tên DB trong path; driver thực tế chọn `test`. URI production có thể ghi rõ `/test?...` để rõ mục đích; thiếu path không tự chứng minh lỗi ở trường hợp này.
- `directConnection` và replica set `rs0` chỉ thuộc cấu hình Docker/local, không bị hardcode vào connection code production.
- Timeout 5 giây là cấu hình hiện có; chưa có bằng chứng timeout trên Render, vì thế chưa sửa nó.
- `hello` thực tế: `setName=atlas-sanxrg-shard-0`, `isWritablePrimary=true`, `logicalSessionTimeoutMinutes=30`, `maxWireVersion=25`. Check của checkout chấp nhận response này.
- Tài khoản hiện tại có `atlasAdmin` và quyền `find`, `listCollections`, `listIndexes`, `createCollection`, `createIndex` trên DB. Chưa thử ghi để kiểm tra quota hoặc lỗi khi thực thi.
- Node DNS mặc định trên máy local báo `Error / ECONNREFUSED / querySrv`; Windows DNS resolve thành công. Chỉ riêng tiến trình chẩn đoán dùng `--dns-server=1.1.1.1` thì kết nối thành công. **Đây không phải bằng chứng lỗi DNS ở Render**, không đưa override DNS này vào ứng dụng.

### Inventory toàn bộ index khai báo

Mọi key dưới đây đều ascending `1`. Tất cả index schema đều `sparse=false`, không khai báo collation. Các index thực tế khớp cũng không có sparse/collation khác. Mỗi collection hiện có còn có index `_id_` mặc định.

| Collection | Index / fields | Unique | Partial filter | Helper | Atlas hiện tại |
| --- | --- | --- | --- | --- | --- |
| carts | `idUser_1`: idUser | true | không | catalog | MATCH |
| cartitems | `cart_variant_unique`: idCart, idProductVariant | true | không | catalog | MATCH |
| productvariants | `variant_combination_unique`: idProduct, size, color | true | không | catalog | MATCH |
| reviews | `review_order_item_unique`: idOrderItem | true | idOrderItem `$type: objectId` | catalog | MATCH |
| orders | `checkout_user_key_unique`: idUser, idempotencyKey | true | idempotencyKey `$type: string` | checkout | MATCH |
| paymentattempts | `payment_reference_unique`: reference | true | không | payment | ABSENT |
| paymentattempts | `payment_user_key_unique`: userId, idempotencyKey | true | idempotencyKey `$type: string` | payment | ABSENT |
| paymentattempts | `payment_provider_transaction_unique`: provider, merchant, providerTransactionNo | true | providerTransactionNo `$type: string` | payment | ABSENT |
| paymentattempts | `payment_order_status`: orderId, status | false | không | payment | ABSENT |
| paymentattempts | `payment_pending_expiry`: status, expiresAt | false | không | payment | ABSENT |
| messages | `message_sender_client_unique`: idUser, clientMessageId | true | clientMessageId `$type: string` | message | MATCH |
| products | `slug_1`: slug | true | không | vòng tất cả models | MATCH |
| users | `email_1`: email | true | không | vòng tất cả models | MATCH |

`banners`, `categories`, `conversations`, `conversationusers`, `orderitems`, `useraddresses`: schema không khai báo index khác, DB chỉ có `_id_`. Không có unique invariant cho Conversation/ConversationUser tại commit này. Không có TTL PaymentAttempt.

Đã đối chiếu cả name, thứ tự fields, unique, partial filter, sparse và collation. Không thấy existing-vs-expected conflict. MongoDB có thể từ chối index cùng định nghĩa nhưng tên khác; ở snapshot này các tên cũng khớp, không chỉ fields. [MongoDB createIndexes](https://www.mongodb.com/docs/manual/reference/command/createindexes/).

### Duplicate queries và legacy runbook

`scripts/diagnose-db-readonly.js` dùng aggregate cho từng unique index, áp dụng đúng partial filter, `$ifNull` cho missing/null, group theo đầy đủ key, rồi đếm nhóm có `count > 1`. Không có `$out`, `$merge` hoặc thao tác ghi. Không thấy duplicate ở cả 11 unique key definitions, kể cả các tập rỗng của PaymentAttempt.

Ví dụ query đã thực hiện cho CartItem:

```javascript
db.cartitems.aggregate([
  { $group: {
    _id: {
      idCart: { $ifNull: ["$idCart", null] },
      idProductVariant: { $ifNull: ["$idProductVariant", null] }
    }, count: { $sum: 1 }
  } },
  { $match: { count: { $gt: 1 } } }
]); // 0 nhóm
```

Đọc riêng projection `idProduct,size,color` của 42 variants và nhóm trong bộ nhớ bằng chính `normalizeSize/normalizeColor` của ứng dụng: NFKC → trim → collapse whitespace → upper size/lower color. Kết quả 42/42 chưa canonical, 0 nhóm trùng canonical. Không dump nội dung sản phẩm.

Runbook `docs/legacy-data.md` bước 3 chưa hoàn tất: canonical fields chưa được persist. Bước 6 chưa có đủ bộ payment indexes. Chưa chứng minh trạng thái backup, snapshot lịch sử, orphan reconciliation; không suy đoán các bước đó đã hoặc chưa được thực hiện. Index trên raw size/color không tự chạy Mongoose setters cho dữ liệu cũ; việc chưa canonical không tự làm index hiện tại fail.

### Bằng chứng lưu local và kiểm chứng

- `.cache/diagnostics/atlas-readonly.jsonl`: snapshot chỉ gồm trạng thái, quyền liên quan, metadata indexes và số liệu duplicate; không có credential. File ignored bởi Git.
- Command audit: `aggregate`, `connectionStatus`, `endSessions`, `find`, `hello`, `listCollections`, `listIndexes`. Không có create/update/delete/drop/index-write.
- `node --test test/release.test.js test/checkout-standalone.test.js`: **14/14 PASS**, DB MongoDB 7.0.24 tạm trên localhost.
- Một kiểm chứng bổ sung tạo hai CartItem giả trùng nhau trong DB tạm local. Log mới bắt được `MongoServerError`, code `11000`, stage `catalog indexes:CartItem/cartitems`; wrapper vẫn là `CATALOG_UNAVAILABLE`, payment chưa chạy. **Lỗi 11000 này là fixture local, không phải lỗi quan sát trên Atlas/Render.**
- Kiểm chứng redaction cho URI/username/password encoded và decoded/JWT/VNPay/Cloudinary/duplicate-key values; giữ nguyên error object và return value; logger mặc định im lặng và lỗi log sink không thay đổi startup result.

## Why Render only shows generic error

Tại commit gốc:

| Layer | Xử lý lỗi | Thông tin mất |
| --- | --- | --- |
| checkoutReady.js:19 | `catch {}` → CHECKOUT_UNAVAILABLE | original name, numeric code, message, cause, index/context |
| catalogReady.js:13 | `catch {}` → CATALOG_UNAVAILABLE | giống trên; model đang lỗi cũng không được giữ |
| paymentReady.js:17 | `catch {}` → PAYMENT_UNAVAILABLE | original Mongo error và nguyên nhân checkout lồng bên trong |
| messageReady.js | trả promise createIndexes | giữ lỗi gốc |
| database.js:11–15 | disconnect; Error mới `{ cause: error }` | giữ cause nhận được nhưng top-level name/code/message bị thay |
| server.js:37 | `console.error(error.message)` | không in cause/name/code/model/collection/index |

Chuỗi generic chỉ được tạo tại **một chỗ**, `src/config/database.js` (line 15 ở commit gốc; line 19 sau diagnostic patch). `CHECKOUT_UNAVAILABLE` có message riêng về replica set/mongos. Vì log được cung cấp là message generic, không thể mặc định kết luận topology/Order readiness đã reject theo nhánh CHECKOUT_UNAVAILABLE.

## Safe fix options

**Chưa thực hiện fix nào.** Chưa chọn sửa env, dữ liệu hoặc index khi chưa có lỗi gốc Render.

1. Thu thập lỗi kết nối ngay trong môi trường Render bằng probe chỉ đọc ở phần dưới. Nếu fail, stage/name/code/message sẽ xác định URI/auth/DNS/server-selection tương ứng; sửa đúng cấu hình sau khi có bằng chứng.
2. Nếu probe Render pass, vẫn cần lỗi gốc của startup/index operation để quy trách nhiệm. Diagnostic patch đã chuẩn bị ghi lỗi trước khi bị wrap. Không tự chạy startup trên Atlas trong đợt điều tra chỉ đọc này, vì startup có createCollection/createIndexes.
3. Chuẩn hóa 42 variants là công việc pre-deploy riêng: backup, rehearsal trên staging, tạm dừng writers, kiểm tra collision lại ở thời điểm thao tác rồi áp dụng canonical values có kiểm soát. Không cần tạo lại `variant_combination_unique` chỉ vì giá trị hiện chưa chuẩn hóa; index hiện hữu đang khớp.
4. Bộ PaymentAttempt cần được cài đủ trước khi mở dịch vụ: ba unique indexes và hai nonunique indexes trong bảng. Chưa có lý do drop/recreate các index khác. Việc cài index nằm ngoài phạm vi chỉ đọc hiện tại.

### Không có Render Shell

Đã chuẩn bị `.cache/diagnostics/render-readonly-start-command.txt`: một dòng `node -e '...'` có thể dùng làm **Start Command tạm thời** trong Render, không cần file mới được push lên deployment. Nó dùng `MONGO_URI` sẵn có trên Render, chỉ connect + hello, in name/code/message đã che credential, rồi kết thúc. Không khởi chạy `server.js`, không mở listener hoặc nhận request. Vì là probe, deployment này không trở thành dịch vụ ready; đọc Logs để lấy kết quả.

Lưu Start Command hiện tại trước khi thay đổi. Sau khi lấy log, cấu hình gốc là `node server.js`; khởi động lại lệnh gốc sẽ cho phép các thao tác tạo index của ứng dụng như trước và cần nằm trong đợt deploy được cho phép ghi. Không coi việc đổi command hoặc chạy probe là bản sửa lỗi. Chưa thực hiện thay đổi nào trên Render.

Source của probe nằm tại `scripts/diagnose-render-connection.js`; probe không nạp `.env` local. Không đưa URI hay password vào Start Command.

## Risk

- Không drop unique indexes, xóa duplicate tùy ý, bỏ readiness hoặc tắt transaction checks để deploy.
- Không đổi DB khỏi `test` hoặc tự chuẩn hóa dữ liệu khi chưa có kế hoạch dữ liệu được duyệt.
- Không gắn lỗi DNS local, missing PaymentAttempt hoặc canonicalization chưa hoàn tất thành nguyên nhân Render khi chưa có log chứng minh.
- Không chạy app/readiness helpers trên remote dưới danh nghĩa kiểm tra chỉ đọc; autoCreate/autoIndex và explicit createIndexes đều ghi metadata.

## Diagnostic changes

Chỉ thay đổi local; chưa commit, push hoặc deploy.

| File | Thay đổi |
| --- | --- |
| src/utils/startupDiagnostic.js:2 | Logger opt-in `DB_STARTUP_DIAGNOSTICS=true`; stage/status/name/code/message; redact secrets và duplicate values; rethrow nguyên error |
| src/config/database.js:3 | Gắn log quanh connect, từng readiness helper, vòng index cuối |
| src/utils/checkoutReady.js:6 | Log topology và Order indexes trước catch cũ |
| src/utils/catalogReady.js:6 | Log từng model/index operation trước catch cũ |
| src/utils/paymentReady.js:7 | Log PaymentAttempt index operation trước catch cũ |
| src/utils/messageReady.js:4 | Log Message index operation |
| scripts/diagnose-db-readonly.js:1 | Native-driver probe, index inventory, duplicate aggregates và canonical comparison |
| scripts/diagnose-render-connection.js:1 | Probe connection/topology dành cho Render; không cần server.js |

Không thay logic nghiệp vụ, thứ tự readiness, timeout, index definitions hoặc public error messages. Có thể tắt logging bằng cách bỏ `DB_STARTUP_DIAGNOSTICS`; sau khi có nguyên nhân nên revert riêng 5 file instrumentation cùng logger tạm, giữ báo cáo nếu hữu ích. Không dùng hard reset ảnh hưởng thay đổi khác.

Thông tin còn thiếu để trả lời chính xác câu hỏi cuối cùng: **stage và lỗi gốc phát sinh trong môi trường Render**, trước khi `database.js`/readiness helpers thay message. Các số liệu Atlas hiện tại đã được kiểm tra; không nên thay thế phần chứng cứ còn thiếu bằng phỏng đoán.
