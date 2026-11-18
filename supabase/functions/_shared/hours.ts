// Business time between two instants (Israel opening hours from support_settings.hours), for the 24-business-hour
// reminder (PRD-email M14, WhatsApp PRD R3א). Minute steps through inHours: exact across weekends and DST, cheap enough
// for a handful of conversations every 15 minutes. Capped at 60 days.
import { inHours, type Hours } from "./bot.ts";

const MIN = 60_000, CAP = 60 * 24 * 60;
export function businessMs(from: Date, to: Date, h: Hours, stopAt = Infinity): number {
  let n = 0;
  const stop = stopAt / MIN;
  for (let t = from.getTime(), i = 0; t < to.getTime() && i < CAP && n < stop; t += MIN, i++) if (inHours(new Date(t), h)) n++;
  return n * MIN;
}
