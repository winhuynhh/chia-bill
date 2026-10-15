import { kv } from '@vercel/kv';
import { requireUser, sanitizePay, unCs } from './_lib.js';

// GET  /api/profile            -> { user, profile }
// POST /api/profile { pay }    -> { profile }
// POST /api/profile { name }   -> đổi tên hiển thị, cập nhật luôn tên trong mọi nhóm đã tham gia
//   pay = { method: 'momo', phone, accName? }
//      hoặc { method: 'bank', bankName, bankAccount, bankHolder }
export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;

  try {
    const key = `profile:${user.sub}`;
    const profile = (await kv.get(key)) || {};

    if (req.method === 'GET') {
      return res.status(200).json({ user, profile });
    }

    if (req.method === 'POST' && typeof (req.body || {}).name === 'string') {
      const name = req.body.name.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (name.length < 1) return res.status(400).json({ error: 'Tên không được để trống' });
      const codes = (await kv.smembers(`usergroups:${user.sub}`)).map(unCs);
      const plan = [];
      const clash = [];
      for (const c of codes) {
        const g = await kv.get(`group:${c}`);
        const old = g?.members?.[user.sub]?.name;
        if (!old || old === name) continue;
        if ((g.users || []).includes(name)) { clash.push(c); continue; }
        plan.push({ c, g, old });
      }
      if (clash.length) {
        return res.status(409).json({ error: `Tên "${name}" đã có người dùng trong nhóm ${clash.join(', ')}. Hãy chọn tên khác.` });
      }
      for (const { c, g, old } of plan) {
        g.users = (g.users || []).map((u) => (u === old ? name : u));
        g.members[user.sub].name = name;
        if (g.links) for (const k of Object.keys(g.links)) if (g.links[k] === old) g.links[k] = name;
        if (g.payInfo && old in g.payInfo) { g.payInfo[name] = g.payInfo[old]; delete g.payInfo[old]; }
        g.expenses = (g.expenses || []).map((e) => {
          let det = {};
          try { det = JSON.parse(e.splitDetails || '{}') || {}; } catch { det = {}; }
          if (old in det) { det[name] = det[old]; delete det[old]; }
          return { ...e, payer: e.payer === old ? name : e.payer, splitDetails: JSON.stringify(det) };
        });
        await kv.set(`group:${c}`, g);
      }
      const next = { ...profile, name };
      await kv.set(key, next);
      return res.status(200).json({ profile: next, renamed: plan.length });
    }

    if (req.method === 'POST') {
      const r = sanitizePay((req.body || {}).pay);
      if (r.error) return res.status(400).json({ error: r.error });
      const next = { ...profile, pay: r.value };
      delete next.momoPhone; // bỏ trường cũ
      delete next.momoName;
      await kv.set(key, next);
      return res.status(200).json({ profile: next });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
