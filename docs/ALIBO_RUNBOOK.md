# Alibo.vn Integration Runbook

Hướng dẫn cấu hình alibo.vn cho ChotDeal — từ lấy pub_id đến reconcile đơn hàng.

---

## Bước 1 — Lấy Master Ref (pub_id) từ alibo dashboard

### 1.1. Đăng nhập

Vào https://alibo.vn/login → đăng nhập tài khoản master ChotDeal.

### 1.2. Tìm Pub ID / User ID

3 vị trí khả dĩ:

**A. Avatar góc phải → Profile / Tài khoản**
- Tìm dòng "ID:", "User ID:", "Mã giới thiệu:" hoặc "Mã đại lý:"
- Format thường là số (vd `123456`) hoặc chuỗi (vd `chotdeal_xyz`)

**B. Trang "Mời bạn bè" / "Giới thiệu"**
- alibo có chương trình thưởng giới thiệu — họ sẽ cấp mỗi user 1 referral code
- URL referral kiểu: `https://alibo.vn/?ref=ABC123` → `ABC123` chính là pub_id

**C. Trang "Link quảng cáo" / "Tạo link"**
- Khi tạo 1 link quảng cáo, URL kết quả sẽ chứa pub_id

### 1.3. Lưu lại

Pub_id = giá trị copy được từ trên. Vd: `chotdeal_master_123` hoặc `654321`.

---

## Bước 2 — Reverse-engineer URL pattern "Link quảng cáo"

### 2.1. Mở tab DevTools

Trên Chrome: F12 → Network tab → check "Preserve log".

### 2.2. Tạo 1 link quảng cáo mẫu

1. Trong dashboard alibo, tìm tính năng **"Link quảng cáo"** / **"Tạo link giới thiệu"**.
2. Paste 1 link Taobao test (vd `https://item.taobao.com/item.htm?id=12345`).
3. Click "Tạo link".

### 2.3. Lấy 2 thông tin

**A. URL kết quả** (cái user click vào sẽ ra alibo rồi redirect Taobao):
```
Vd: https://alibo.vn/r/abc123?u=https%3A%2F%2Fitem.taobao.com%2Fitem.htm%3Fid%3D12345
hoặc: https://shorten.alibo.vn/xyz789
hoặc: https://m.tb.cn/h.xxx?sm=ABCXYZ
```

**B. Network request** (xem DevTools Network tab):
- Tìm request POST vừa thực hiện
- Copy: URL endpoint, headers (Authorization/Cookie), body
- Nếu thấy endpoint kiểu `https://alibo.vn/api/...` → có thể auto hoá sau (Phase A2)

### 2.4. Phân tích pattern

Có 3 trường hợp:

#### Case 1: URL có đầy đủ `pub_id` + `original_url` ➡️ TỐT NHẤT
```
https://alibo.vn/r/{pub_id}?u={taobao_url}
                 ^master_ref     ^url
```
→ Bot wrap được mọi link Taobao của user mà không cần gọi API.

Set trong `.env`:
```env
ALIBO_LINK_TEMPLATE=https://alibo.vn/r/{master_ref}?u={url}
```

#### Case 2: URL chỉ có `pub_id`, không nhận URL gốc ➡️ KHÔNG WORK
```
https://alibo.vn/r/abc123
```
→ Pattern này chỉ trỏ về trang cá nhân alibo — không track được sản phẩm cụ thể.
→ Cần Phase A2: dùng Puppeteer headless tự động tạo link cho từng product.

#### Case 3: URL có `pub_id` + custom `sub_id` slot ➡️ TỐT NHẤT (xa)
```
https://alibo.vn/r/abc123?u={taobao_url}&utm_source={SUB_ID}
                                          ^^^^^^^^^^^^^^^^^^^^
                                          alibo support pass-through
```
→ Mỗi user click có sub_id riêng, alibo report sẽ kèm sub_id → reconcile 100% tự động.

Set trong `.env`:
```env
ALIBO_LINK_TEMPLATE=https://alibo.vn/r/{master_ref}?u={url}&utm_source={sub_id}
```

→ **Test xem alibo có support `utm_source` / `sub_id` / `aff_sub` không** bằng cách thêm `&utm_source=test123` vào URL → click → đặt 1 đơn nhỏ → check report alibo có thấy `test123` không.

---

## Bước 3 — Cấu hình `.env` (local + Railway)

### 3.1. Local `.env`

```env
# ===== Alibo.vn (Taobao/Tmall/1688) =====
ALIBO_MASTER_REF=<pub_id_từ_bước_1>
ALIBO_LINK_TEMPLATE=<template_từ_bước_2>
# vd: ALIBO_LINK_TEMPLATE=https://alibo.vn/r/{master_ref}?u={url}&utm_source={sub_id}
ALIBO_DEFAULT_USER_RATE=60
```

### 3.2. Railway production

