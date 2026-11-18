import { test } from "node:test";
import assert from "node:assert/strict";
import { runReminders, flushQueued, cleanupFiles, waitingSince, REMINDER_TEXT, type JobsDb } from "../jobs.ts";

const H = { days: [0, 1, 2, 3, 4], from: "08:00", to: "17:00" };
function fake(due: { id: string; channel: string; since: Date }[] = []) {
  const st = { reminded: [] as string[], removed: [] as string[], queued: [] as any[], live: new Set<string>(), folders: [] as string[] };
  const db: JobsDb = {
    dueReminders: async () => due.filter((x) => !st.reminded.includes(x.id)),
    markReminded: async (id) => { st.reminded.push(id); },
    queuedAlerts: async () => st.queued,
    listAttachmentFolders: async () => st.folders,
    liveConversationIds: async (ids) => new Set(ids.filter((i) => st.live.has(i))),
    removeFolder: async (id) => { st.removed.push(id); },
  };
  return { db, st };
}
const now = new Date("2026-11-19T10:00:00Z"); // Thursday 12:00 Israel

test("reminder after 24 business hours, once", async () => {
  // Tue 17.11 12:00 Israel -> Thu 19.11 12:00 Israel = 9h(Tue 12-17 = 5h) + 9h(Wed) + 4h(Thu 8-12) = 18h: not yet
  // Mon 16.11 12:00 Israel -> Thu 12:00 = 5 + 9 + 9 + 4 = 27h: due
  const { db, st } = fake([{ id: "a", channel: "email", since: new Date("2026-11-17T10:00:00Z") },
    { id: "b", channel: "whatsapp", since: new Date("2026-11-16T10:00:00Z") }]);
  const alerts: string[] = [];
  const d = { db, hours: H, alert: async (t: string) => { alerts.push(t); } };
  assert.equal(await runReminders(d, now), 1);
  assert.deepEqual(st.reminded, ["b"]);
  assert.deepEqual(alerts, [REMINDER_TEXT]);
  assert.equal(await runReminders(d, now), 0);
  assert.equal(alerts.length, 1);
});

test("waitingSince: first inbound after the last agent/bot reply", () => {
  const t = (s: string) => new Date(`2026-11-18T${s}:00Z`);
  assert.deepEqual(waitingSince([{ direction: "in", sender: "contact", at: t("08") }, { direction: "out", sender: "agent", at: t("09") },
    { direction: "in", sender: "contact", at: t("10") }, { direction: "in", sender: "contact", at: t("11") }]), t("10"));
  assert.equal(waitingSince([{ direction: "in", sender: "contact", at: t("08") }, { direction: "out", sender: "agent", at: t("09") }]), null);
  assert.deepEqual(waitingSince([{ direction: "in", sender: "contact", at: t("08") }, { direction: "out", sender: "system", at: t("08") }]), t("08"));
});

test("flushQueued sends until the quota answers queued", async () => {
  const { db, st } = fake();
  st.queued = [{ id: "q1", to: "d@e.com", body: "1", emailMessageId: "<1@y>" }, { id: "q2", to: "d@e.com", body: "2", emailMessageId: "<2@y>" },
    { id: "q3", to: "d@e.com", body: "3", emailMessageId: "<3@y>" }];
  const sent: string[] = [];
  const send = async (r: any) => { if (r.rowId === "q2") return { ok: true, queued: true }; sent.push(r.rowId); return { ok: true, id: r.rowId }; };
  assert.equal(await flushQueued({ db, send }), 1);
  assert.deepEqual(sent, ["q1"]);
});

test("cleanupFiles removes only folders without a live conversation", async () => {
  const { db, st } = fake();
  st.folders = ["v1", "v2", "v3"]; st.live = new Set(["v2"]);
  assert.equal(await cleanupFiles({ db }), 2);
  assert.deepEqual(st.removed, ["v1", "v3"]);
});
