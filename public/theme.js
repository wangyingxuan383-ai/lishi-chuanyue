// The reading theme before anything draws (R09): night readers see no paper flash.
// Kept outside the bundle so it runs first; App.tsx writes lishi.theme.
try {
  var theme = localStorage.getItem("lishi.theme");
  if (theme === "paper" || theme === "day" || theme === "night") document.documentElement.dataset.theme = theme;
} catch (e) { /* storage may be unavailable */ }
document.documentElement.dataset.font = "serif";
