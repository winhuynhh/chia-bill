import { kv } from '@vercel/kv';
import crypto from 'node:crypto';
import { requireUser, isAdmin, sanitizePay, profilePay, normCode, canAccess, groupView } from './_lib.js';

// Dữ liệu nhóm nằm ở key group:<code> (tạo/mời/đổi mã xem api/groups.js).
// Ở đây chỉ đọc và ghi dữ liệu chia tiền, và chỉ thành viên đã tham gia (hoặc admin) mới truy cập được.
//   expenses: {id, desc, amount, payer, splitDetails(JSON string), settle?, by, at}[]
//   payInfo:  { [tênThànhViên]: { method:'momo', phone, accName } | { method:'bank', bankName, bankAccount, bankHolder } }
//   links:    { [googleSub]: tênThànhViên }

// Gộp người tham gia `from` vào `to`: chuyển toàn bộ khoản chi, thông tin nhận tiền.
function mergeParticipants(g, from, to) {
  g.users = g.users.filter((u) => u !== from);
  for (const e of g.expenses) {
    if (e.payer === from) e.payer = to;
    let det = {};
    try { det = JSON.parse(e.splitDetails || '{}') || {}; } catch { det = {}; }
    if (from in det) {
      det[to] = (Number(det[to]) || 0) + (Number(det[from]) || 0);
      delete det[from];
      e.splitDetails = JSON.stringify(det);
    }
  }
  if (g.payInfo[from] && !g.payInfo[to]) g.payInfo[to] = g.payInfo[from];
  delete g.payInfo[from];
  for (const [sub, n] of Object.entries(g.links)) if (n === from) g.links[sub] = to;
}

const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  try {
    const src = req.method === 'GET' ? req.query : req.body || {};
    const rawCode = String(src.groupId || '').trim();
    if (!rawCode) return bad(res, 'Thiếu hoặc sai mã nhóm');
    let code = normCode(rawCode);
    let key = code ? `group:${code}` : '';
    let g = key ? await kv.get(key) : null;
    // Admin mở được cả nhóm cũ có mã không theo chuẩn mới.
    if (!g && isAdmin(user.email)) {
      const g2 = await kv.get(`group:${rawCode}`);
      if (g2 && typeof g2 === 'object') { g = g2; code = rawCode; key = `group:${rawCode}`; }
    }
    if (!g) return bad(res, 'Nhóm không tồn tại', 404);
    if (!g.code) g.code = code;
    if (!canAccess(g, user)) return bad(res, 'Bạn chưa tham gia nhóm này. Hãy nhờ trưởng nhóm mời qua email.', 403);

    if (req.method === 'GET') return res.status(200).json(groupView(g, user));

    if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return bad(res, 'Method not allowed', 405);
    }

    const body = req.body || {};
    g.users = g.users || [];
    g.expenses = g.expenses || [];
    g.payInfo = g.payInfo || {};
    g.links = g.links || {};

    switch (body.action) {
      case 'addUser': {
        const name = String(body.userName || '').trim().slice(0, 40);
        if (!name) return bad(res, 'Thiếu tên thành viên');
        if (!g.users.includes(name)) g.users.push(name);
        break;
      }

      case 'addExpense': {
        const desc = String(body.desc || '').trim().slice(0, 200);
        const amount = Number(body.amount);
        const payer = String(body.payer || '');
        if (!desc || !Number.isFinite(amount) || amount <= 0) return bad(res, 'Thiếu hoặc sai thông tin hóa đơn');
        if (!g.users.includes(payer)) return bad(res, 'Người trả không thuộc nhóm');

        let split;
        try {
          split = JSON.parse(body.splitDetails || '{}');
        } catch {
          return bad(res, 'splitDetails không hợp lệ');
        }
        if (!split || typeof split !== 'object' || Array.isArray(split)) return bad(res, 'splitDetails không hợp lệ');
        for (const [u, v] of Object.entries(split)) {
          if (!g.users.includes(u) || !Number.isFinite(Number(v)) || Number(v) < 0) {
            return bad(res, 'Chia tiền có thành viên hoặc số tiền không hợp lệ');
          }
        }
        if (Object.keys(split).length === 0) return bad(res, 'Chưa chọn người chịu tiền');

        const settle = body.settle === true;
        if (settle && Object.keys(split).length !== 1) return bad(res, 'Settle chỉ có 1 người nhận');

        const id = /^[\w-]{8,64}$/.test(String(body.id || '')) ? String(body.id) : crypto.randomUUID();
        if (g.expenses.some((e) => e.id === id)) break; // chống gửi trùng
        g.expenses.push({
          id, desc, amount, payer,
          splitDetails: JSON.stringify(split),
          settle,
          by: user.email,
          at: Date.now(),
        });
        break;
      }

      case 'deleteExpense': {
        const idx = g.expenses.findIndex((e) => e.id === body.id);
        if (idx !== -1) g.expenses.splice(idx, 1);
        break;
      }

      case 'setPayInfo': {
        const member = String(body.memberName || '');
        if (!g.users.includes(member)) return bad(res, 'Thành viên không tồn tại');
        if (!body.pay) {
          delete g.payInfo[member];
          break;
        }
        const r = sanitizePay(body.pay);
        if (r.error) return bad(res, r.error);
        g.payInfo[member] = r.value;
        break;
      }

      case 'linkMe': {
        const member = String(body.memberName || '');
        if (!member) {
          delete g.links[user.sub];
          break;
        }
        if (!g.users.includes(member)) return bad(res, 'Thành viên không tồn tại');
        g.links[user.sub] = member;
        const pay = profilePay((await kv.get(`profile:${user.sub}`)) || {});
        if (pay) g.payInfo[member] = pay;
        break;
      }

      // Thành viên nhận lại tên tạm do trưởng nhóm đã nhập tay: gộp lịch sử vào đúng tên đó.
      case 'claim': {
        const target = String(body.memberName || '');
        if (!g.users.includes(target)) return bad(res, 'Thành viên không tồn tại');
        const holder = Object.entries(g.links).find(([sub, n]) => n === target && sub !== user.sub && g.members?.[sub]);
        if (holder) return bad(res, 'Tên này đã gắn với tài khoản khác');
        const cur = g.links[user.sub];
        const isMember = !!g.members?.[user.sub];
        // Tên của người đã rời được nhận lại: bỏ bản ghi rời.
        for (const [sub, x] of Object.entries(g.left || {})) if (x.name === target && sub !== user.sub) { delete g.left[sub]; if (g.links[sub] === target) delete g.links[sub]; }
        if (cur && cur !== target && isMember) mergeParticipants(g, cur, target);
        g.links[user.sub] = target;
        if (isMember) g.members[user.sub].name = target;
        const pay = profilePay((await kv.get(`profile:${user.sub}`)) || {});
        if (pay) g.payInfo[target] = pay;
        break;
      }

      default:
        return bad(res, 'Action không hợp lệ');
    }

    await kv.set(key, g);
    return res.status(200).json({ success: true, data: groupView(g, user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
