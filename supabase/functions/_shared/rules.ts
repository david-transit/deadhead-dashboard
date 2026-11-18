// WhatsApp sending rules (yalla-sa support, spec docs/superpowers/specs/2026-11-18-whatsapp-design.md §3).
// Pure functions: no I/O, so they run the same in the Edge Function (Deno) and in node --test.

export type Category = "utility" | "authentication" | "marketing" | "service";
export interface Settings {
  monthly_cap_ils: number; usd_ils: number; rates: Record<Category, number>;
  ai_daily_per_contact: number; menu_daily_per_contact: number;
}
export type Block = "opted_out" | "no_consent" | "window_closed" | "budget_exceeded" | null;

const WINDOW_MS = 24 * 3600_000; // Meta customer-service window

// "050-123-4567", "+972 50 1234567", "972501234567" -> "972501234567"; anything too short -> null
export function normPhone(raw: string): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "972" + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : null;
}

export function costIls(cat: Category, s: Settings): number {
  return (s.rates[cat] ?? 0) * s.usd_ils;
}

export function budgetLevel(spentIls: number, s: Settings): "ok" | "warn80" | "over" {
  if (spentIls >= s.monthly_cap_ils) return "over";
  return spentIls >= 0.8 * s.monthly_cap_ils ? "warn80" : "ok";
}

// Why a message may not be sent (null = may send). Opt-out stops every message WE start (templates), even login
// codes (R1א); a reply to someone who wrote to us inside the 24h window is still allowed (R1א: "פנייה חוזרת").
// Login codes (authentication) need no consent tick and never stop on budget (R11).
export function sendBlock(o: {
  kind: "template" | "text"; category: Category; optedOut: boolean; consent: boolean;
  lastInboundAt: Date | null; now: Date; spentIls: number; s: Settings;
}): Block {
  if (o.optedOut && o.kind === "template") return "opted_out";
  if (o.kind === "text") {
    if (!o.lastInboundAt || o.now.getTime() - o.lastInboundAt.getTime() > WINDOW_MS) return "window_closed";
    return null; // a reply inside the window is a free service message
  }
  if (o.category === "authentication") return null;
  if (!o.consent) return "no_consent";
  if (costIls(o.category, o.s) > 0 && budgetLevel(o.spentIls, o.s) === "over") return "budget_exceeded";
  return null;
}

// Meta may deliver the same status twice: record spend for a message id once only.
export function spendOnce(seen: Set<string>, waMessageId: string): boolean {
  if (seen.has(waMessageId)) return false;
  seen.add(waMessageId);
  return true;
}
