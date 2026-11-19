// Platform status (spec §3): which messages to send. Red: once when an item turns red. Digest: the first run at
// 08:xx Israel time each day, only when something is yellow or red (it is also the daily reminder for red).
// Text: titles and readings only — no names, phones or addresses.
import { type Item, ilDate, ilHour } from "./levels.ts";

export const PANEL_LINK = "https://yalla-sa.app/?panel=status";
const HEAD = "יאללה־סע – מצב הפלטפורמה";

// a row that has been grey for 24 hours (now yellow) says so, or its old reading would look current
const line = (i: Item) => `${i.level === "bad" ? "אדום" : "צהוב"}: ${i.title} – ${i.reading}${i.unknown_since && i.note ? ` (${i.note})` : ""}`;
const text = (items: Item[]) => [HEAD, ...items.map(line), `ללוח: ${PANEL_LINK}`].join("\n");

// status messages go by email to their own list (David, 19.11: his private address and Nadav's),
// not through the support tool's single alert channel
export const STATUS_SUBJECT = "יאללה־סע: לוח מדדים";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const recipients = (xs: unknown): string[] =>
  [...new Set((Array.isArray(xs) ? xs : []).filter(x => typeof x === "string").map(x => x.trim().toLowerCase()).filter(x => EMAIL.test(x)))];

// WhatsApp template parameters may not contain newlines (Meta error 132018)
export const oneLine = (t: string) => t.split("\n").join(" · ");

export function decide(prev: Item[], next: Item[], now: Date, lastDigestOn: string | null):
  { immediate: string | null; digest: string | null; markDigest: boolean } {
  // red_since survives a grey spell (source down), so red -> grey -> red is not "new"
  const wasBad = new Set(prev.filter(i => i.level === "bad" || i.red_since).map(i => i.key));
  const fresh = next.filter(i => i.level === "bad" && !wasBad.has(i.key));
  const markDigest = ilHour(now) === 8 && lastDigestOn !== ilDate(now);
  const attn = [...next.filter(i => i.level === "bad"), ...next.filter(i => i.level === "warn")];
  const digest = markDigest && attn.length ? text(attn) : null;
  // a red that appears in the digest run is already in the digest: one message, not two
  return { immediate: fresh.length && !digest ? text(fresh) : null, digest, markDigest };
}
