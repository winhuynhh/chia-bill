import { kv } from '@vercel/kv';
import { requireUser, sanitizePay } from './_lib.js';

// GET  /api/profile            -> { user, profile }
// POST /api/profile { pay }    -> { profile }
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