Vào Railway dashboard → ChotDeal project → Variables → Add:
- `ALIBO_MASTER_REF` = same as local
- `ALIBO_LINK_TEMPLATE` = same as local
- `ALIBO_DEFAULT_USER_RATE` = `60`

Railway sẽ tự redeploy.

---

## Bước 4 — Test E2E ở local

```powershell
cd D:\1_DU_AN\cashbackbot
npm run start:dev

# Trên Telegram, paste 1 link Taobao bất kỳ
# Vd: https://item.taobao.com/item.htm?id=666555444
# Bot phải trả: https://alibo.vn/r/<your_master_ref>?u=...

# Click vào link bot vừa trả → phải redirect tới Taobao đúng sản phẩm
# Nếu cookie tracking OK, đặt 1 đơn nhỏ qua dịch vụ vận chuyển hộ

# Check Telegram: /history → phải thấy "Link chờ ghi nhận: Taobao"
```

---

## Bước 5 — Reconcile khi alibo đã ghi nhận đơn

### 5.1. Manual command (1 đơn)

```
/admin_alibo_pending
```
Bot list ra link Taobao chưa có transaction.

```
/admin_alibo_match tg<sub_prefix> ALIBO_ORDER_ID 50000 500000 pending
```
- `tg<sub_prefix>`: 8-12 ký tự đầu của subId (lấy từ output trên)
- `ALIBO_ORDER_ID`: mã đơn lấy từ alibo dashboard
- `50000`: commission gross VND (alibo trả về)
- `500000`: sale amount (giá đơn)
- `pending`: status (`pending`/`approved`/`rejected`)

Khi alibo confirm đơn (sau 7-30 ngày), chạy lại với cùng `ALIBO_ORDER_ID` nhưng status = `approved`.
Bot sẽ tự chuyển balance từ pending sang available và gửi notify cho user.

### 5.2. Batch via CSV (nhiều đơn)

Khi alibo cho export CSV report (thường là tab "Đơn hàng" / "Báo cáo" → nút "Export"):

```powershell
# Save file CSV vào D:\1_DU_AN\cashbackbot\data\alibo-report-2026-05.csv
npm run reconcile:alibo -- --file=data/alibo-report-2026-05.csv --status=pending
```

Script sẽ:
1. Đọc CSV
2. Với mỗi row, parse `taobao_item_id`, `commission`, `order_id`, `click_time`
3. Match với Link DB theo `sub_id`, hoặc `item_id` + thời gian click trong cửa sổ ±48h
4. Tạo transaction mới, hoặc update status nếu order đã tồn tại
5. In report: created / updated / unmatched / skipped no-change

> Format CSV cần map cụ thể với header alibo export — bạn paste 1 file mẫu (5 dòng đầu) cho mình → mình adjust parser.

---

## Bước 6 — Update BotFather: thêm `/setbank` info Trung Quốc nếu cần

Nếu sau test thấy luồng OK, update Telegram bot description bằng `@BotFather`:

```
/setdescription → ChotDeal:
🎯 ChotDeal - Bot cashback cho Shopee và hàng Trung Quốc.
🇨🇳 Taobao, Tmall, 1688 cần dịch vụ vận chuyển hộ.
```

---

## Phase A2 (sau khi A1 ổn) — Tự động hóa

Khi đã có >50 đơn alibo reconcile thủ công và bạn muốn auto:

### Option Puppeteer headless

Thêm script `src/affiliate/alibo-puppeteer.service.ts`:
- Login alibo bằng cookie/session
- Navigate đến trang "Tạo link"
- Fill input Taobao URL
- Click "Tạo"
- Extract URL kết quả

→ Chậm hơn (1-3s/link) nhưng tránh manual hoàn toàn.

### Option scrape report endpoint

Nếu Bước 2.3 phát hiện endpoint `https://alibo.vn/api/orders` (hoặc tương tự):
- Bot poll endpoint mỗi 1h
- Auto match với Links → tạo Transactions
- Notify user khi có cashback mới

→ Cleanest nhưng phụ thuộc alibo không thay đổi API.

---

## Troubleshooting

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Bot trả "Cashback Taobao chưa cấu hình" | Thiếu `ALIBO_MASTER_REF` | Fill env, restart bot |
| Click link bot trả về 404 | Template URL sai | Test pattern lại bằng tab Network |
| Click link redirect Taobao OK nhưng alibo không ghi đơn | Tracking bị mất | Cookie alibo bị clear giữa chừng — user cần extension/app alibo |
| `/admin_alibo_match` báo "không tìm thấy subId" | Sub prefix quá ngắn / sai | Dùng `/admin_alibo_pending` xem prefix đúng |
| `/admin_alibo_match` báo "order đã tồn tại nhưng thuộc subId khác" | CSV/admin đang match sai link | Kiểm tra lại `/admin_link <subId>` và order trên dashboard |
