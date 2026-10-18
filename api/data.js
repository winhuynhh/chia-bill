import { kv } from '@vercel/kv';
import crypto from 'node:crypto';
import { requireUser, isAdmin, sanitizePay, profilePay, normCode, canAccess, groupView, perms, activeLinked, isInvolved } from './_lib.js';

// Dữ liệu nhóm nằm ở key group:<code> (tạo/mời/đổi mã xem api/groups.js).
// Ở đây chỉ đọc và ghi dữ liệu chia tiền, và chỉ thành viên đã tham gia (hoặc admin) mới truy cập được.
//   expenses: {id, desc, amount, payer, splitDetails(JSON string), settle?, by, at}[]
//   payInfo:  { [tênThànhViên]: { method:'momo', phone, accName } | { method:'bank', bankName, bankAccount, bankHolder } }
//   links:    { [googleSub]: tênThànhViên }

// Kiểm tra dữ liệu một khoản chi (dùng cho thêm và sửa).
function validateExpense(g, body, settle) {
  const desc = String(body.desc || '').trim().slice(0, 200);
  const amount = Number(body.amount);
  const payer = String(body.payer || '');
  if (!desc || !Number.isFinite(amount) || amount <= 0) return { error: 'Thiếu hoặc sai thông tin hóa đơn' };
  if (!g.users.includes(payer)) return { error: 'Người trả không thuộc nhóm' };
  let split;
  try { split = JSON.parse(body.splitDetails || '{}'); } catch { return { error: 'splitDetails không hợp lệ' }; }
  if (!split || typeof split !== 'object' || Array.isArray(split)) return { error: 'splitDetails không hợp lệ' };
  for (const [u, v] of Object.entries(split)) {
    if (!g.users.includes(u) || !Number.isFinite(Number(v)) || Number(v) < 0) return { error: 'Chia tiền có thành viên hoặc số tiền không hợp lệ' };
  }
  if (Object.keys(split).length === 0) return { error: 'Chưa chọn người chịu tiền' };
  if (settle && Object.keys(split).length !== 1) return { error: 'Settle chỉ có 1 người nhận' };
  return { desc, amount, payer, split };
}

// Ngày giao dịch do người dùng chọn tay (ms). Không gửi thì dùng giờ hiện tại. Từ năm 2000 đến tối đa 1 ngày sau hiện tại.
function parseAt(raw) {
  if (raw === undefined || raw === null || raw === '') return { at: null };
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 946684800000 || t > Date.now() + 86400000) return { error: 'Ngày giao dịch không hợp lệ' };
  return { at: Math.round(t) };
}

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

