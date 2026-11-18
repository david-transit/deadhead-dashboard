# yalla-mail-in (Cloudflare Email Worker)

Passes every mail to `support@yalla-sa.app` on to the Supabase function `mail_inbound`. If that fails, or the mail is over 12MB, the Worker forwards the mail to the backup Gmail.

Spec: `yalla-sa-support/docs/superpowers/specs/2026-11-18-email-design.md`.

## Setup (David, in the Cloudflare dashboard)
1. **Workers & Pages → Create → Worker.**
   - Name: `yalla-mail-in`.
   - Paste the contents of `worker.js` and press Deploy.
2. **Settings → Variables and Secrets:**
   - `INBOUND_URL` (text): `https://xghfcdgettrcdciwwzbl.supabase.co/functions/v1/mail_inbound`
   - `BACKUP_TO` (text): the technical Gmail address. It must already be a verified destination in Email Routing.
   - `MAIL_INBOUND_KEY` (**Secret**): the same value David typed into Supabase as `MAIL_INBOUND_KEY`.
3. **Email → Email Routing → Routes:**
   - Edit `support@yalla-sa.app`.
   - Action: **Send to a Worker**, then pick `yalla-mail-in`.

**To go back:** set the route action to "Send to an email" and choose the Gmail address.

## Test
`node --test cloudflare/mail-worker/worker.test.mjs`
