import { test } from "node:test";
import assert from "node:assert/strict";
import { pickConversation, type ThreadDb } from "../mail/thread.ts";

function db(o: { byRef?: Record<string, { id: string; status: string }>; open?: { id: string; status: string } | null } = {}) {
  const calls: string[] = [];
  const d: ThreadDb = {
    convByRefs: async (refs) => { for (const r of refs) if (o.byRef?.[r]) return o.byRef[r]; return null; },
    openEmailConv: async () => o.open ?? null,
    newEmailConv: async (_c, subject) => { calls.push("new:" + subject); return "vNew"; },
    reopen: async (id) => { calls.push("reopen:" + id); },
  };
  return { d, calls };
}

test("ref of an open conversation: same conversation", async () => {
  const { d, calls } = db({ byRef: { "<a@x>": { id: "v1", status: "assigned" } } });
  assert.deepEqual(await pickConversation(d, "c1", ["<a@x>"], "s"), { id: "v1", isNew: false, reopened: false });
  assert.deepEqual(calls, []);
});
test("ref of a closed conversation: reopened", async () => {
  const { d, calls } = db({ byRef: { "<a@x>": { id: "v1", status: "closed" } } });
  assert.deepEqual(await pickConversation(d, "c1", ["<a@x>"], "s"), { id: "v1", isNew: false, reopened: true });
  assert.deepEqual(calls, ["reopen:v1"]);
});
test("no refs, open conversation of the contact: that one, even with another subject", async () => {
  const { d } = db({ open: { id: "v2", status: "open" } });
  assert.deepEqual(await pickConversation(d, "c1", [], "נושא אחר"), { id: "v2", isNew: false, reopened: false });
});
test("no refs, nothing open: new conversation with the subject", async () => {
  const { d, calls } = db();
  assert.deepEqual(await pickConversation(d, "c1", [], "שאלה"), { id: "vNew", isNew: true, reopened: false });
  assert.deepEqual(calls, ["new:שאלה"]);
});
test("unknown refs fall back to the open conversation", async () => {
  const { d } = db({ open: { id: "v2", status: "open" } });
  assert.equal((await pickConversation(d, "c1", ["<zzz@x>"], null)).id, "v2");
});

test("ref of a closed conversation while the contact has another open one: use the open one (one active per contact)", async () => {
  const { d, calls } = db({ byRef: { "<a@x>": { id: "v1", status: "closed" } }, open: { id: "v2", status: "open" } });
  assert.deepEqual(await pickConversation(d, "c1", ["<a@x>"], "s"), { id: "v2", isNew: false, reopened: false });
  assert.deepEqual(calls, []);
});
