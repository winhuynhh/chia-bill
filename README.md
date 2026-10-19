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
- **Hai cách vào nhóm**: (1) mời qua email: người được mời chỉ cần đăng nhập đúng email đó và bấm Đồng ý; (2) link tham gia (cũng là link trong email, dạng `/?invite=<mã>&k=<khóa>`): ai mở link và đăng nhập, kể cả bằng email khác, sẽ thấy popup hỏi có phải một người đã nhập tay (hoặc đã rời nhóm) không để nhận lại các khoản chi cũ, hoặc vào như người mới. Trưởng nhóm sao chép link hoặc bấm *Tạo link mới* (link cũ hết hiệu lực) ở tab Thành viên.
- **Gắn tên nhập tay với tài khoản Google**: khi mời email, trưởng nhóm chọn "Đúng, họ là <tên tạm>"; người đó đồng ý thì các khoản chi cũ tự gắn vào tài khoản của họ. Nếu không chọn, app vẫn tự khớp khi tên Google trùng tên đã nhập (không phân biệt hoa thường, dấu). Người tham gia cũng có thể tự chọn lại tên trong tab Thành viên, mục "Bạn là ai trong nhóm?", để gộp lịch sử.
- **Sửa giao dịch và quyền thành viên**: ai có quyền thì bấm Sửa ở từng khoản chi (hoặc biểu tượng bút trong tab Bảng). Trưởng nhóm có 2 công tắc trong tab Thành viên: *Cho phép thêm khoản chi* (mặc định bật) và *Cho phép sửa và xóa giao dịch* (mặc định tắt). Trưởng nhóm và admin luôn có đủ quyền. Ghi nhận "Đã trả" khi settle luôn dùng được.
- **Quay lại sau khi rời**: cùng tài khoản hoặc cùng email thì tự nối lại đúng tên và lịch sử cũ. Nếu quay lại bằng email mới, trưởng nhóm chọn "Đúng, họ là <tên> (đã rời nhóm)" lúc mời, hoặc người đó tự chọn lại tên trong tab Thành viên để gộp.
- **Xóa người chia tiền**: thành viên rời nhóm mà chưa dính giao dịch nào thì tên cũng được xóa luôn. Nếu đã có giao dịch thì chỉ rời nhóm, thông tin được giữ để quyết toán (không xóa được cho tới khi các giao dịch liên quan bị xóa). Người nhập tay chưa có giao dịch có dấu x để xóa.
- **Trưởng nhóm xóa thành viên**: nút "xóa khỏi nhóm" cạnh từng thành viên (không áp dụng cho trưởng nhóm). Cùng quy tắc với rời nhóm: chưa có giao dịch thì xóa luôn thông tin, đã có giao dịch thì chỉ cho ra khỏi nhóm và giữ thông tin để quyết toán.
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
- `GET /api/groups?preview=<mã>&k=<khóa>` → xem trước nhóm khi vào bằng link
- `GET /api/groups` → `{ isAdmin, groups, invites, all? }` (`all` chỉ có với admin)
- `POST /api/groups` với `action`: `create` | `accept` | `decline` | `invite` (`emails`, `asName`) | `cancelInvite` (`email`) | `settings` (`memberCanAdd`, `memberCanEdit`) | `join` (`k`, `asName`) | `joinLink` | `resetJoinLink` | `leave` | `kick` (`sub`) | `rename` (`newCode`, admin) | `delete` (trưởng nhóm hoặc admin)
- `GET /api/data?groupId=...`, `POST /api/data` với `action`: `addUser` | `addExpense` | `deleteExpense` | `editExpense` | `removeUser` | `setPayInfo` | `linkMe` | `claim`

## Vào nhóm bằng mã

Ở trang chủ nhập mã nhóm: chưa có thì tạo mới; đã có thì hiện lựa chọn tham gia nhóm đó (rồi chọn tên nhập tay của mình) hoặc tạo nhóm với mã khác. Trưởng nhóm có thể tắt công tắc "Cho phép vào nhóm bằng mã" để chỉ vào bằng lời mời hoặc link. API: `GET /api/groups?lookup=<mã>`, `settings` nhận thêm `joinByCode`.

