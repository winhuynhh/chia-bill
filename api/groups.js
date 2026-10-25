import { kv } from '@vercel/kv';
import crypto from 'node:crypto';
import {
  requireUser, isAdmin, canManage, groupSettings, activeLinked, isInvolved, normCode, isEmail, cs, unCs, appUrl, profilePay, balancesOf,
} from './_lib.js';
import { areFriends } from './friends.js';
import { notify } from './_notify.js';
import { sendInviteMail, mailConfigured, inviteText } from './_mail.js';

// Keys:
//   group:<code>        dữ liệu nhóm (members, invites, users, expenses, payInfo, links)
//   groups:index        set mọi mã nhóm (chỉ admin dùng để liệt kê)
//   usergroups:<sub>    set mã nhóm mà tài khoản đã tham gia
//   invites:<email>     set mã nhóm đang mời email này (chờ đồng ý)
//   profile:<sub>       hồ sơ + tài khoản nhận tiền

const newToken = () => crypto.randomBytes(9).toString('base64url');
const tokenOk = (g, k) => {
  if (!g?.joinToken || typeof k !== 'string' || k.length !== g.joinToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(g.joinToken));
};
// Được vào nhóm khi: có link đúng, hoặc nhóm cho vào bằng mã, hoặc email này đang được mời. Nhóm cũ (chưa có members) không cho vào.
const canJoin = (g, k, email) => !!g?.members && (tokenOk(g, k) || groupSettings(g).joinByCode || !!g.invites?.[email]);
const joinLinkOf =(req, g, code) => `${appUrl(req)}/?invite=${encodeURIComponent(code)}&k=${g.joinToken}`;
const gkey = (c) => `group:${c}`;
const ukey = (sub) => `usergroups:${sub}`;
const ikey = (email) => `invites:${email}`;
const INDEX = 'groups:index';

const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

// Tình trạng tất toán của nhóm: cùng cách tính với màn Số dư (chi trừ phần phải chịu, cộng settle đã chuyển/nhận).
function debtOf(g, user) {
  const { d, bills } = balancesOf(g);
  let pending = 0, debtors = 0;
  for (const u of Object.keys(d)) { const v = Math.round(d[u]); if (v > 0) { pending += v; debtors++; } }
  const me = g.links?.[user.sub];
  const mine = me && me in d ? Math.round(d[me]) : null;
  return { bills, settled: bills > 0 && pending === 0, pending, debtors, mine, locked: !!g.locked };
}

