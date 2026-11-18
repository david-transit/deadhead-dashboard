// Outgoing mail layout (yalla-sa support, email spec §3 "חתימה ומיתוג", PRD-email M11): RTL HTML + plain text, same signature.
export const SENDER_NAME = "יאללה־סע – שירות לקוחות";
export const FROM = `${SENDER_NAME} <support@yalla-sa.app>`;
const DEFAULT_SUBJECT = "פנייתך ליאללה־סע";

export interface Brand { logoUrl: string; siteUrl: string; whatsapp?: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderMail(body: string, b: Brand): { html: string; text: string } {
  const wa = b.whatsapp ? `<br>וואטסאפ: ${esc(b.whatsapp)}` : "";
  const html = `<!doctype html><html lang="he" dir="rtl"><body dir="rtl" style="margin:0;padding:0">
<table dir="rtl" role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2933;text-align:right">
<tr><td style="padding:16px 16px 24px">${esc(body).replace(/\r?\n/g, "<br>")}</td></tr>
<tr><td style="padding:16px;border-top:1px solid #d9dee3;font-size:13px;color:#52606d">
<img src="${esc(b.logoUrl)}" width="160" alt="יאללה־סע" style="display:block;width:160px;height:auto;border:0;margin-bottom:8px">
<strong>${SENDER_NAME}</strong><br><a href="${esc(b.siteUrl)}" style="color:#0b6bcb">${esc(b.siteUrl.replace(/^https?:\/\//, ""))}</a>${wa}
</td></tr></table></body></html>`;
  const text = `${body}\n\n--\n${SENDER_NAME}\n${b.siteUrl}${b.whatsapp ? `\nוואטסאפ: ${b.whatsapp}` : ""}\n`;
  return { html, text };
}

export function replySubject(subject: string | null): string {
  const s = (subject ?? "").trim();
  if (!s) return `Re: ${DEFAULT_SUBJECT}`;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
