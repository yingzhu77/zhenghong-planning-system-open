import nodemailer from 'nodemailer';

export function createMailer(config = {}) {
  const smtp = config.smtp || {};
  const host = smtp.host || process.env.SMTP_HOST;
  const from = smtp.from || process.env.SMTP_FROM;
  const user = smtp.user || process.env.SMTP_USER;
  const pass = smtp.pass || process.env.SMTP_PASS;
  if (!host || !from) return { configured: false, async sendCode() {
    const error = new Error('邮件服务尚未配置，请联系管理员开通账号或配置 SMTP');
    error.status = 503; error.code = 'SMTP_NOT_CONFIGURED'; throw error;
  } };
  const secure = smtp.secure ?? process.env.SMTP_SECURE === 'true';
  const transport = nodemailer.createTransport({
    host, port: Number(smtp.port || process.env.SMTP_PORT || (secure ? 465 : 587)), secure,
    ...(user ? { auth: { user, pass } } : {}),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  return { configured: true, async sendCode({ email, code, purpose }) {
    const label = { login: '登录', register: '注册', reset: '重置密码' }[purpose] || '身份验证';
    await transport.sendMail({ from, to: email, subject: `正弘周报系统${label}验证码`,
      text: `您的${label}验证码为：${code}\n\n验证码 10 分钟内有效，请勿转发。若非本人操作，请忽略本邮件。` });
  } };
}