const summary = (g, user, code) => ({
  debt: debtOf(g, user),
  code: code || g.code,
  legacy: !g.members,
  role: g.members?.[user.sub]?.role || (isAdmin(user.email) ? 'admin' : 'member'),
  ownerEmail: g.ownerEmail || '',
  createdAt: g.createdAt || 0,
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

// Tên đang gắn với thành viên còn trong nhóm. Tên của người đã rời được xem là "trống" để người khác nhận lại.
// Người đã rời nhưng đã có người nhận lại tên này: xóa bản ghi rời và liên kết cũ.
function releaseName(g, name) {
  for (const [sub, x] of Object.entries(g.left || {})) {
    if (x.name === name) { delete g.left[sub]; if (g.links?.[sub] === name) delete g.links[sub]; }
  }
}

// Thêm tài khoản vào nhóm: thành viên + người tham gia chia tiền + thông tin nhận tiền.
// Thứ tự nhận diện: (1) từng rời nhóm cùng tài khoản hoặc cùng email, (2) trưởng nhóm chỉ định tên (asName: tên nhập tay hoặc tên người đã rời),
// (3) tên Google trùng một tên chưa có tài khoản (bỏ dấu, không phân biệt hoa thường).
function addMember(g, user, profile, asName) {
  const pay = profilePay(profile);
  let name = String(profile?.name || user.name || user.email).trim().slice(0, 40) || user.email;
  const linked = activeLinked(g);
  const free = (n) => (g.users || []).includes(n) && !linked.has(n);
  const em = String(user.email || '').toLowerCase();
  const prevKey = g.left?.[user.sub] ? user.sub : Object.keys(g.left || {}).find((k) => String(g.left[k].email || '').toLowerCase() === em);
  const prev = prevKey ? g.left[prevKey] : null;
  const useAs = !!(asName && free(asName));
  if (prev) {
    delete g.left[prevKey];
    if (prevKey !== user.sub) delete g.links?.[prevKey];
  }
  if (useAs) { name = asName; releaseName(g, asName); }
  else if (prev) { name = prev.name; }
  else {
    const nn = normName(name);
    const hit = (g.users || []).find((u) => free(u) && normName(u) === nn);
    if (hit) { name = hit; releaseName(g, hit); }
  }
  if (!prev && !useAs && (g.users || []).includes(name) && activeLinked(g).has(name)) {
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


// Thêm bạn bè đã xác nhận vào nhóm (bỏ qua người không phải bạn hoặc đã trong nhóm). Trả về danh sách kết quả.
async function addFriendsTo(g, code, user, subs) {
  const out = [];
  const list = [...new Set((Array.isArray(subs) ? subs : []).map(String))].slice(0, 30);
  for (const sub of list) {
    if (g.members?.[sub]) { out.push({ sub, status: 'already_member' }); continue; }
    if (!(await areFriends(user.sub, sub))) { out.push({ sub, status: 'not_friend' }); continue; }
    const p = await kv.get(`profile:${sub}`);
    if (!p?.email) { out.push({ sub, status: 'not_found' }); continue; }
    addMember(g, { sub, email: p.email, name: p.name }, p);
    const em = String(p.email).toLowerCase();
    if (g.invites?.[em]) { delete g.invites[em]; await kv.srem(ikey(em), cs(code)); }
    await kv.sadd(ukey(sub), cs(code));
    out.push({ sub, status: 'added', name: g.members[sub].name });
  }
  return out;
}

// Đưa một thành viên ra khỏi nhóm. Chưa dính giao dịch nào: xóa luôn tên và thông tin. Đã có giao dịch: chỉ rời, giữ lại tên để quyết toán.
function detachMember(g, sub) {
  const m = g.members[sub];
  delete g.members[sub];
  const removed = !isInvolved(g, m.name);
  if (removed) {
    g.users = (g.users || []).filter((u) => u !== m.name);
    if (g.payInfo) delete g.payInfo[m.name];
    if (g.links) delete g.links[sub];
  } else {
    g.left = g.left || {};
    g.left[sub] = { email: m.email, name: m.name, leftAt: Date.now() };
  }
  return removed;
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
    // ---------- GET ?lookup=<mã>: nhập mã ở trang chủ, nhóm đã có chưa? ----------
    if (req.method === 'GET' && req.query?.lookup) {
      const c = normCode(req.query.lookup);
      if (!c) return bad(res, 'Mã nhóm gồm 2-40 ký tự: chữ, số, dấu - hoặc _');
      const lg = await kv.get(gkey(c));
      if (!lg || typeof lg !== 'object') return res.status(200).json({ code: c, exists: false });
      const member = !!lg.members?.[user.sub];
      return res.status(200).json({ code: c, exists: true, alreadyMember: member, joinable: !member && canJoin(lg, '', email) });
    }

    // ---------- GET ?preview=<mã>&k=<mã bí mật>: xem trước nhóm khi vào bằng link ----------
    if (req.method === 'GET' && req.query?.preview) {
      const c = normCode(req.query.preview);
      const pg = c ? await kv.get(gkey(c)) : null;
      if (!pg || !canJoin(pg, String(req.query.k || ''), email)) return bad(res, 'Không vào được nhóm này. Link có thể đã đổi, hoặc nhóm không cho vào bằng mã. Hãy xin trưởng nhóm link mới.', 404);
      const prof = (await kv.get(`profile:${user.sub}`)) || {};
      const linked = activeLinked(pg);
      const reserved = new Set(Object.entries(pg.invites || {}).filter(([e]) => e !== email).map(([, v]) => v.asName).filter(Boolean));
      const leftNames = new Set(Object.values(pg.left || {}).map((x) => x.name));
      const names = (pg.users || []).filter((u) => !linked.has(u) && !reserved.has(u)).map((u) => ({ name: u, left: leftNames.has(u) }))
        .sort((a, b) => Number(a.left) - Number(b.left));
      const retKey = pg.left?.[user.sub] ? user.sub : Object.keys(pg.left || {}).find((k) => String(pg.left[k].email || '').toLowerCase() === email);
      const myName = String(prof.name || user.name || user.email);
      const nn = normName(myName);
      const suggested = (retKey && pg.left[retKey].name) || names.find((x) => normName(x.name) === nn)?.name || '';
      return res.status(200).json({ code: pg.code || c, alreadyMember: !!pg.members?.[user.sub], myName, names, suggested, returning: !!retKey });
    }

    // ---------- GET: danh sách nhóm + lời mời (+ tất cả nhóm nếu là admin) ----------
    if (req.method === 'GET') {
      const myCodes = (await kv.smembers(ukey(user.sub))).map(unCs);
      const groups = [];
      const staleGroups = [];
      for (const { code, g } of await loadMany(myCodes)) {
        if (g && g.members?.[user.sub]) groups.push(summary(g, user, code));
        else staleGroups.push(cs(code));
      }
      // Mới tạo lên trước; nhóm cũ chưa có ngày tạo xếp cuối theo mã.
      groups.sort((a, b) => (b.createdAt - a.createdAt) || a.code.localeCompare(b.code));
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
        joinToken: newToken(),
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
      let friendResults = [];
      if (Array.isArray(body.friends) && body.friends.length) {
        friendResults = await addFriendsTo(g, code, user, body.friends);
        await kv.set(gkey(code), g);
      }
      return res.status(200).json({ success: true, code, friendResults });
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

    // ---------- Vào nhóm bằng link (không cần đúng email được mời) ----------
    if (action === 'join') {
      if (!canJoin(g, String(body.k || ''), email)) return bad(res, 'Không vào được nhóm này. Link có thể đã đổi, hoặc nhóm không cho vào bằng mã. Hãy xin trưởng nhóm link mới.', 403);
      if (g.members?.[user.sub]) return res.status(200).json({ success: true, code });
      const asName = String(body.asName || '').trim();
      if (asName) {
        const reservedByOther = Object.entries(g.invites || {}).some(([e, v]) => v.asName === asName && e !== email);
        if (!(g.users || []).includes(asName) || activeLinked(g).has(asName) || reservedByOther) {
          return bad(res, 'Tên này vừa được người khác nhận, hãy chọn lại', 409);
        }
      }
      addMember(g, user, profile, asName);
      const hadInvite = !!g.invites?.[email];
      if (hadInvite) delete g.invites[email];
      await kv.set(key, g);
      await kv.sadd(ukey(user.sub), cs(code));
      if (hadInvite) await kv.srem(ikey(email), cs(code));
      return res.status(200).json({ success: true, code });
    }

    // ---------- Link tham gia nhóm: xem / tạo mới (trưởng nhóm, admin) ----------
    if (action === 'joinLink' || action === 'resetJoinLink') {
      if (!canManage(g, user)) return bad(res, 'Chỉ trưởng nhóm mới quản lý được link tham gia', 403);
      if (!g.joinToken || action === 'resetJoinLink') { g.joinToken = newToken(); await kv.set(key, g); }
      return res.status(200).json({ success: true, link: joinLinkOf(req, g, code) });
    }

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
        if (activeLinked(g).has(asName)) return bad(res, 'Tên này đã gắn với một tài khoản');
        const taken = Object.entries(g.invites).find(([e, v]) => v.asName === asName && e !== list[0]);
        if (taken) return bad(res, `Tên này đang gắn với lời mời gửi tới ${taken[0]}`);
      }
      const memberEmails = new Set(Object.values(g.members || {}).map((m) => String(m.email).toLowerCase()));
      const inviterName = String(profile.name || user.name || user.email);
      if (!g.joinToken) g.joinToken = newToken();
      const link = joinLinkOf(req, g, code);
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

    if (action === 'addFriends') {
      if (!canManage(g, user)) return bad(res, 'Chỉ trưởng nhóm mới thêm được thành viên', 403);
      const results = await addFriendsTo(g, code, user, body.subs);
      await kv.set(key, g);
      return res.status(200).json({ success: true, code, results });
    }

    // Khoá nhóm sau quyết toán: thành viên không thêm/sửa/xóa khoản chi được nữa. Chỉ trưởng nhóm (hoặc admin) khoá và mở.
    if (action === 'setLock') {
      if (!canManage(g, user)) return bad(res, 'Chỉ trưởng nhóm mới khoá hoặc mở khoá nhóm', 403);
      const want = body.locked === true;
      if (!!g.locked !== want) {
        g.locked = want;
        g.lockedAt = want ? Date.now() : 0;
        g.lockedBy = want ? (g.members?.[user.sub]?.name || user.name || user.email) : '';
        g.log = g.log || [];
        g.log.push({ t: Date.now(), by: g.members?.[user.sub]?.name || user.name || user.email, byEmail: user.email, act: want ? 'lock' : 'unlock', desc: '', amount: 0, settle: false });
        if (g.log.length > 300) g.log.splice(0, g.log.length - 300);
        await kv.set(key, g);
        const who = g.members?.[user.sub]?.name || user.name || user.email;
        await notify(Object.keys(g.members || {}).filter((s) => s !== user.sub), {
          type: want ? 'lock' : 'unlock', code,
          text: want ? `${who} đã khoá nhóm "${code}" sau quyết toán. Thành viên không thêm khoản chi mới được nữa.` : `${who} đã mở khoá nhóm "${code}". Thành viên lại thêm được khoản chi.`,
        });
      }
      return res.status(200).json({ success: true, code, locked: !!g.locked });
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

    // ---------- Trưởng nhóm bật/tắt quyền của thành viên ----------
    if (action === 'settings') {
      if (!canManage(g, user)) return bad(res, 'Chỉ trưởng nhóm mới đổi được quyền của thành viên', 403);
      g.settings = { ...(g.settings || {}) };
      if (typeof body.memberCanAdd === 'boolean') g.settings.memberCanAdd = body.memberCanAdd;
      if (typeof body.memberCanEdit === 'boolean') g.settings.memberCanEdit = body.memberCanEdit;
      if (typeof body.joinByCode === 'boolean') g.settings.joinByCode = body.joinByCode;
      await kv.set(key, g);
      return res.status(200).json({ success: true, settings: groupSettings(g) });
    }

    // ---------- Trưởng nhóm / admin xóa thành viên khỏi nhóm (cùng quy tắc với rời nhóm) ----------
    if (action === 'kick') {
      if (!canManage(g, user)) return bad(res, 'Chỉ trưởng nhóm mới xóa được thành viên', 403);
      const sub = String(body.sub || '');
      const m = g.members?.[sub];
      if (!m) return bad(res, 'Người này không còn trong nhóm', 404);
      if (m.role === 'owner') return bad(res, 'Không thể xóa trưởng nhóm khỏi nhóm', 400);
      if (sub === user.sub) return bad(res, 'Muốn tự rời nhóm, hãy dùng nút Rời nhóm', 400);
      const removed = detachMember(g, sub);
      await kv.set(key, g);
      await kv.srem(ukey(sub), cs(code));
      return res.status(200).json({ success: true, removed, name: m.name });
    }

    // ---------- Thành viên rời nhóm: vẫn giữ tên + chi tiêu + thông tin nhận tiền để quyết toán ----------
    if (action === 'leave') {
      const m = g.members?.[user.sub];
      if (!m) return bad(res, 'Bạn không phải thành viên của nhóm này', 403);
      if (m.role === 'owner') return bad(res, 'Trưởng nhóm không thể rời nhóm. Hãy xóa nhóm nếu không dùng nữa.', 400);
      const removed = detachMember(g, user.sub);
      await kv.set(key, g);
      await kv.srem(ukey(user.sub), cs(code));
      return res.status(200).json({ success: true, removed });
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