// Nhật ký thay đổi khoản chi (giữ 300 dòng gần nhất).
const money = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
const dmy = (t) => { const d = new Date(t + 7 * 3600000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`; };
function addLog(g, user, act, e, note) {
  g.log = g.log || [];
  g.log.push({
    t: Date.now(), by: g.members?.[user.sub]?.name || user.name || user.email, byEmail: user.email, act,
    desc: e.desc, amount: e.amount, settle: !!e.settle, ...(note ? { note } : {}),
  });
  if (g.log.length > 300) g.log.splice(0, g.log.length - 300);
}
const normKey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();

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
    const pm = perms(g, user);
    g.users = g.users || [];
    g.expenses = g.expenses || [];
    g.payInfo = g.payInfo || {};
    g.links = g.links || {};

    switch (body.action) {
      case 'addUser': {
        if (!pm.canAdd) return bad(res, 'Trưởng nhóm chưa cho phép thành viên thêm người', 403);
        const name = String(body.userName || '').trim().slice(0, 40);
        if (!name) return bad(res, 'Thiếu tên thành viên');
        if (!g.users.includes(name)) g.users.push(name);
        break;
      }

      case 'addExpense': {
        const settle = body.settle === true;
        if (!settle && !pm.canAdd) return bad(res, 'Trưởng nhóm chưa cho phép thành viên thêm khoản chi', 403);
        const v = validateExpense(g, body, settle);
        if (v.error) return bad(res, v.error);
        const pa = parseAt(body.at);
        if (pa.error) return bad(res, pa.error);
        const id = /^[\w-]{8,64}$/.test(String(body.id || '')) ? String(body.id) : crypto.randomUUID();
        if (g.expenses.some((e) => e.id === id)) break; // chống gửi trùng
        g.expenses.push({
          id, desc: v.desc, amount: v.amount, payer: v.payer,
          splitDetails: JSON.stringify(v.split),
          settle,
          by: user.email,
          at: pa.at || Date.now(),
        });
        addLog(g, user, body.restore === true ? 'restore' : 'add', { desc: v.desc, amount: v.amount, settle }, '');
        break;
      }

      case 'editExpense': {
        if (!pm.canEdit) return bad(res, 'Trưởng nhóm chưa cho phép thành viên sửa giao dịch', 403);
        const e = g.expenses.find((x) => x.id === body.id);
        if (!e) return bad(res, 'Không tìm thấy giao dịch', 404);
        const pa = parseAt(body.at);
        if (pa.error) return bad(res, pa.error);
        // Giao dịch settle chỉ đổi được ngày.
        if (e.settle) {
          if (!pa.at) return bad(res, 'Chọn ngày chuyển tiền mới');
          const was = e.at;
          e.at = pa.at;
          e.editedBy = user.email; e.editedAt = Date.now();
          addLog(g, user, 'edit', e, `Ngày ${was ? dmy(was) : '?'} → ${dmy(e.at)}`);
          break;
        }
        const v = validateExpense(g, body, false);
        if (v.error) return bad(res, v.error);
        const notes = [];
        if (e.desc !== v.desc) notes.push(`Tên "${e.desc}" → "${v.desc}"`);
        if (e.amount !== v.amount) notes.push(`Số tiền ${money(e.amount)} → ${money(v.amount)}`);
        if (e.payer !== v.payer) notes.push(`Người trả ${e.payer} → ${v.payer}`);
        if (e.splitDetails !== JSON.stringify(v.split)) notes.push('Đổi cách chia');
        if (pa.at && dmy(pa.at) !== dmy(e.at || 0)) notes.push(`Ngày ${e.at ? dmy(e.at) : '?'} → ${dmy(pa.at)}`);
        if (pa.at) e.at = pa.at;
        Object.assign(e, { desc: v.desc, amount: v.amount, payer: v.payer, splitDetails: JSON.stringify(v.split), editedBy: user.email, editedAt: Date.now() });
        addLog(g, user, 'edit', e, notes.join('; ') || 'Lưu lại, không đổi gì');
        break;
      }

      case 'deleteExpense': {
        if (!pm.canEdit) return bad(res, 'Trưởng nhóm chưa cho phép thành viên xóa giao dịch', 403);
        const idx = g.expenses.findIndex((e) => e.id === body.id);
        if (idx !== -1) {
          const [gone] = g.expenses.splice(idx, 1);
          addLog(g, user, 'delete', gone, gone.payer ? `Người trả ${gone.payer}` : '');
        }
        break;
      }

      // Xóa một người khỏi danh sách chia tiền: chỉ khi chưa dính giao dịch nào và không còn là thành viên đang ở trong nhóm.
      case 'removeUser': {
        if (!pm.canEdit) return bad(res, 'Trưởng nhóm chưa cho phép thành viên xóa người', 403);
        const name = String(body.userName || '');
        if (!g.users.includes(name)) return bad(res, 'Thành viên không tồn tại');
        if (activeLinked(g).has(name)) return bad(res, 'Người này đang là thành viên của nhóm. Họ cần rời nhóm trước.');
        if (isInvolved(g, name)) return bad(res, `"${name}" đã có giao dịch nên không xóa được. Hãy xóa các giao dịch liên quan trước.`);
        g.users = g.users.filter((u) => u !== name);
        delete g.payInfo[name];
        for (const [sub, n] of Object.entries(g.links)) if (n === name) delete g.links[sub];
        for (const [sub, x] of Object.entries(g.left || {})) if (x.name === name) delete g.left[sub];
        for (const [em, v] of Object.entries(g.invites || {})) if (v.asName === name) delete g.invites[em].asName;
        break;
      }

      case 'setPayInfo': {
        if (!pm.canAdd) return bad(res, 'Trưởng nhóm chưa cho phép thành viên sửa thông tin này', 403);
        const member = String(body.memberName || '');
        if (!g.users.includes(member)) return bad(res, 'Thành viên không tồn tại');
        if (!body.pay) {
          delete g.payInfo[member];
          break;
        }
        const r = sanitizePay(body.pay);
        if (r.error) return bad(res, r.error);
        g.payInfo[member] = r.value;
        // Lưu vào danh bạ cá nhân để dùng lại ở các nhóm khác.
        try {
          const pk = `profile:${user.sub}`;
          const prof = (await kv.get(pk)) || {};
          const contacts = { ...(prof.contacts || {}) };
          contacts[normKey(member)] = { name: member, pay: r.value };
          const keys = Object.keys(contacts);
          if (keys.length > 150) delete contacts[keys[0]];
          await kv.set(pk, { ...prof, contacts });
        } catch (err) { console.error('contacts', err); }
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
