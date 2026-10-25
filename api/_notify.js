import { kv } from '@vercel/kv';
import crypto from 'node:crypto';

// Thông báo trong app cho từng tài khoản. Key notif:<sub> = mảng {id, at, type, code, text, read}, giữ 60 thông báo gần nhất.
const key = (sub) => `notif:${sub}`;
const CAP = 60;

export async function notify(subs, n) {
  const list = [...new Set((subs || []).map(String))];
  await Promise.all(list.map(async (sub) => {
    try {
      const cur = (await kv.get(key(sub))) || [];
      cur.push({ id: crypto.randomUUID().slice(0, 12), at: Date.now(), read: false, type: n.type || 'info', code: n.code || '', text: String(n.text || '').slice(0, 300) });
      if (cur.length > CAP) cur.splice(0, cur.length - CAP);
      await kv.set(key(sub), cur);
    } catch (e) { console.error('notify', e); }
  }));
}

export async function listNotifs(sub) {
  const cur = (await kv.get(key(sub))) || [];
  const items = cur.slice().reverse();
  return { items, unread: items.filter((x) => !x.read).length };
}

export async function markRead(sub, ids) {
  const cur = (await kv.get(key(sub))) || [];
  const set = ids === 'all' ? null : new Set(ids || []);
  let changed = false;
  for (const x of cur) if (!x.read && (!set || set.has(x.id))) { x.read = true; changed = true; }
  if (changed) await kv.set(key(sub), cur);
}

export async function clearNotifs(sub) { await kv.set(key(sub), []); }
