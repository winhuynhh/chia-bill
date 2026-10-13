import { kv } from '@vercel/kv';
import crypto from 'node:crypto';
import { requireUser, sanitizePay, profilePay } from './_lib.js';

// Dữ liệu 1 nhóm lưu ở key group:<groupId>:
// { users: string[],
//   expenses: {id, desc, amount, payer, splitDetails(JSON string), settle?, by, at}[],
//   payInfo: { [tênThànhViên]: { method:'momo', phone, accName } | { method:'bank', bankName, bankAccount, bankHolder } },
//   links:   { [googleSub]: tênThànhViên } }

const normalize = (d) => ({
  users: d?.users || [],
  expenses: d?.expenses || [],
  payInfo: d?.payInfo || {},
  links: d?.links || {},
});

const bad = (res, msg) => res.status(400).json({ error: msg });

export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const groupId = String(req.query.groupId || '').trim().toLowerCase();
      if (!groupId) return bad(res, 'Thiếu groupId');
      const data = normalize(await kv.get(`group:${groupId}`));
      return res.status(200).json(data);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const groupId = String(body.groupId || '').trim().toLowerCase();
    if (!groupId) return bad(res, 'Thiếu groupId');

    const key = `group:${groupId}`;
    const data = normalize(await kv.get(key));

    switch (body.action) {
      case 'addUser': {
        const name = String(body.userName || '').trim().slice(0, 40);
        if (!name) return bad(res, 'Thiếu tên thành viên');
        if (!data.users.includes(name)) data.users.push(name);
        break;
      }

      case 'addExpense': {
        const desc = String(body.desc || '').trim().slice(0, 200);
        const amount = Number(body.amount);
        const payer = String(body.payer || '');
        if (!desc || !Number.isFinite(amount) || amount <= 0) return bad(res, 'Thiếu hoặc sai thông tin hóa đơn');
        if (!data.users.includes(payer)) return bad(res, 'Người trả không thuộc nhóm');

        let split;
        try {
          split = JSON.parse(body.splitDetails || '{}');
        } catch {
          return bad(res, 'splitDetails không hợp lệ');
        }
        if (!split || typeof split !== 'object' || Array.isArray(split)) return bad(res, 'splitDetails không hợp lệ');
        for (const [u, v] of Object.entries(split)) {
          if (!data.users.includes(u) || !Number.isFinite(Number(v)) || Number(v) < 0) {
            return bad(res, 'Chia tiền có thành viên hoặc số tiền không hợp lệ');
          }
        }
        if (Object.keys(split).length === 0) return bad(res, 'Chưa chọn người chịu tiền');

        const settle = body.settle === true;
        if (settle && Object.keys(split).length !== 1) return bad(res, 'Settle chỉ có 1 người nhận');

        const id = /^[\w-]{8,64}$/.test(String(body.id || '')) ? String(body.id) : crypto.randomUUID();
        if (data.expenses.some((e) => e.id === id)) break; // chống gửi trùng
        data.expenses.push({
          id,
          desc,
          amount,
          payer,
          splitDetails: JSON.stringify(split),
          settle,
          by: user.email,
          at: Date.now(),
        });
        break;
      }

      case 'deleteExpense': {
        const idx = data.expenses.findIndex((e) => e.id === body.id);
        if (idx !== -1) data.expenses.splice(idx, 1);
        break;
      }

      case 'setPayInfo': {
        const member = String(body.memberName || '');
        if (!data.users.includes(member)) return bad(res, 'Thành viên không tồn tại');
        if (!body.pay) {
          delete data.payInfo[member];
          break;
        }
        const r = sanitizePay(body.pay);
        if (r.error) return bad(res, r.error);
        data.payInfo[member] = r.value;
        break;
      }

      case 'linkMe': {
        const member = String(body.memberName || '');
        if (!member) {
          delete data.links[user.sub];
          break;
        }
        if (!data.users.includes(member)) return bad(res, 'Thành viên không tồn tại');
        data.links[user.sub] = member;
        const pay = profilePay((await kv.get(`profile:${user.sub}`)) || {});
        if (pay) data.payInfo[member] = pay;
        break;
      }

      default:
        return bad(res, 'Action không hợp lệ');
    }

    await kv.set(key, data);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
