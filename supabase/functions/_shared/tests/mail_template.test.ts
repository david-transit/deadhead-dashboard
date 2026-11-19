import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMail, replySubject, FROM } from "../mail/template.ts";

const brand = { logoUrl: "https://x.supabase.co/storage/v1/object/public/brand/email-logo.png", siteUrl: "https://yalla-sa.app" };

test("html: rtl, logo, sender name, site link", () => {
  const { html } = renderMail("שלום", brand);
  assert.match(html, /dir="rtl"/);
  assert.ok(html.includes(brand.logoUrl));
  assert.ok(html.includes("יאללה־סע – שירות לקוחות"));
  assert.ok(html.includes('href="https://yalla-sa.app"'));
});

test("html escapes the body and keeps line breaks", () => {
  const { html } = renderMail("<script>x</script>\nשורה 2", brand);
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;<br>שורה 2"));
  assert.ok(!html.includes("<script>"));
});

test("text: body, then -- and the signature", () => {
  const { text } = renderMail("שלום", brand);
  assert.ok(text.startsWith("שלום\n\n--\n"));
  assert.ok(text.includes("יאללה־סע – שירות לקוחות"));
  assert.ok(text.includes("https://yalla-sa.app"));
});

test("whatsapp line only when given", () => {
  assert.ok(!renderMail("x", brand).html.includes("וואטסאפ"));
  const r = renderMail("x", { ...brand, whatsapp: "+972 50-000-0000" });
  assert.ok(r.html.includes("+972 50-000-0000") && r.text.includes("+972 50-000-0000"));
});

test("replySubject", () => {
  assert.equal(replySubject("Re: שאלה"), "Re: שאלה");
  assert.equal(replySubject("RE: שאלה"), "RE: שאלה");
  assert.equal(replySubject("שאלה"), "Re: שאלה");
  assert.equal(replySubject(null), "Re: פנייתך ליאללה־סע");
  assert.equal(replySubject("  "), "Re: פנייתך ליאללה־סע");
});

test("FROM", () => assert.equal(FROM, "יאללה־סע – שירות לקוחות <support@yalla-sa.app>"));

test("links show a short address (a mail gateway may rewrite the href into a very long one)", () => {
  const { html, text } = renderMail("כניסה לאתר: https://yalla-sa.app/\nאו https://yalla-sa.app/support/?a=1&b=2", brand);
  assert.ok(html.includes('<a href="https://yalla-sa.app/" style="color:#0b6bcb">yalla-sa.app</a>'), html);
  assert.ok(html.includes('<a href="https://yalla-sa.app/support/?a=1&amp;b=2" style="color:#0b6bcb">yalla-sa.app/support/?a=1&amp;b=2</a>'), html);
  assert.ok(text.includes("כניסה לאתר: https://yalla-sa.app/"));
});
test("phone-friendly: viewport meta, long words wrap", () => {
  const { html } = renderMail("x", brand);
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(html.includes("word-break:break-word"));
});
test("no link markup injected from text", () => {
  const { html } = renderMail('https://evil.example/"><script>x</script>', brand);
  assert.ok(!html.includes("<script>"));
});
