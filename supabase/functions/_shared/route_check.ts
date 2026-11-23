// route_check (R51 live check, David 23.11.2026): one click on "בדיקה עכשיו" next to a route warning marked
// "לבדיקה ידנית" in the dashboard's route warnings list -> one Google Routes call -> Google's km goes back to that browser
// and nowhere else. Pure logic (no I/O), so it is unit-tested in node (tests/route_check.test.ts).
//
// What is NOT done, on purpose (Maps ToS 3.2.3, Service Terms 19.2-19.3): Google's km, time, route or geometry is never
// written to the database, a log, a cache or a header; the response is "Cache-Control: no-store". Only the shared call
// counter (google_take -> google_usage) moves. The dashboard shows the km in the warnings list only, never next to a map,
// with the credit "Google Maps".
//
// Order (fail closed, quota last): input -> key configured -> the caller's capability (can_verify_route, with the
// caller's own token) -> google_take (day / month caps, same as the control panel's figures) -> Google.

export const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
export const CAPS = { day: 300, month: 4500 }; // = _shared/status/collect.ts G_DAY / G_MONTH
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LatLon = [number, number];
export type Input = { operator_id: string; a: LatLon; b: LatLon };
export type Deps = {
  key: string;                                   // GOOGLE_ROUTES_API_KEY (Supabase secret, set by David)
  allowed(operatorId: string): Promise<boolean>; // public.can_verify_route as the caller
  take(caps: typeof CAPS): Promise<boolean>;     // public.google_take (service role)
  post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
};
export type Result = { status: number; body: { ok: true; km: number | null } | { error: string } };

// Israel (the same bounds as route_ok / route_km_manual)
const inIsrael = (p: unknown): p is LatLon =>
  Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x)) &&
  p[0] >= 29 && p[0] <= 34 && p[1] >= 34 && p[1] <= 36.5;

export function parseInput(b: unknown): Input | null {
  const x = b as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return null;
  const op = String(x.operator_id ?? "");
  if (!UUID.test(op) || !inIsrael(x.a) || !inIsrael(x.b)) return null;
  return { operator_id: op, a: [x.a[0], x.a[1]], b: [x.b[0], x.b[1]] };
}

export function googleBody(a: LatLon, b: LatLon) {
  const at = (p: LatLon) => ({ location: { latLng: { latitude: p[0], longitude: p[1] } } });
  return { origin: at(a), destination: at(b), travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE", units: "METRIC" };
}

// km to one decimal, or null when Google has no route
export function kmOf(j: unknown): number | null {
  const r = (j as { routes?: { distanceMeters?: unknown }[] } | null)?.routes;
  const m = Array.isArray(r) && r.length ? Number(r[0]?.distanceMeters) : NaN;
  return Number.isFinite(m) && m > 0 ? Math.round(m / 100) / 10 : null;
}

export async function check(raw: unknown, d: Deps): Promise<Result> {
  const inp = parseInput(raw);
  if (!inp) return { status: 400, body: { error: "bad_input" } };
  if (!d.key) return { status: 503, body: { error: "not_configured" } };
  if (!(await d.allowed(inp.operator_id))) return { status: 403, body: { error: "not_allowed" } };
  if (!(await d.take(CAPS))) return { status: 429, body: { error: "quota" } };
  let j: unknown;
  try {
    j = await d.post(ENDPOINT, googleBody(inp.a, inp.b),
      { "Content-Type": "application/json", "X-Goog-Api-Key": d.key, "X-Goog-FieldMask": "routes.distanceMeters" });
  } catch {
    return { status: 502, body: { error: "google_error" } };
  }
  return { status: 200, body: { ok: true, km: kmOf(j) } };
}
