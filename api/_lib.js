import crypto from 'node:crypto';

// File bắt đầu bằng "_" không được Vercel coi là một API route.

const b64u = (s) => Buffer.from(s).toString('base64url');
const clip = (v, n) => String(v || '').trim().slice(0, n);

function hmac(body) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
}

// ---------- Session ----------
// Session token tự ký (HMAC-SHA256), không cần thư viện ngoài.
export function signSession(payload, ttlSec = 60 * 60 * 24 * 30) {
  if (!process.env.SESSION_SECRET) throw new Error('Thiếu biến môi trường SESSION_SECRET');
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${hmac(body)}`;
}

export function verifySession(token) {
  if (!process.env.SESSION_SECRET || !token) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch {
    return null;
  }
}

// Trả về payload user, hoặc tự gửi 401 và trả null.
export function requireUser(req, res) {
  const h = req.headers.authorization || '';
  const user = verifySession(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) {
    res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' });
    return null;
  }
  return user;
}

// ---------- Admin ----------
// Mặc định admin là nghiahnt.dn@gmail.com. Có thể đổi bằng biến môi trường ADMIN_EMAILS (cách nhau bằng dấu phẩy).
export function adminEmails() {
  return (process.env.ADMIN_EMAILS || 'nghiahnt.dn@gmail.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
export const isAdmin = (email) => adminEmails().includes(String(email || '').toLowerCase());

// ---------- Mã nhóm / email ----------
// Mã nhóm: chữ (có dấu), số, "-" hoặc "_", 2-40 ký tự. Khoảng trắng đổi thành "-".
export function normCode(raw) {
  const c = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^[\p{L}\p{N}_-]{2,40}$/u.test(c) ? c : null;
}
export const isEmail = (e) => e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Redis tự parse chuỗi giống số/JSON (vd "1e3" -> 1000) nên thêm tiền tố khi lưu mã nhóm vào set.
export const cs = (code) => 'c:' + code;
export const unCs = (s) => String(s).slice(2);

export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// ---------- Quyền truy cập nhóm ----------
export const canAccess = (g, user) => !!(g && (isAdmin(user.email) || g.members?.[user.sub]));
export const canManage = (g, user) => !!(g && (isAdmin(user.email) || g.members?.[user.sub]?.role === 'owner'));

// Quyền thao tác dữ liệu chia tiền. Mặc định thành viên được thêm khoản chi, chưa được sửa/xóa (trưởng nhóm bật).
export const groupSettings = (g) => ({
  memberCanAdd: g?.settings?.memberCanAdd !== false,
  memberCanEdit: g?.settings?.memberCanEdit === true,
  joinByCode: g?.settings?.joinByCode !== false,
});
export function perms(g, user) {
  const manage = canManage(g, user);
  const member = !!g?.members?.[user.sub];
  const s = groupSettings(g);
  return { canAdd: manage || (member && s.memberCanAdd), canEdit: manage || (member && s.memberCanEdit) };
}

// Tên đang gắn với thành viên còn trong nhóm (người đã rời thì tên được xem là trống).
export const activeLinked = (g) => new Set(Object.entries(g.links || {}).filter(([sub]) => g.members?.[sub]).map(([, n]) => n));

// Người này có dính giao dịch nào không (trả tiền hoặc được chia tiền, kể cả settle).
export function isInvolved(g, name) {
  for (const e of g.expenses || []) {
    if (e.payer === name) return true;
    let det = {};
    try { det = JSON.parse(e.splitDetails || '{}') || {}; } catch { det = {}; }
    if (name in det) return true;
  }
  return false;
}

// Dữ liệu trả cho giao diện (không lộ sub/invite của người khác khi không cần).
export function groupView(g, user) {
  const admin = isAdmin(user.email);
  const myRole = g.members?.[user.sub]?.role || (admin ? 'admin' : null);
  const manage = canManage(g, user);
  return {
    users: g.users || [],
    expenses: g.expenses || [],
    payInfo: g.payInfo || {},
    links: g.links || {},
    meta: {
      code: g.code,
      role: myRole,
      canManage: manage,
      settings: groupSettings(g),
      ...perms(g, user),
      isAdmin: admin,
      ownerEmail: g.ownerEmail || '',
      left: Object.values(g.left || {}).map((x) => x.name),
      members: Object.entries(g.members || {}).map(([sub, m]) => ({ sub, email: m.email, name: m.name, role: m.role })),
      invites: manage
        ? Object.entries(g.invites || {}).map(([email, i]) => ({ email, at: i.at, byEmail: i.byEmail, asName: i.asName || '' }))
        : [],
    },
  };
}

// ---------- Thông tin nhận tiền ----------
// SĐT Việt Nam 10 số bắt đầu bằng 0. Chấp nhận +84 / 84. Trả null nếu sai.
export function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s.\-()]/g, '');
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  return /^0\d{9}$/.test(p) ? p : null;
}

// Thông tin nhận tiền: hoặc MoMo, hoặc tài khoản ngân hàng.
// Trả { value } nếu hợp lệ, { error } nếu sai.
export function sanitizePay(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Thiếu thông tin nhận tiền' };

  if (raw.method === 'momo') {
    const phone = normalizePhone(raw.phone);
    if (!phone) return { error: 'SĐT MoMo không hợp lệ (cần 10 số, bắt đầu bằng 0)' };
    return { value: { method: 'momo', phone, accName: clip(raw.accName, 60) } };
  }

  if (raw.method === 'bank') {
    const bankName = clip(raw.bankName, 60);
    const bankAccount = String(raw.bankAccount || '').replace(/[\s.\-]/g, '');
    const bankHolder = clip(raw.bankHolder, 60).toUpperCase();
    if (!bankName) return { error: 'Chưa nhập tên ngân hàng' };
    if (!/^\d{4,24}$/.test(bankAccount)) return { error: 'Số tài khoản không hợp lệ (chỉ gồm 4-24 chữ số)' };
    const bankCode = /^[A-Za-z0-9]{2,12}$/.test(String(raw.bankCode || '')) ? String(raw.bankCode) : '';
    return { value: { method: 'bank', bankName, ...(bankCode ? { bankCode } : {}), bankAccount, bankHolder } };
  }

  return { error: 'Hãy chọn MoMo hoặc Ngân hàng' };
}

// Lấy thông tin nhận tiền từ profile (có fallback cho dữ liệu cũ chỉ có SĐT MoMo).
export function profilePay(profile) {
  if (!profile) return null;
  if (profile.pay && (profile.pay.method === 'momo' || profile.pay.method === 'bank')) return profile.pay;
  if (profile.momoPhone) return { method: 'momo', phone: profile.momoPhone, accName: profile.momoName || '' };
  return null;
}
