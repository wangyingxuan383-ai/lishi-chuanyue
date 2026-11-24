// Applies the saved look, reading theme, and motion preference before first paint
// so night readers never see a light flash and reduced/off motion holds from frame 0.
try {
  var root = document.documentElement;
  var theme = localStorage.getItem("lishi.theme");
  if (theme === "auto") theme = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper";
  if (theme === "paper" || theme === "day" || theme === "night") root.dataset.theme = theme;
  root.dataset.style = localStorage.getItem("lishi.style") === "ink" ? "ink" : "scroll";
  var motion = localStorage.getItem("lishi.motion");
  if (motion === "rich" || motion === "simple" || motion === "off") root.dataset.motion = motion;
} catch (e) { /* storage may be unavailable */ }
document.documentElement.dataset.font = "serif";
