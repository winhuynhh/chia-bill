import { kv } from '@vercel/kv';

// Tất cả dữ liệu của 1 nhóm được lưu dưới 1 key duy nhất: group:<groupId>
// Value: { users: string[], expenses: {desc, amount, payer, splitDetails}[] }

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const groupId = (req.query.groupId || '').toString().trim().toLowerCase();
      if (!groupId) return res.status(400).json({ error: 'Missing groupId' });

      const key = `group:${groupId}`;
      const data = await kv.get(key);
      return res.status(200).json(data || { users: [], expenses: [] });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action } = body;
      const groupId = (body.groupId || '').toString().trim().toLowerCase();
      if (!groupId) return res.status(400).json({ error: 'Missing groupId' });

      const key = `group:${groupId}`;
      let data = (await kv.get(key)) || { users: [], expenses: [] };

      switch (action) {
        case 'addUser': {
          const userName = (body.userName || '').toString().trim();
          if (!userName) return res.status(400).json({ error: 'Missing userName' });
          if (!data.users.includes(userName)) data.users.push(userName);
          break;
        }

        case 'addExpense': {
          const { desc, amount, payer, splitDetails } = body;
          if (!desc || !amount || !payer) {
            return res.status(400).json({ error: 'Missing expense fields' });
          }
          data.expenses.push({
            desc,
            amount: Number(amount),
            payer,
            splitDetails: splitDetails || '{}',
          });
          break;
        }

        case 'deleteExpense': {
          const { desc, amount } = body;
          const idx = data.expenses.findIndex(
            (e) => e.desc === desc && Math.round(e.amount) === Math.round(Number(amount))
          );
          if (idx !== -1) data.expenses.splice(idx, 1);
          break;
        }

        case 'ensureGroup': {
          // Chỉ dùng để tạo nhóm rỗng nếu chưa tồn tại, không làm gì thêm.
          break;
        }

        default:
          return res.status(400).json({ error: 'Invalid action' });
      }

      await kv.set(key, data);
      return res.status(200).json({ success: true, data });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
