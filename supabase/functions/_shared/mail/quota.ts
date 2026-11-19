// Daily mail quota (PRD-email M10, spec §3): Resend free plan = 100/day. The last 10 are kept for replies to customers;
// alerts beyond that wait (queued) for the hourly job. One warning when a send reaches 80% of the cap.
export type MailKind = "reply" | "alert";
export const RESERVED_FOR_REPLIES = 10;

export function quotaDecision(kind: MailKind, sentToday: number, cap: number):
  { send: true; warn80: boolean } | { send: false; queue: boolean } {
  const limit = kind === "alert" ? cap - RESERVED_FOR_REPLIES : cap;
  if (sentToday >= limit) return { send: false, queue: kind === "alert" };
  return { send: true, warn80: sentToday + 1 === Math.ceil(cap * 0.8) };
}
