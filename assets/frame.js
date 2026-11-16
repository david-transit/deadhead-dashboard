// clickjacking guard (security review M5): this site never runs inside a frame of another page
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try { window.top.location.replace(window.self.location.href); } catch (e) { /* cross-origin top: stay blank */ }
  throw new Error("framed");
}
