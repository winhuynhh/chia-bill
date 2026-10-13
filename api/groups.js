import { kv } from '@vercel/kv';
import {
  requireUser, isAdmin, canManage, normCode, isEmail, cs, unCs, appUrl, profilePay,
} from './_lib.js';
import { sendInviteMail, mailConfigured, inviteText } from './_mail.js';

// Keys:
//   group:<code>        dữ liệu nhóm (members, invites, users, expenses, payInfo, links)
//   groups:index        set mọi mã nhóm (chỉ admin dùng để liệt kê)
//   usergroups:<sub>    set mã nhóm mà tài khoản đã tham gia
//   invites:<email>     set mã nhóm đang mời email này (chờ đồng ý)
//   profile:<sub>       hồ sơ + tài khoản nhận tiền

const gkey = (c) => `group:${c}`;
const ukey = (sub) => `usergroups:${sub}`;
const ikey = (email) => `invites:${email}`;
const INDEX = 'groups:index';

const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

const summary = (g, user, code) => ({
  code: code || g.code,
  legacy: !g.members,
  role: g.members?.[user.sub]?.role || (isAdmin(user.email) ? 'admin' : 'member'),
  ownerEmail: g.ownerEmail || '',
  memberCount: Object.keys(g.members || {}).length,
  billCount: (g.expenses || []).filter((e) => !e.settle).length,
});

async function loadMany(codes) {
  if (!codes.length) return [];
  const gs = [];
  for (let i = 0; i < codes.length; i += 100) gs.push(...(await kv.mget(...codes.slice(i, i + 100).map(gkey))));
  return codes.map((c, i) => ({ code: c, g: gs[i] }));
}

const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();

// Thêm tài khoản vào nhóm: thành viên + người tham gia chia tiền + thông tin nhận tiền.
// Nếu trưởng nhóm đã nhập tay một tên tạm cho người này (asName), hoặc tên Google trùng với một tên chưa gắn tài khoản,
// thì dùng lại tên đó để các khoản chi cũ tự khớp.
function addMember(g, user, profile, asName) {
  const pay = profilePay(profile);
  let name = String(profile?.name || user.name || user.email).trim().slice(0, 40) || user.email;
  const linked = new Set(Object.values(g.links || {}));
  const free = (n) => (g.users || []).includes(n) && !linked.has(n);
  const prev = g.left?.[user.sub];
  if (prev) { name = prev.name; delete g.left[user.sub]; }
  else if (asName && free(asName)) name = asName;
  else {
    const nn = normName(name);
    const hit = (g.users || []).find((u) => free(u) && normName(u) === nn);
    if (hit) name = hit;
  }
  if (!prev && (g.users || []).includes(name) && linked.has(name)) {
    name = `${name} (${user.email.split('@')[0]})`.slice(0, 40);
  }
  g.users = g.users || [];
  g.links = g.links || {};
  g.payInfo = g.payInfo || {};
  if (!g.users.includes(name)) g.users.push(name);
  g.links[user.sub] = name;
  if (pay) g.payInfo[name] = pay;
  g.members = g.members || {};
  g.members[user.sub] = { email: user.email, name, role: g.members[user.sub]?.role || 'member', joinedAt: Date.now() };
}

// Quét mọi key group:* trong database (gồm cả nhóm tạo từ bản cũ, chưa có trong index).
async function scanGroupCodes() {
  const out = [];
  let cursor = 0;
  let guard = 0;
  do {
    const [next, keys] = await kv.scan(cursor, { match: 'group:*', count: 200 });
    for (const k of keys) out.push(String(k).slice('group:'.length));
    cursor = Number(next);
  } while (cursor !== 0 && ++guard < 200 && out.length < 2000);
  return out;
}

