import { kv } from '@vercel/kv';
import { signSession } from './_lib.js';

// Nhận Google ID token (credential) từ nút Google Sign-In, xác minh với Google,
// rồi cấp session token riêng của app.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'Thiếu biến môi trường GOOGLE_CLIENT_ID' });

    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'Thiếu credential' });

    const r = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential)
    );
    if (!r.ok) return res.status(401).json({ error: 'Google token không hợp lệ' });
    const info = await r.json();

    const issOk = ['accounts.google.com', 'https://accounts.google.com'].includes(info.iss);
    const verified = info.email_verified === true || info.email_verified === 'true';
    if (info.aud !== clientId || !issOk || !verified || !info.sub) {
      return res.status(401).json({ error: 'Google token không hợp lệ' });
    }

    const user = {
      sub: info.sub,
      email: info.email,
      name: info.name || info.email,
    };

    const key = `profile:${user.sub}`;
    const old = (await kv.get(key)) || {};
    const profile = { ...old, ...user, picture: info.picture || old.picture || '' };
    await kv.set(key, profile);
    if (user.email) await kv.set(`emailidx:${String(user.email).toLowerCase()}`, user.sub);

    const token = signSession(user);
    return res.status(200).json({ token, user, profile });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