## Settle up

Người nhận dùng ngân hàng: nút "Mã QR chuyển khoản" tạo mã VietQR (qua img.vietqr.io) điền sẵn ngân hàng, số tài khoản, số tiền, nội dung. Tên ngân hàng không nhận ra được thì chỉ hiện nút sao chép.
Người nhận dùng MoMo: nút "Mở app MoMo" chỉ mở app; kèm nút sao chép SĐT, số tiền, nội dung để chuyển tay, hoặc quét QR ngân hàng. Không có QR riêng cho MoMo.

## Ngày chi

Khoản chi tự lấy thời điểm nhập; form có ô "Ngày chi" để chọn tay khi ghi bù (cả lúc sửa). API `addExpense` / `editExpense` nhận thêm `at` (ms, tùy chọn, từ năm 2000 tới tối đa 1 ngày sau hiện tại). Danh sách khoản chi xếp theo ngày mới nhất trước.

## Hoàn tác, lịch sử, danh bạ nhận tiền
- Xóa khoản chi hoặc settle: có nút **Hoàn tác** trong vài giây (thêm lại đúng khoản cũ, cùng ngày).
- **Lịch sử thay đổi** (cuối tab Khoản chi): ai thêm, sửa, xóa, hoàn tác, kèm nội dung thay đổi. Lưu 300 dòng gần nhất trong dữ liệu nhóm, hiện 100 dòng.
- Settle chỉ đổi được ngày (nút **Đổi ngày**); các phần khác phải xóa rồi ghi lại.
- **Danh bạ nhận tiền**: mỗi lần bạn nhập tài khoản nhận tiền cho một thành viên, app lưu vào hồ sơ của bạn (`profile.contacts`). Khi thêm thành viên trùng tên ở nhóm khác, app hỏi có dùng thông tin đã lưu không; trong form nhận tiền cũng có ô chọn từ danh bạ.

## Settle thủ công
Trong cửa sổ Settle up: nút **Trả cách khác** trên từng gợi ý (hoặc khung "Chuyển khác gợi ý? Ghi nhận thủ công") cho chọn người chuyển, người nhận, số tiền và ngày. Ghi nhận xong là một giao dịch settle bình thường, số dư và các gợi ý còn lại tự tính lại. Người chuyển và người nhận phải khác nhau (server kiểm tra).

## Kết bạn
- Màn chủ có hai tab **Nhóm** (nhóm của bạn, và mục Quản trị nếu là admin) và **Bạn bè** (chấm đỏ khi có lời mời chờ xác nhận). Nút tròn nổi ở góc phải dưới mở popup: tab Nhóm là vào hoặc tạo nhóm, tab Bạn bè là kết bạn. Ở tab **Bạn bè**: nhập email của người đã có tài khoản để gửi lời mời. Bên kia phải **Xác nhận** thì hai người mới thành bạn (hai chiều). Có thể từ chối, huỷ lời mời đã gửi, hoặc huỷ kết bạn (các nhóm chung vẫn giữ).
- Nếu hai người cùng gửi lời mời cho nhau thì tự thành bạn.
- Khi tạo nhóm mới, nếu đã có bạn bè thì hiện bảng chọn để thêm ngay. Trong nhóm, trưởng nhóm bấm **Chọn từ bạn bè** để thêm tiếp. Server kiểm tra lại quan hệ bạn bè nên không thêm được người chưa xác nhận.
- Bạn bè vào nhóm ngay, không cần đồng ý lần nữa; họ rời nhóm được bất cứ lúc nào. Người chưa có tài khoản vẫn mời bằng email hoặc link như cũ.
- Chỉ bạn trực tiếp mới thêm được, không có "bạn của bạn".
- Dữ liệu KV mới: `friends:<sub>`, `freqin:<sub>`, `freqout:<sub>`, `emailidx:<email>`. API: `GET/POST /api/friends`; `create` nhận thêm `friends`, thêm action `addFriends`.
