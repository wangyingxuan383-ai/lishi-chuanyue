// The reading theme before anything draws (R09): night readers see no paper flash.
// Kept outside the bundle so it runs first; App.tsx writes lishi.theme.
try {
  var theme = localStorage.getItem("lishi.theme");
  if (theme === "auto") theme = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper";
  if (theme === "paper" || theme === "day" || theme === "night") document.documentElement.dataset.theme = theme;
  // 墨韵 or 宣纸书卷 (D160), so the first frame already has the right look.
  document.documentElement.dataset.style = localStorage.getItem("lishi.style") === "ink" ? "ink" : "scroll";
} catch (e) { /* storage may be unavailable */ }
document.documentElement.dataset.font = "serif";
