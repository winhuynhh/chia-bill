import { kv } from '@vercel/kv';
import { requireUser, isEmail, cs, unCs } from './_lib.js';

// Kết bạn giữa các tài khoản. Phải được bên kia xác nhận mới thành bạn.
// Keys:
//   friends:<sub>   set sub của bạn bè đã xác nhận (hai chiều)
//   freqin:<sub>    set sub của người đã gửi lời mời tới mình (chờ mình xác nhận)
//   freqout:<sub>   set sub của người mình đã gửi lời mời (chờ họ xác nhận)
//   emailidx:<email> -> sub, để tìm tài khoản theo email
// GET  /api/friends                       -> { friends, incoming, outgoing }
// POST /api/friends { action, email|sub } -> request | accept | decline | cancel | remove

const fk = (s) => `friends:${s}`;
const ink = (s) => `freqin:${s}`;
const outk = (s) => `freqout:${s}`;
const LIMIT = 200;
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

const pub = (sub, p) => ({ sub, email: p?.email || '', name: p?.name || p?.email || 'Người dùng', picture: p?.picture || '' });
const subsOf = async (key) => (await kv.smembers(key)).map(unCs);

async function cards(subs) {
  if (!subs.length) return [];
  const ps = await kv.mget(...subs.map((s) => `profile:${s}`));
  return subs
    .map((s, i) => (ps[i] ? pub(s, ps[i]) : null))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

async function findByEmail(email) {
  const hit = await kv.get(`emailidx:${email}`);
  if (hit) return String(hit);
  // Tài khoản đăng nhập từ bản cũ chưa có chỉ mục: quét profile rồi bù chỉ mục.
  let cursor = 0;
  let guard = 0;
  do {
    const [next, keys] = await kv.scan(cursor, { match: 'profile:*', count: 200 });
    for (const k of keys) {
      const p = await kv.get(k);
      if (p?.email && String(p.email).toLowerCase() === email) {
        const sub = String(k).slice('profile:'.length);
        await kv.set(`emailidx:${email}`, sub);
        return sub;
      }
    }
    cursor = Number(next);
  } while (cursor !== 0 && ++guard < 100);
  return null;
}

export async function listFriends(sub) {
  const [f, i, o] = await Promise.all([subsOf(fk(sub)), subsOf(ink(sub)), subsOf(outk(sub))]);
  const [friends, incoming, outgoing] = await Promise.all([cards(f), cards(i), cards(o)]);
  return { friends, incoming, outgoing };
}

export async function areFriends(a, b) {
  return (await subsOf(fk(a))).includes(String(b));
}

async function makeFriends(a, b) {
  await kv.sadd(fk(a), cs(b));
  await kv.sadd(fk(b), cs(a));
  await kv.srem(ink(a), cs(b));
  await kv.srem(outk(a), cs(b));
  await kv.srem(ink(b), cs(a));
  await kv.srem(outk(b), cs(a));
}

export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const me = String(user.sub);

  try {
    if (req.method === 'GET') return res.status(200).json({ success: true, ...(await listFriends(me)) });
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return bad(res, 'Method not allowed', 405);
    }

    const body = req.body || {};
    const action = body.action;

    if (action === 'request') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!isEmail(email)) return bad(res, 'Email không hợp lệ');
      if (email === String(user.email).toLowerCase()) return bad(res, 'Đây là email của bạn');
      const other = await findByEmail(email);
      if (!other) return bad(res, 'Email này chưa có tài khoản. Hãy nhờ họ đăng nhập app trước, hoặc mời vào nhóm bằng email.', 404);
      if (other === me) return bad(res, 'Đây là tài khoản của bạn');
      if (await areFriends(me, other)) return res.status(200).json({ success: true, status: 'already_friends', ...(await listFriends(me)) });
      // Họ đã gửi lời mời cho mình rồi: coi như đồng ý luôn.
      if ((await subsOf(ink(me))).includes(other)) {
        await makeFriends(me, other);
        return res.status(200).json({ success: true, status: 'accepted', ...(await listFriends(me)) });
      }
      if ((await subsOf(outk(me))).includes(other)) {
        return res.status(200).json({ success: true, status: 'already_sent', ...(await listFriends(me)) });
      }
      if ((await subsOf(outk(me))).length >= LIMIT) return bad(res, 'Bạn đang có quá nhiều lời mời chờ xác nhận');
      if ((await subsOf(ink(other))).length >= LIMIT) return bad(res, 'Người này đang nhận quá nhiều lời mời, hãy thử lại sau');
      await kv.sadd(outk(me), cs(other));
      await kv.sadd(ink(other), cs(me));
      return res.status(200).json({ success: true, status: 'sent', ...(await listFriends(me)) });
    }

    const sub = String(body.sub || '');
    if (!sub || sub === me) return bad(res, 'Thiếu tài khoản');

    if (action === 'accept') {
      if (!(await subsOf(ink(me))).includes(sub)) return bad(res, 'Không có lời mời kết bạn từ người này', 404);
      await makeFriends(me, sub);
      return res.status(200).json({ success: true, ...(await listFriends(me)) });
    }
    if (action === 'decline') {
      await kv.srem(ink(me), cs(sub));
      await kv.srem(outk(sub), cs(me));
      return res.status(200).json({ success: true, ...(await listFriends(me)) });
    }
    if (action === 'cancel') {
      await kv.srem(outk(me), cs(sub));
      await kv.srem(ink(sub), cs(me));
      return res.status(200).json({ success: true, ...(await listFriends(me)) });
    }
    if (action === 'remove') {
      // Huỷ kết bạn không đụng tới các nhóm đã chung.
      await kv.srem(fk(me), cs(sub));
      await kv.srem(fk(sub), cs(me));
      return res.status(200).json({ success: true, ...(await listFriends(me)) });
    }
    return bad(res, 'Hành động không hợp lệ');
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
