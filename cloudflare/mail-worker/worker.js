// yalla-mail-in: Cloudflare Email Worker for support@yalla-sa.app (yalla-sa support, email spec §1 and §4).
// Passes every mail, unchanged, to the Supabase function mail_inbound. It reads and keeps nothing itself.
// If Supabase does not answer 200, or the mail is over 12MB, the mail goes to the backup Gmail instead (PRD-email M5).
// No libraries: paste into the Cloudflare editor as is. Settings (Worker -> Settings -> Variables):
//   INBOUND_URL       https://xghfcdgettrcdciwwzbl.supabase.co/functions/v1/mail_inbound
//   BACKUP_TO         the technical Gmail address (must be a verified Email Routing destination)
//   MAIL_INBOUND_KEY  secret, typed by David; the same value as in Supabase
//   COPY_TO           optional, comma-separated: always gets a copy (David, 19.11: technical Gmail + Nadav until /support/ is live).
//                     Each address must be a verified Email Routing destination; a failed copy is logged and skipped.
const MAX_RAW = 12 * 1024 * 1024;
const TIMEOUT_MS = 20000;

async function post(env, body, contentType) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(env.INBOUND_URL, { method: "POST", body, signal: ac.signal,
      headers: { "content-type": contentType, "x-mail-key": env.MAIL_INBOUND_KEY } });
    return r.status;
  } finally { clearTimeout(t); }
}

const copiesOf = (env) => String(env.COPY_TO || "").split(",").map((a) => a.trim()).filter(Boolean);

export default {
  async email(message, env, ctx) {
    const copies = copiesOf(env);
    for (const to of copies) {
      try { await message.forward(to); } catch (e) { console.log("copy failed", to, String(e)); }
    }
    const backup = async () => { if (!copies.includes(env.BACKUP_TO)) await message.forward(env.BACKUP_TO); };
    if (message.rawSize > MAX_RAW) {
      await backup();
      const notice = JSON.stringify({ oversize: true, from: message.from, subject: message.headers.get("subject"), size: message.rawSize });
      try { await post(env, notice, "application/json"); } catch (e) { console.log("oversize notice failed", String(e)); }
      return;
    }
    let status = 0;
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      status = await post(env, raw, "message/rfc822");
    } catch (e) { console.log("mail_inbound unreachable", String(e)); }
    if (status !== 200) await backup();
  },
};
