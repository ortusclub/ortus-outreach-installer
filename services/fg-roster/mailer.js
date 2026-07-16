// Failure-alert email for FG Auto-Pilot. OFF by default (Operator rule 4):
// no recipients → no send, ever. nodemailer is already a repo dependency.
import nodemailer from 'nodemailer';

export function makeMailer({
  to = process.env.ALERT_EMAIL_TO || '',
  from = process.env.ALERT_EMAIL_FROM || 'fg-autopilot@ortusclub.com',
  transport,
} = {}) {
  const recipients = String(to).trim();
  const tx = transport || (recipients ? nodemailer.createTransport({
    host: process.env.ALERT_SMTP_HOST,
    port: Number(process.env.ALERT_SMTP_PORT || 587),
    auth: process.env.ALERT_SMTP_USER
      ? { user: process.env.ALERT_SMTP_USER, pass: process.env.ALERT_SMTP_PASS }
      : undefined,
  }) : null);

  return {
    async sendAlert(subject, body) {
      if (!recipients || !tx) return { sent: false, reason: 'no-recipients' };
      await tx.sendMail({ from, to: recipients, subject, text: body });
      return { sent: true };
    },
  };
}
