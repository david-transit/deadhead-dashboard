import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, htmlToText, type Parsed } from "../mail/parse.ts";

const AR_PASS = "mx.cloudflare.net; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com; spf=pass smtp.mailfrom=gmail.com";
// objects in the shape PostalMime.parse returns (RFC 2047 already decoded)
const mail = (o: Partial<Parsed> & { ar?: string | null; extra?: [string, string][] } = {}): Parsed => {
  const headers: { key: string; value: string }[] = [];
  if (o.ar !== null) headers.push({ key: "authentication-results", value: o.ar ?? AR_PASS });
  for (const [key, value] of o.extra ?? []) headers.push({ key, value });
  return { from: { address: "moshe@gmail.com", name: "משה כהן" }, subject: "בעיה בכניסה", messageId: "<m1@gmail.com>",
    text: "שלום, לא מצליח להיכנס", attachments: [], ...o, headers };
};

test("hebrew plain mail: ok, fields kept", () => {
  const m = classify(mail());
  assert.equal(m.verdict, "ok");
  assert.equal(m.email, "moshe@gmail.com");
  assert.equal(m.name, "משה כהן");
  assert.equal(m.subject, "בעיה בכניסה");
  assert.equal(m.text, "שלום, לא מצליח להיכנס");
  assert.equal(m.messageId, "<m1@gmail.com>");
});

test("html only: text without tags or images", () => {
  const m = classify(mail({ text: undefined, html: '<div>שורה&nbsp;1<br>שורה 2</div><p><img src="https://track/x.png">סוף &amp; זהו</p><style>p{}</style>' }));
  assert.equal(m.text, "שורה 1\nשורה 2\nסוף & זהו");
  assert.ok(!m.text.includes("img") && !m.text.includes("track"));
});

test("spoofing verdicts from Cloudflare's Authentication-Results", () => {
  assert.equal(classify(mail({ ar: "mx.cloudflare.net; dkim=pass; dmarc=fail; spf=pass" })).verdict, "spoofed");
  assert.equal(classify(mail({ ar: "mx.cloudflare.net; dkim=none; dmarc=none; spf=fail" })).verdict, "spoofed");
  assert.equal(classify(mail({ ar: "mx.cloudflare.net; dkim=none; dmarc=none; spf=pass" })).verdict, "ok");
  assert.equal(classify(mail({ ar: "mx.cloudflare.net; dkim=pass; dmarc=none; spf=softfail" })).verdict, "ok");
});

test("another server's Authentication-Results is ignored; none at all = ok", () => {
  assert.equal(classify(mail({ ar: "evil.example; dkim=fail; dmarc=fail; spf=fail" })).verdict, "ok");
  assert.equal(classify(mail({ ar: null })).verdict, "ok");
});

test("auto replies and lists", () => {
  assert.equal(classify(mail({ extra: [["auto-submitted", "auto-replied"]] })).verdict, "auto");
  assert.equal(classify(mail({ extra: [["auto-submitted", "no"]] })).verdict, "ok");
  assert.equal(classify(mail({ extra: [["precedence", "bulk"]] })).verdict, "auto");
  assert.equal(classify(mail({ extra: [["x-autoreply", "yes"]] })).verdict, "auto");
  assert.equal(classify(mail({ extra: [["list-id", "<news.example.com>"]] })).verdict, "auto");
});

test("bounce: MAILER-DAEMON, refs include our id", () => {
  const m = classify(mail({ from: { address: "MAILER-DAEMON@googlemail.com" }, inReplyTo: "<abc@yalla-sa.app>",
    extra: [["auto-submitted", "auto-replied"]] }));
  assert.equal(m.verdict, "bounce");
  assert.deepEqual(m.refs, ["<abc@yalla-sa.app>"]);
  assert.equal(classify(mail({ from: { address: "postmaster@x.com" } })).verdict, "bounce");
});

test("mail from our own domain (reply-all, loops)", () => {
  assert.equal(classify(mail({ from: { address: "support@yalla-sa.app" } })).verdict, "own_domain");
  assert.equal(classify(mail({ from: { address: "x@Yalla-Sa.App" } })).verdict, "own_domain");
});

test("upper-case address is lower-cased", () => {
  assert.equal(classify(mail({ from: { address: "Moshe@Gmail.com" } })).email, "moshe@gmail.com");
});

test("refs: In-Reply-To + References, deduped, with <>", () => {
  const m = classify(mail({ inReplyTo: "<b@x>", references: "<a@x> <b@x>" }));
  assert.deepEqual(m.refs, ["<b@x>", "<a@x>"]);
});

test("missing Message-ID gets a generated one", () => {
  assert.match(classify(mail({ messageId: undefined })).messageId, /^<gen-[0-9a-f-]{36}@yalla-sa\.app>$/);
});

test("attachments over 10MB in total are dropped", () => {
  const big = new Uint8Array(6 * 1024 * 1024);
  const m = classify(mail({ attachments: [{ filename: "a.pdf", mimeType: "application/pdf", content: big },
    { filename: "b.pdf", mimeType: "application/pdf", content: big }] }));
  assert.deepEqual(m.files, []);
  assert.equal(m.filesDropped, 2);
});

test("hebrew file name kept; path characters removed", () => {
  const m = classify(mail({ attachments: [{ filename: "צילום מסך.png", mimeType: "image/png", content: new Uint8Array(3) },
    { filename: "../../etc/x.txt", mimeType: "text/plain", content: new Uint8Array(1) }, { mimeType: "image/png", content: new Uint8Array(1) }] }));
  assert.deepEqual(m.files.map((f) => f.name), ["צילום מסך.png", "etcx.txt", "file-3"]);
  assert.equal(m.filesDropped, 0);
});

test("htmlToText decodes numeric entities", () => {
  assert.equal(htmlToText("&#1513;&#1500;&#1493;&#1501;"), "שלום");
});

test("a forged Authentication-Results below Cloudflare's real ARC header is ignored (topmost wins)", () => {
  const p = mail({ ar: null, extra: [
    ["arc-authentication-results", "i=1; mx.cloudflare.net; dkim=none; dmarc=fail header.from=gmail.com; spf=fail"],
    ["authentication-results", "mx.cloudflare.net; dkim=pass; dmarc=pass; spf=pass"]] });
  assert.equal(classify(p).verdict, "spoofed");
});
