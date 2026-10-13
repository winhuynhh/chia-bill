import nodemailer from 'nodemailer';

// Gửi email lời mời qua SMTP (mặc định Gmail). Cần SMTP_USER + SMTP_PASS (App Password).
// Không cấu hình thì lời mời vẫn được tạo, chỉ là không gửi được email.

export const mailConfigured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s/g, '') },
  });
  return transporter;
}

export function inviteText({ code, link, inviterName, inviterEmail, to }) {
  return (
    `${inviterName} (${inviterEmail}) mời bạn tham gia nhóm chia tiền "${code}" trên Billing Master.\n\n` +
    `Mã nhóm: ${code}\nLink truy cập: ${link}\n\n` +
    `Cách tham gia: đăng nhập Google bằng đúng email ${to}, rồi bấm "Đồng ý" ở mục Lời mời.`
  );
}

export async function sendInviteMail({ to, code, link, inviterName, inviterEmail }) {
  if (!mailConfigured()) return { sent: false, reason: 'Chưa cấu hình SMTP_USER / SMTP_PASS trên Vercel' };
  try {
    await getTransporter().sendMail({
      from: process.env.MAIL_FROM || `Billing Master <${process.env.SMTP_USER}>`,
      to,
      subject: `[Billing Master] ${inviterName} mời bạn vào nhóm "${code}"`,
      text: inviteText({ code, link, inviterName, inviterEmail, to }),
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#3c4043">
        <h2 style="margin:0 0 12px">Lời mời tham gia nhóm</h2>
        <p><b>${esc(inviterName)}</b> (${esc(inviterEmail)}) mời bạn tham gia nhóm chia tiền trên <b>Billing Master</b>.</p>
        <p style="font-size:15px">Mã nhóm: <b style="font-size:18px">${esc(code)}</b></p>
        <p><a href="${esc(link)}" style="display:inline-block;background:#EA4335;color:#fff;padding:10px 22px;border-radius:24px;text-decoration:none;font-weight:bold">Mở lời mời</a></p>
        <p style="font-size:12px;color:#5f6368">Hoặc dán link này vào trình duyệt:<br>${esc(link)}</p>
        <p style="font-size:12px;color:#5f6368">Hãy đăng nhập Google bằng đúng email <b>${esc(to)}</b>, rồi bấm <b>Đồng ý</b> ở mục Lời mời để vào nhóm.</p>
      </div>`,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message || 'Gửi email thất bại' };
  }
}
