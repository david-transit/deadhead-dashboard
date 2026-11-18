import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaKind } from "../rules.ts";
import { mediaUpload, mediaPayload } from "../meta.ts";
import { sendMessage } from "../send.ts";
import { fakeDb, okFetch } from "./fakedb.ts";

const MB = 1024 * 1024;

test("mediaKind: images up to 5MB, audio/video up to 16MB, anything else as a document up to 100MB", () => {
  assert.deepEqual(mediaKind("image/png", 4 * MB), { kind: "image" });
  assert.deepEqual(mediaKind("image/jpeg", 6 * MB), { error: "too_large", limitMb: 5 });
  assert.deepEqual(mediaKind("audio/ogg", 2 * MB), { kind: "audio" });
  assert.deepEqual(mediaKind("video/mp4", 17 * MB), { error: "too_large", limitMb: 16 });
  assert.deepEqual(mediaKind("application/pdf", 50 * MB), { kind: "document" });
  assert.deepEqual(mediaKind("application/zip", 101 * MB), { error: "too_large", limitMb: 100 });
  assert.deepEqual(mediaKind("image/gif", 1 * MB), { kind: "document" }); // WhatsApp images: jpeg/png only
  assert.deepEqual(mediaKind("", 0), { error: "empty" });
});

test("mediaUpload: posts the file to the phone's media endpoint and returns the media id", async () => {
  const calls: any[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "MEDIA1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const id = await mediaUpload(new Blob(["x"], { type: "image/png" }), "shot.png", { token: "T", phoneId: "P" }, f);
  assert.equal(id, "MEDIA1");
  assert.equal(calls[0].url, "https://graph.facebook.com/v26.0/P/media");
  const form = calls[0].init.body as FormData;
  assert.equal(form.get("messaging_product"), "whatsapp");
  assert.equal((form.get("file") as File).name, "shot.png");
});

test("mediaPayload: document keeps its file name; image has none", () => {
  assert.deepEqual(mediaPayload("972501234567", "document", "M1", "הסבר.pdf"),
    { messaging_product: "whatsapp", to: "972501234567", type: "document", document: { id: "M1", filename: "הסבר.pdf" } });
  assert.deepEqual(mediaPayload("972501234567", "image", "M2", "a.png"),
    { messaging_product: "whatsapp", to: "972501234567", type: "image", image: { id: "M2" } });
});

test("sendMessage: a file is a free reply inside 24h, stored as name+type only, and blocked after 24h", async () => {
  const now = new Date("2026-11-19T10:00:00Z");
  const USER = "972501234567";
  const { db, st } = fakeDb();
  st.contacts.set(USER, { id: "c1", consent: false, optedOut: false });
  st.lastInbound.set(USER, new Date(now.getTime() - 3600_000));
  const f = okFetch();
  const req = { to: USER, kind: "media" as const, media: { kind: "document" as const, id: "M1", filename: "הסבר.pdf", size: 2048 },
    category: "service" as const, sender: "agent" as const, agentId: "u1", conversationId: "cv1" };
  const r = await sendMessage({ db, cfg: { token: "T", phoneId: "P" }, fetchFn: f.fn, now }, req);
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].type, "document");
  assert.equal(st.messages[0].body, "📎 הסבר.pdf (2 KB)");
  st.lastInbound.set(USER, new Date(now.getTime() - 25 * 3600_000));
  const r2 = await sendMessage({ db, cfg: { token: "T", phoneId: "P" }, fetchFn: f.fn, now }, req);
  assert.equal(r2.block, "window_closed");
});
