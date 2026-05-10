# BotFather Setup — ChotDeal

Sau khi đã có token, mở `@BotFather` và cấu hình lần lượt:

## 1. `/setname`

```text
ChotDeal — Hoàn tiền mua sắm
```

## 2. `/setdescription`

```text
🎯 ChotDeal — Bot cashback cho Shopee. Lazada, Tiki, TikTok Shop sẽ mở dần.

Cách dùng:
1. Copy link sản phẩm
2. Paste vào bot
3. Mua hàng qua link bot trả về
4. Đơn duyệt → tiền tự về ví
```

## 3. `/setabouttext`

```text
Bot hoàn tiền (cashback) cho Shopee. Lazada, Tiki, TikTok Shop sẽ mở dần.
```

## 4. `/setcommands`

Paste nguyên khối sau:

```text
start - Bắt đầu / xem hướng dẫn
balance - Xem số dư cashback
history - Lịch sử giao dịch
deals_on - Nhận deal hot Shopee/Taobao
deals_off - Tắt nhận deal hot
deal_settings - Trạng thái nhận deal
setbank - Cài tài khoản nhận tiền
withdraw - Yêu cầu rút tiền
help - Xem lại hướng dẫn
cancel - Huỷ thao tác đang làm
```

## 5. `/setuserpic`

Khuyến nghị avatar vuông 512x512.

## 6. `/setprivacy`

```text
Disable
```

## 7. `/setjoingroups`

Khuyến nghị ban đầu:

```text
Disable
```

## 8. Inline mode

`/mybots` → chọn bot → `Bot Settings` → `Inline Mode` → `Disable`

## Kiểm tra cuối

1. Mở chat với bot
2. Gõ `/start`
3. Xác nhận menu lệnh có `/history`
