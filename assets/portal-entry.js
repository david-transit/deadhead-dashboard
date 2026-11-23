// Sign-in steps that arrive at the tool but belong to the yalla-sa portal (David 23.11.2026, platform map §7.3:
// a tool has no sign-in screen of its own, not even as a fallback). Returns where to send the browser, or "" to stay.
//   #access_token=…&type=recovery  reset-password mail (old links still point here): the hash goes on to the portal
//   #error_description=…           Supabase refused the mail link: the portal shows ?err=mail_link
//   ?recover=1                     recovery-code step: the portal's ?recover=1
// `next` is this tool's path (pathname + search, without recover=1), so the portal returns here after sign-in.
(function (root) {
  "use strict";
  function portalEntry(hash, search, portal, path) {
    const hp = new URLSearchParams(String(hash || "").replace(/^#/, "")), q = new URLSearchParams(search || "");
    if (hp.get("type") === "recovery" && hp.get("access_token")) return portal + "#" + String(hash).replace(/^#/, "");
    const back = () => { ["recover", "err", "error", "error_code", "error_description"].forEach(k => q.delete(k)); const s = q.toString(); return "&next=" + encodeURIComponent(path + (s ? "?" + s : "")) };
    if (hp.get("error_description") || hp.get("error_code") || q.get("error_description")) return portal + "?err=mail_link" + back();
    if (q.get("recover") === "1") return portal + "?recover=1" + back();
    return "";
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { portalEntry };
  else root.portalEntry = portalEntry;
})(this);
