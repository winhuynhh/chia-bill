# Billing Master v3.1 (Vercel)

Chia tiền nhóm, chạy trên Vercel Serverless + Redis/KV.

## Tính năng

- **Đăng nhập Google**, lần đầu bắt buộc đăng ký **tài khoản nhận tiền** (MoMo hoặc ngân hàng).
- **Nhóm theo thành viên** (không còn "ai biết mã là vào được"):
  - Ai tạo nhóm thì **tự động là trưởng nhóm và thành viên** của nhóm đó.
  - Trưởng nhóm **mời qua email**. Người được mời nhận email có **link + mã nhóm**.
  - Người được mời đăng nhập Google bằng đúng email đó, thấy mục **Lời mời**, bấm **Đồng ý** mới được tính là thành viên (hoặc **Từ chối**).
  - Mỗi người chỉ thấy các nhóm mình **đã tham gia** và các **lời mời đang chờ**.
- **Admin** (`nghiahnt.dn@gmail.com`): thấy **tất cả nhóm**, mở và chỉnh sửa mọi nhóm, **đổi mã nhóm**, **xóa nhóm**.
- **Rời nhóm**: thành viên có thể rời. Sau khi rời họ không xem được nhóm, nhưng tên, các khoản chi và tài khoản nhận tiền vẫn được giữ (hiện "đã rời") để cả nhóm quyết toán. Được mời lại sẽ nối đúng lịch sử cũ.
- **Lọc giao dịch**: tất cả, chưa settle (sau lần settle gần nhất), 7/30 ngày, tháng này hoặc khoảng ngày tùy chọn. Bộ lọc chỉ áp dụng cho danh sách và bảng; số dư và quyết toán luôn tính toàn bộ.
- **Settle up**: ai chuyển cho ai bao nhiêu (ít giao dịch nhất), kèm thông tin MoMo/ngân hàng của người nhận, nút "Đã trả" để ghi nhận.

| Việc | Admin | Trưởng nhóm | Thành viên | Người được mời (chưa đồng ý) |
|---|---|---|---|---|
| Xem / nhập hóa đơn, Settle up | ✔ | ✔ | ✔ | ✘ |
| Mời / huỷ lời mời | ✔ | ✔ | ✘ | ✘ |
| Xóa nhóm | ✔ | ✔ | ✘ | ✘ |
| Đổi mã nhóm | ✔ | ✘ | ✘ | ✘ |
| Rời nhóm | – | ✘ (chỉ xóa được nhóm) | ✔ | – |

```
billing-master/
├── public/index.html     giao diện
├── api/_lib.js           session, quyền admin/trưởng nhóm, kiểm tra thông tin nhận tiền (không phải route)
├── api/_mail.js          gửi email lời mời qua SMTP (không phải route)
├── api/config.js         trả GOOGLE_CLIENT_ID cho giao diện
├── api/auth.js           xác minh Google token -> cấp session token
├── api/profile.js        tài khoản nhận tiền của người đăng nhập
├── api/groups.js         tạo nhóm, mời, đồng ý/từ chối, admin đổi mã/xóa
├── api/data.js           dữ liệu chia tiền của nhóm (chỉ thành viên/admin)
└── package.json
```

## Cấu hình (làm 1 lần trên Vercel: Settings → Environment Variables)

| Tên | Bắt buộc | Giá trị |
|---|---|---|
| `GOOGLE_CLIENT_ID` | có | OAuth Client ID (xem bước 1) |
| `SESSION_SECRET` | có | chuỗi ngẫu nhiên dài (≥ 32 ký tự) |
| `SMTP_USER` | để gửi email | Gmail dùng để gửi lời mời, vd `nghiahnt.dn@gmail.com` |
| `SMTP_PASS` | để gửi email | **App Password** 16 ký tự của Gmail đó (xem bước 2) |
| `SMTP_HOST` / `SMTP_PORT` | không | mặc định `smtp.gmail.com` / `465` |
| `MAIL_FROM` | không | tên hiển thị người gửi, mặc định `Billing Master <SMTP_USER>` |
| `APP_URL` | không | domain app, vd `https://billing-master.vercel.app` (mặc định tự lấy theo domain đang truy cập) |
| `ADMIN_EMAILS` | không | danh sách email admin, cách nhau bằng dấu phẩy (mặc định `nghiahnt.dn@gmail.com`) |

