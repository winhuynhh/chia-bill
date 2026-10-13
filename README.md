# Billing Master v2 (Vercel)

Chia tiền nhóm, chạy trên Vercel Serverless + Redis/KV.

- **Đăng nhập chỉ bằng Google.** Không cần đăng nhập MoMo hay ngân hàng.
- **Lần đầu đăng nhập bắt buộc đăng ký tài khoản nhận tiền** (MoMo hoặc ngân hàng). Chưa đăng ký thì chưa dùng được app.
- **Settle up** hiện ai chuyển cho ai bao nhiêu, kèm thông tin nhận tiền của người nhận (MoMo hoặc ngân hàng).

```
billing-master/
├── public/index.html     giao diện
├── api/_lib.js           ký/verify session, kiểm tra SĐT, kiểm tra thông tin nhận tiền (không phải route)
├── api/config.js         trả GOOGLE_CLIENT_ID cho giao diện
├── api/auth.js           xác minh Google token -> cấp session token
├── api/profile.js        đọc/lưu tài khoản nhận tiền của người đăng nhập
├── api/data.js           dữ liệu nhóm (cần đăng nhập)
└── package.json
```

## Cấu hình bắt buộc (làm 1 lần)

### 1. Tạo Google OAuth Client ID
1. Vào https://console.cloud.google.com → tạo project mới (hoặc dùng project có sẵn).
2. **APIs & Services → OAuth consent screen**: chọn *External*, điền tên app + email hỗ trợ, lưu.
   Sau đó bấm **Publish app** (chuyển sang *In production*). Nếu để *Testing*, chỉ các email trong danh sách Test users mới đăng nhập được.
   App chỉ xin quyền cơ bản (email, profile) nên không cần Google xét duyệt.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → loại **Web application**.
4. Mục **Authorized JavaScript origins** thêm domain Vercel của bạn, ví dụ `https://billing-master-xxxx.vercel.app`
   (thêm `http://localhost:3000` nếu muốn chạy thử local). Không cần Redirect URI.
5. Copy **Client ID** (dạng `xxxx.apps.googleusercontent.com`).

### 2. Thêm biến môi trường trên Vercel
Project → **Settings → Environment Variables**, thêm:

| Tên | Giá trị |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID vừa copy |
| `SESSION_SECRET` | chuỗi ngẫu nhiên dài, tạo bằng `openssl rand -base64 32` |

Cùng chỗ đó kiểm tra có `KV_REST_API_URL` và `KV_REST_API_TOKEN` (do database Redis/KV tự thêm).

### 3. Redeploy
Đẩy code mới lên GitHub (upload đè lên file cũ, nhớ có thêm các file mới trong `api/`), rồi **Deployments → Redeploy** để biến môi trường có hiệu lực.

## Cách dùng
1. Đăng nhập Google. Lần đầu sẽ hiện form **Đăng ký tài khoản nhận tiền**: chọn **MoMo** (SĐT + tên MoMo) hoặc **Ngân hàng** (tên ngân hàng, số tài khoản, tên chủ tài khoản). Sửa lại bất cứ lúc nào ở nút "Tài khoản nhận tiền" trên thanh trên cùng.
2. Nhập mã nhóm, thêm thành viên, chọn "Tôi là thành viên nào?" để gắn tài khoản Google của bạn với tên trong nhóm. Thông tin nhận tiền của bạn sẽ tự đồng bộ vào nhóm.
3. Thành viên chưa tự đăng nhập: bấm vào tên họ để nhập hộ tài khoản nhận tiền.
4. Nhập hóa đơn như cũ.
5. Bấm **SETTLE UP** để xem ai chuyển cho ai. Mỗi dòng hiện thông tin nhận tiền của người nhận:
   - MoMo: SĐT, tên, nút mở link MoMo, nút sao chép SĐT / số tiền.
   - Ngân hàng: tên ngân hàng, số tài khoản, chủ tài khoản, nút sao chép số tài khoản / số tiền.
   Chuyển xong bấm **Đã trả** để ghi vào mục "Đã settle" của bảng và trừ vào quyết toán.

## Lưu ý
- Mã nhóm vẫn là "chìa khóa chung": ai đã đăng nhập và biết mã nhóm đều xem/sửa được nhóm đó, kể cả xem số tài khoản của các thành viên.
- Link MoMo trong Settle up có dạng `https://nhantien.momo.vn/<SĐT>/<số tiền>`. Nếu MoMo đổi định dạng, chỉ cần sửa hàm `momoLink()` trong `public/index.html`. Nút sao chép luôn dùng được.
- App không tự chuyển tiền; việc chuyển tiền do người dùng làm trong MoMo / app ngân hàng, app chỉ ghi nhận.

## API
Mọi request cần header `Authorization: Bearer <token>` (token lấy từ `POST /api/auth`).

- `POST /api/auth` `{ credential }` → `{ token, user, profile }`
- `GET /api/profile`, `POST /api/profile` `{ pay }` với `pay = { method:'momo', phone, accName? }` hoặc `{ method:'bank', bankName, bankAccount, bankHolder }`
- `GET /api/data?groupId=abc` → `{ users, expenses, payInfo, links }`
- `POST /api/data` với `action` là `addUser` | `addExpense` | `deleteExpense` | `setPayInfo` (`{ memberName, pay }`, `pay` rỗng để xóa) | `linkMe`