export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const email = String(user.email || '').toLowerCase();
  const admin = isAdmin(email);

  try {
    // ---------- GET: danh sách nhóm + lời mời (+ tất cả nhóm nếu là admin) ----------
    if (req.method === 'GET') {
      const myCodes = (await kv.smembers(ukey(user.sub))).map(unCs);
      const groups = [];
      const staleGroups = [];
      for (const { code, g } of await loadMany(myCodes)) {
        if (g && g.members?.[user.sub]) groups.push(summary(g, user));
        else staleGroups.push(cs(code));
      }
      if (staleGroups.length) await kv.srem(ukey(user.sub), ...staleGroups);

      const inviteCodes = (await kv.smembers(ikey(email))).map(unCs);
      const invites = [];
      const staleInvites = [];
      for (const { code, g } of await loadMany(inviteCodes)) {
        const inv = g?.invites?.[email];
        if (inv) invites.push({ code, invitedBy: inv.byName || inv.byEmail, invitedByEmail: inv.byEmail, at: inv.at });
        else staleInvites.push(cs(code));
      }
      if (staleInvites.length) await kv.srem(ikey(email), ...staleInvites);

      const out = { isAdmin: admin, mailConfigured: mailConfigured(), groups, invites };
      if (admin) {
        const all = new Set((await kv.smembers(INDEX)).map(unCs));
        for (const c of await scanGroupCodes()) all.add(c);
        out.all = (await loadMany([...all])).filter((x) => x.g && typeof x.g === 'object').map((x) => summary(x.g, user, x.code)).sort((a, b) => a.code.localeCompare(b.code));
      }
      return res.status(200).json(out);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return bad(res, 'Method not allowed', 405);
    }

    const body = req.body || {};
    const action = body.action;
    const profile = (await kv.get(`profile:${user.sub}`)) || {};

    // ---------- Tạo nhóm: người tạo tự là trưởng nhóm + thành viên ----------
    if (action === 'create') {
      const code = normCode(body.code);
      if (!code) return bad(res, 'Mã nhóm gồm 2-40 ký tự: chữ, số, dấu - hoặc _');
      const pay = profilePay(profile);
      if (!pay) return bad(res, 'Hãy đăng ký tài khoản nhận tiền trước khi tạo nhóm');
      const name = String(profile.name || user.name || user.email).trim().slice(0, 40);
      const g = {
        code,
        ownerSub: user.sub,
        ownerEmail: user.email,
        createdAt: Date.now(),
        members: { [user.sub]: { email: user.email, name, role: 'owner', joinedAt: Date.now() } },
        invites: {},
        users: [name],
        expenses: [],
        payInfo: { [name]: pay },
        links: { [user.sub]: name },
      };
      const ok = await kv.set(gkey(code), g, { nx: true });
      if (!ok) return bad(res, 'Mã nhóm đã tồn tại, hãy chọn mã khác', 409);
      await kv.sadd(INDEX, cs(code));
      await kv.sadd(ukey(user.sub), cs(code));
      return res.status(200).json({ success: true, code });
    }

    const rawCode = String(body.code || '').trim();
    if (!rawCode) return bad(res, 'Thiếu hoặc sai mã nhóm');
    let code = normCode(rawCode);
    let key = code ? gkey(code) : '';
    let g = key ? await kv.get(key) : null;
    // Admin mở được cả nhóm cũ có mã không theo chuẩn mới (chữ hoa, có dấu cách...).
    if (!g && admin) {
      const g2 = await kv.get(gkey(rawCode));
      if (g2 && typeof g2 === 'object') { g = g2; code = rawCode; key = gkey(rawCode); }
    }
    if (!g) return bad(res, 'Nhóm không tồn tại', 404);

    // ---------- Đồng ý / từ chối lời mời ----------
    if (action === 'accept' || action === 'decline') {
      if (!g.invites?.[email]) return bad(res, 'Không tìm thấy lời mời cho email của bạn', 404);
      if (action === 'accept') {
        addMember(g, user, profile, g.invites[email].asName);
        await kv.sadd(ukey(user.sub), cs(code));
      }
      delete g.invites[email];
      await kv.set(key, g);
      await kv.srem(ikey(email), cs(code));
      return res.status(200).json({ success: true, code });
    }

    // ---------- Mời thành viên qua email (trưởng nhóm / admin) ----------
    if (action === 'invite') {
      if (!canManage(g, user)) return bad(res, 'Chỉ trưởng nhóm mới mời được thành viên', 403);
      const raw = Array.isArray(body.emails) ? body.emails.join(',') : String(body.emails || '');
      const list = [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
      if (!list.length) return bad(res, 'Chưa nhập email nào');
      if (list.length > 10) return bad(res, 'Mỗi lần mời tối đa 10 email');

      g.invites = g.invites || {};
      const asName = String(body.asName || '').trim();
      if (asName) {
        if (list.length !== 1) return bad(res, 'Chỉ gắn tên tạm khi mời đúng 1 email');
        if (!(g.users || []).includes(asName)) return bad(res, 'Tên tạm không có trong nhóm');
        if (Object.values(g.links || {}).includes(asName)) return bad(res, 'Tên này đã gắn với một tài khoản');
        const taken = Object.entries(g.invites).find(([e, v]) => v.asName === asName && e !== list[0]);
        if (taken) return bad(res, `Tên này đang gắn với lời mời gửi tới ${taken[0]}`);
      }
      const memberEmails = new Set(Object.values(g.members || {}).map((m) => String(m.email).toLowerCase()));
      const inviterName = String(profile.name || user.name || user.email);
      const link = `${appUrl(req)}/?invite=${encodeURIComponent(code)}`;
      const results = [];
      const toSend = [];

      for (const to of list) {
        if (!isEmail(to)) { results.push({ email: to, status: 'invalid' }); continue; }
        if (to === email) { results.push({ email: to, status: 'self' }); continue; }
        if (memberEmails.has(to)) { results.push({ email: to, status: 'already_member' }); continue; }
        if (!g.invites[to] && Object.keys(g.invites).length >= 50) { results.push({ email: to, status: 'limit' }); continue; }
        const again = !!g.invites[to];
        g.invites[to] = { byEmail: user.email, byName: inviterName, at: Date.now(), ...(asName ? { asName } : {}) };
        results.push({ email: to, status: again ? 'resent' : 'invited' });
        toSend.push(to);
      }

      await kv.set(key, g);
      for (const to of toSend) await kv.sadd(ikey(to), cs(code));

      const sent = await Promise.all(
        toSend.map((to) => sendInviteMail({ to, code, link, inviterName, inviterEmail: user.email }))
      );
      toSend.forEach((to, i) => {
        const r = results.find((x) => x.email === to);
        r.emailSent = sent[i].sent;
        if (!sent[i].sent) r.error = sent[i].reason;
      });

      return res.status(200).json({
        success: true, code, link, results,
        mailConfigured: mailConfigured(),
        shareText: inviteText({ code, link, inviterName, inviterEmail: user.email, to: 'đã được mời' }),
      });
    }

    if (action === 'cancelInvite') {
      if (!canManage(g, user)) return bad(res, 'Chỉ trưởng nhóm mới huỷ được lời mời', 403);
      const to = String(body.email || '').toLowerCase();
      if (g.invites?.[to]) {
        delete g.invites[to];
        await kv.set(key, g);
      }
      await kv.srem(ikey(to), cs(code));
      return res.status(200).json({ success: true });
    }

    // ---------- Thành viên rời nhóm: vẫn giữ tên + chi tiêu + thông tin nhận tiền để quyết toán ----------
    if (action === 'leave') {
      const m = g.members?.[user.sub];
      if (!m) return bad(res, 'Bạn không phải thành viên của nhóm này', 403);
      if (m.role === 'owner') return bad(res, 'Trưởng nhóm không thể rời nhóm. Hãy xóa nhóm nếu không dùng nữa.', 400);
      g.left = g.left || {};
      g.left[user.sub] = { email: m.email, name: m.name, leftAt: Date.now() };
      delete g.members[user.sub];
      await kv.set(key, g);
      await kv.srem(ukey(user.sub), cs(code));
      return res.status(200).json({ success: true });
    }

    // ---------- Xóa nhóm: trưởng nhóm hoặc admin. Đổi mã: chỉ admin ----------
    if (action === 'rename' || action === 'delete') {
      if (action === 'rename' ? !admin : !canManage(g, user)) {
        return bad(res, action === 'rename' ? 'Chỉ admin mới được đổi mã nhóm' : 'Chỉ trưởng nhóm mới được xóa nhóm', 403);
      }

      const memberSubs = Object.keys(g.members || {});
      const inviteEmails = Object.keys(g.invites || {});

      if (action === 'delete') {
        await kv.del(key);
        await kv.srem(INDEX, cs(code));
        for (const sub of memberSubs) await kv.srem(ukey(sub), cs(code));
        for (const e of inviteEmails) await kv.srem(ikey(e), cs(code));
        return res.status(200).json({ success: true });
      }

      const newCode = normCode(body.newCode);
      if (!newCode) return bad(res, 'Mã nhóm mới gồm 2-40 ký tự: chữ, số, dấu - hoặc _');
      if (newCode === code) return res.status(200).json({ success: true, code });
      const moved = { ...g, code: newCode };
      const ok = await kv.set(gkey(newCode), moved, { nx: true });
      if (!ok) return bad(res, 'Mã nhóm mới đã tồn tại', 409);
      await kv.del(key);
      await kv.srem(INDEX, cs(code));
      await kv.sadd(INDEX, cs(newCode));
      for (const sub of memberSubs) { await kv.srem(ukey(sub), cs(code)); await kv.sadd(ukey(sub), cs(newCode)); }
      for (const e of inviteEmails) { await kv.srem(ikey(e), cs(code)); await kv.sadd(ikey(e), cs(newCode)); }
      return res.status(200).json({ success: true, code: newCode });
    }

    return bad(res, 'Action không hợp lệ');
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
