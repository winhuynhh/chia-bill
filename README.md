# Billing Master (bản Vercel)

Bản chuyển đổi từ Google Apps Script sang Vercel. Cấu trúc:

```
billing-master/
├── public/index.html   ← giao diện (giữ nguyên UI/UX bản gốc, chỉ đổi phần gọi backend)
├── api/data.js         ← 1 serverless function xử lý GET (đọc nhóm) + POST (addUser/addExpense/deleteExpense)
├── package.json
└── .gitignore
```

Database dùng **Vercel KV** (Redis, của Upstash) thay cho Google Sheets — mỗi nhóm là 1 key
`group:<groupId>` chứa JSON `{ users, expenses }`. Không cần thiết kế schema, không cần server riêng.

## Cách deploy (5 phút, không cần code)

1. **Đưa code lên GitHub**
   - Tạo 1 repo mới, ví dụ `billing-master`, rồi push toàn bộ thư mục này lên (hoặc dùng nút "Upload files" trên GitHub web để kéo-thả cả thư mục).

2. **Import vào Vercel**
   - Vào https://vercel.com → **Add New → Project** → chọn repo vừa tạo → **Deploy**.
   - Không cần chỉnh Build Command / Output Directory, Vercel tự nhận diện `public/` (static) và `api/` (serverless functions).

3. **Gắn database Vercel KV**
   - Trong project vừa deploy, vào tab **Storage → Create Database → KV** (Redis, free tier đủ dùng cho app chia tiền).
   - Sau khi tạo xong, bấm **Connect Project** để Vercel tự thêm 2 biến môi trường `KV_REST_API_URL` và `KV_REST_API_TOKEN` vào project — không cần tự nhập.
   - Vào **Deployments** → bấm **Redeploy** 1 lần để các biến môi trường mới có hiệu lực.

4. **Xong.** Mở domain Vercel cấp (dạng `billing-master-xxxx.vercel.app`), nhập mã nhóm, dùng như bình thường. Nếu muốn app trên iOS gọi thẳng API, dùng đúng 2 endpoint bên dưới.

## API (dùng lại cho app iOS nếu cần)

- `GET /api/data?groupId=abc` → `{ users: [], expenses: [] }`
- `POST /api/data` với body JSON:
  - `{ "action": "addUser", "groupId": "abc", "userName": "Nghĩa" }`
  - `{ "action": "addExpense", "groupId": "abc", "desc": "Ăn trưa", "amount": 200000, "payer": "Nghĩa", "splitDetails": "{\"Nghĩa\":100000,\"An\":100000}" }`
  - `{ "action": "deleteExpense", "groupId": "abc", "desc": "Ăn trưa", "amount": 200000 }`

Tất cả trả về JSON, không còn phụ thuộc `ContentService`/`HtmlService` của Apps Script.

## Nếu muốn đổi sang database khác

`api/data.js` chỉ có 3 chỗ gọi `kv.get` / `kv.set` — nếu muốn dùng Postgres (Vercel Postgres / Supabase) hay
MongoDB Atlas thay vì KV, chỉ cần thay 2 hàm đó, phần còn lại (logic addUser/addExpense/deleteExpense) giữ nguyên.