Ngoài ra project cần database Redis/KV (có sẵn `KV_REST_API_URL`, `KV_REST_API_TOKEN`).

### 1. Google OAuth Client ID
1. https://console.cloud.google.com → tạo project → **APIs & Services → OAuth consent screen**: *External*, điền tên app + email hỗ trợ, lưu, rồi **Publish app** (In production) để ai cũng đăng nhập được.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. **Authorized JavaScript origins**: thêm domain Vercel, vd `https://billing-master-xxxx.vercel.app`. Không cần Redirect URI.
4. Copy **Client ID** vào `GOOGLE_CLIENT_ID`.

### 2. Gmail App Password (để app gửi email lời mời)
1. Đăng nhập Gmail dùng để gửi (vd `nghiahnt.dn@gmail.com`) → https://myaccount.google.com/security → bật **Xác minh 2 bước** nếu chưa bật.
2. Vào https://myaccount.google.com/apppasswords → đặt tên "Billing Master" → **Create** → copy chuỗi 16 ký tự.
3. Dán vào `SMTP_PASS` (có khoảng trắng cũng được), `SMTP_USER` là địa chỉ Gmail đó.
4. Gmail miễn phí gửi được khoảng 500 email/ngày, quá đủ cho app này.

**Chưa cấu hình email?** App vẫn chạy: lời mời vẫn được tạo (người được mời vẫn thấy khi đăng nhập), giao diện sẽ hiện nút **Sao chép lời mời** để trưởng nhóm gửi link + mã qua Zalo/Messenger.

### 3. Deploy
Upload đè code lên GitHub (có file mới trong `api/`, và `package.json` có thêm `nodemailer`), rồi **Redeploy**.

## Cách dùng
1. Đăng nhập Google, đăng ký tài khoản nhận tiền (lần đầu).
2. **Tạo nhóm mới** (đặt mã nhóm, vd `di-da-lat`) → bạn là trưởng nhóm.
3. Trong nhóm, mục **Tài khoản đã tham gia nhóm** → nhập email người cần mời → **Gửi lời mời**.
4. Người được mời mở email, bấm link (hoặc vào app) → đăng nhập Google bằng **đúng email được mời** → **Đồng ý**.
5. Nhập hóa đơn, cuối kỳ bấm **SETTLE UP**.

## Lưu ý
- Lời mời gắn với **email Google**. Người được mời phải đăng nhập bằng đúng email mà trưởng nhóm đã nhập.
- Dữ liệu nhóm tạo từ các bản trước (chưa có thành viên) sẽ không hiện trong danh sách nhóm. Hãy tạo lại nhóm; nếu trùng mã với nhóm cũ sẽ báo "Mã nhóm đã tồn tại", hãy đặt mã khác.
- Link MoMo trong Settle up có dạng `https://nhantien.momo.vn/<SĐT>/<số tiền>`; nếu MoMo đổi định dạng chỉ cần sửa hàm `momoLink()` trong `public/index.html`.
- App không tự chuyển tiền; người dùng chuyển trong MoMo / app ngân hàng, app chỉ ghi nhận.

## API
Mọi request (trừ `/api/config`, `/api/auth`) cần header `Authorization: Bearer <token>`.

- `POST /api/auth` `{ credential }` → `{ token, user, profile }`
- `GET /api/profile`, `POST /api/profile` `{ pay }`
- `GET /api/groups` → `{ isAdmin, groups, invites, all? }` (`all` chỉ có với admin)
- `POST /api/groups` với `action`: `create` | `accept` | `decline` | `invite` (`emails`) | `cancelInvite` (`email`) | `leave` | `rename` (`newCode`, admin) | `delete` (trưởng nhóm hoặc admin)
- `GET /api/data?groupId=...`, `POST /api/data` với `action`: `addUser` | `addExpense` | `deleteExpense` | `setPayInfo` | `linkMe`
