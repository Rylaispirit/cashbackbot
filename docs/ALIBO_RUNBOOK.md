# Alibo Browser Automation Runbook

ChotDeal tạo link Taobao/Tmall/1688 bằng Playwright, dùng session Alibo đã login sẵn. Bot không lưu password. Đơn Alibo vẫn đối soát bằng CSV hoặc admin command vì hiện chưa có postback/API đơn hàng ổn định.

## 1. Cấu hình bắt buộc

```env
ALIBO_MASTER_REF=18935
ALIBO_AUTOMATION_MODE=browser
ALIBO_LINK_TYPE=discount
ALIBO_LINK_CREATOR_URL=<URL trang tạo link chiết khấu trong dashboard Alibo>
ALIBO_STORAGE_STATE_BASE64=<base64 từ script capture session>
ALIBO_BROWSER_TIMEOUT_MS=45000
ALIBO_BROWSER_RESTART_EVERY=100
ALIBO_DEFAULT_USER_RATE=60
```

`ALIBO_LINK_TEMPLATE` chỉ là fallback cũ. Khi `ALIBO_AUTOMATION_MODE=browser`, bot không dùng template.

## 2. Lấy URL trang tạo link chiết khấu

1. Login [Alibo](https://alibo.vn).
2. Vào trang/tính năng tạo link Taobao.
3. Chọn đúng loại `link chiết khấu`.
4. Copy URL trên thanh địa chỉ vào `ALIBO_LINK_CREATOR_URL`.

Nếu có nhiều tab như `link quảng cáo` và `link chiết khấu`, hãy copy URL sau khi đã mở tab `link chiết khấu`.

## 3. Capture session local

```powershell
cd D:\1_DU_AN\cashbackbot
npm run alibo:capture-session
```

Browser sẽ mở ra. Bạn login Alibo thủ công, vào đúng trang tạo link chiết khấu, rồi quay lại terminal nhấn Enter.

Script sẽ in ra:

```env
ALIBO_STORAGE_STATE_BASE64=...
```

Copy giá trị này vào Railway Variables. File session local được lưu trong `.secrets/` và đã được `.gitignore`, không commit lên Git.

## 4. Test automation trước khi public

```powershell
npm run alibo:test-browser -- --url=https://item.taobao.com/item.htm?id=123456789
```

Kỳ vọng output là link dạng `https://s.click.taobao.com/...`, `https://m.tb.cn/...` hoặc link rút gọn hợp lệ mà Alibo tạo ra.

Nếu lỗi `session_expired`, chạy lại `npm run alibo:capture-session` rồi cập nhật Railway env.

## 5. Bật Railway

Thêm/cập nhật các biến trên Railway:

```env
ALIBO_MASTER_REF=18935
ALIBO_AUTOMATION_MODE=browser
ALIBO_LINK_TYPE=discount
ALIBO_LINK_CREATOR_URL=<URL thật>
ALIBO_STORAGE_STATE_BASE64=<base64 thật>
ALIBO_BROWSER_TIMEOUT_MS=45000
ALIBO_BROWSER_RESTART_EVERY=100
ALIBO_DEFAULT_USER_RATE=60
```

Railway sẽ redeploy. Sau deploy, test:

```text
/start
paste link Taobao/Tmall/1688
```

Bot phải nhắn đang tạo link, sau đó trả link chiết khấu.

Runtime safeguard đã có trong code:

- Browser automation chạy tuần tự FIFO để tránh nhiều Chromium cùng lúc làm Railway Hobby OOM.
- Một Chromium instance được dùng lại, mỗi request tạo browser context riêng.
- Chromium tự restart sau `ALIBO_BROWSER_RESTART_EVERY` request.
- Log Railway có dòng `alibo browser createLink: result=ok|fail ... ms=... queueMs=...`.
- Nếu session hết hạn hoặc thiếu config, bot gửi alert một lần tới admin đầu tiên trong `TELEGRAM_ADMIN_IDS`.

## 6. Reconcile đơn Alibo

Manual một đơn:

```text
/admin_alibo_pending
/admin_alibo_match <sub_id_prefix> <ALIBO_ORDER_ID> <commission_vnd> <sale_amount_vnd> pending
```

CSV nhiều đơn:

```powershell
npm run reconcile:alibo -- --file=data/alibo-report.csv --dry
npm run reconcile:alibo -- --file=data/alibo-report.csv --status=pending
```

Khi Alibo xác nhận đơn, chạy lại với `--status=approved` hoặc dùng admin command để chuyển trạng thái.

## 7. Troubleshooting nhanh

| Lỗi | Cách xử lý |
|---|---|
| Bot báo Taobao chưa mở public | Thiếu `ALIBO_LINK_CREATOR_URL` hoặc `ALIBO_STORAGE_STATE_BASE64` |
| `session_expired` | Capture session lại và cập nhật Railway env |
| `input_not_found` | URL creator chưa đúng trang tạo link, hoặc UI Alibo đổi |
| `result_not_found` | Alibo không trả link trong 45s, thử lại hoặc tăng `ALIBO_BROWSER_TIMEOUT_MS` |
| Railway thiếu Chromium | Kiểm tra build log `playwright install chromium`; nếu thiếu Linux deps thì chuyển sang Dockerfile hoặc bổ sung deps theo log |

## 8. Hosting free / low-cost cho Taobao browser automation

Playwright Chromium ngốn 250-400MB RAM/instance → Railway Hobby ($5, 512MB) tight, có thể OOM khi peak. Dưới đây là 3 phương án free / hybrid khi chưa có ngân sách Railway Pro.

### Option 1 — PC cá nhân + Cloudflare Tunnel (recommend cho beta)

**Cost:** $0 forever. **Setup:** 15 phút.

```powershell
# 1. Cài cloudflared
winget install --id Cloudflare.cloudflared

# 2. Terminal 1: chạy bot local
npm run start:prod

# 3. Terminal 2: expose ra Internet
cloudflared tunnel --url http://localhost:3000
# → in ra https://abc-xyz.trycloudflare.com

# 4. Update Accesstrade postback URL về URL Cloudflare vừa cấp
```

Bot cũng có script gộp 2 terminal thành 1 lệnh:

```powershell
npm run start:tunnel
```

Script này tự build app, chạy `node dist/main` với `TELEGRAM_UPDATES_MODE=polling`, chạy `cloudflared tunnel --url http://localhost:3000`, rồi in sẵn URL postback Accesstrade để bạn copy. Nếu vừa build xong và muốn start nhanh hơn:

```powershell
npm run start:tunnel -- --skip-build
```

**Ưu điểm:** Playwright chạy mượt trên 8GB+ RAM của PC, $0 cost.
**Nhược:** Tắt PC = bot down. URL random nếu không có domain riêng.

**Fix URL random — named tunnel với domain free:**

```powershell
cloudflared tunnel login                          # login Cloudflare
cloudflared tunnel create chotdeal                # tạo tunnel có ID cố định
cloudflared tunnel route dns chotdeal chotdeal.<your-domain>
cloudflared tunnel run chotdeal                   # URL cố định
```

Domain rẻ: Namecheap `.xyz` $1/năm, hoặc Cloudflare Registrar at-cost.

**Tránh PC sleep:** Settings → Power → Never sleep. Hoặc lên `caffeinate`/`Insomnia` keep-alive tool.

### Option 2 — Oracle Cloud Always Free (recommend long-term)

**Cost:** $0 forever. **Setup:** 2-3h.

Oracle cấp miễn phí vĩnh viễn:
- ARM Ampere A1: **4 core + 24GB RAM + 200GB SSD**
- Đủ chạy 50 Chromium instance cùng lúc

**Steps:**
1. cloud.oracle.com → sign up (cần credit card verify, không charge)
2. Region Singapore (latency ~30ms từ VN)
3. Create Compute → Ubuntu 22.04 ARM Ampere A1 (4 OCPU + 24GB)
4. SSH vào, install Node 20 + Postgres + nginx + certbot
5. `git clone` repo, `npm install`, `pm2 start dist/main.js`
6. nginx reverse proxy + Let's Encrypt SSL

**Ưu điểm:** RAM khủng, free vĩnh viễn, full control.
**Nhược:** Setup khó hơn Railway, Oracle đôi khi reject account VN, KYC phức tạp.

### Option 3 — Hybrid: Railway free + browser worker tại PC (advanced)

**Cost:** $0 đến $5/tháng. **Setup:** 4h.

```
Railway Hobby ($5 credit ~3 tuần)
├── Bot Nest core (chỉ AT — Shopee/Lazada/Tiki/TikTok)
├── PostgreSQL (Supabase free)
├── Webhook receive postback AT
└── Push job vào Redis queue khi user paste Taobao
                ↓
PC local hoặc Oracle Free
└── Worker subscribe Redis → chạy Playwright → trả link qua Redis
                ↓
Railway pop result → gửi user qua Telegram
```

Bot core không cần Chromium → fit Railway Hobby 512MB dễ. Browser worker tách ra chạy chỗ rảnh RAM.

**Tools:** Upstash Redis free tier 10k commands/day = đủ cho 100 user.

**Ưu điểm:** Tách concern, scale uptime tốt, AT vẫn 24/7 dù PC tắt.
**Nhược:** Phức tạp nhất, phải code message queue + worker process.

### Option 4 — AT-only mode (đơn giản nhất nếu chưa cần Taobao)

**Cost:** $0-5/tháng. Khi `ALIBO_AUTOMATION_MODE=disabled`:

```env
ALIBO_AUTOMATION_MODE=disabled
```

Bot chỉ phục vụ Shopee/Lazada/Tiki/TikTok. Memory ~80MB → Railway Hobby thoải mái. Khi user paste Taobao → bot báo "đang phát triển, sắp ra mắt".

Đây là chiến lược **lean MVP**: ship core trước (95% revenue tới từ Shopee), Taobao bổ sung sau khi có ngân sách.

### Quyết định nhanh

| Tình huống bạn | Pick |
|---|---|
| Đang test 5-20 friend, chưa có user thật | **Option 1** (PC + Cloudflare Tunnel) |
| Có 50-500 user, cần 24/7 ổn định | **Option 2** (Oracle Free) hoặc Railway $5 |
| Có 500+ user, có doanh thu | Railway Pro $20 hoặc VPS Vultr $6 Singapore |
| Chỉ muốn test AT trước, Taobao chưa cần | **Option 4** (AT-only) trên Railway Hobby |

### Optimization cho Railway Hobby (nếu vẫn dùng $5)

Đã có sẵn trong code:
- Browser singleton FIFO queue → không spawn nhiều Chromium đồng thời
- Auto restart Chromium sau N requests (ALIBO_BROWSER_RESTART_EVERY)
- Context cleanup sau mỗi request

Thêm bước manual:
- Set `ALIBO_BROWSER_RESTART_EVERY=20` (giảm từ 100) để Chromium recycle thường xuyên hơn
- `--memory-pressure-off` Chromium flag (nếu service support)
- Monitor Railway memory: nếu chạm 450MB liên tục → cần upgrade hoặc move

### UptimeRobot — keep-alive + alert miễn phí

```
1. uptimerobot.com → sign up free
2. Add Monitor:
   URL: https://chotdeal-production.up.railway.app/health
   Interval: 5 min
3. Alert: email + Telegram (qua bot @uptimerobot_bot)
```

Tác dụng: bot bị crash → bạn biết trong 5 phút thay vì user complain.
