import { requireUser } from './_lib.js';
import { listNotifs, markRead, clearNotifs } from './_notify.js';

// GET  /api/notifications                     -> { items, unread }
// POST /api/notifications { action:'read', ids:[...]|'all' } | { action:'clear' }
export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    if (req.method === 'POST') {
      const b = req.body || {};
      if (b.action === 'read') await markRead(user.sub, b.ids === 'all' ? 'all' : Array.isArray(b.ids) ? b.ids.map(String) : []);
      else if (b.action === 'clear') await clearNotifs(user.sub);
      else return res.status(400).json({ error: 'Hành động không hợp lệ' });
    } else if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return res.status(200).json({ success: true, ...(await listNotifs(user.sub)) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
