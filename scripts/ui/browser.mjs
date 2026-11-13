// Browser for the UI scripts: Microsoft Edge by default (Windows), or the
// executable in LISHI_BROWSER (for example /usr/bin/chromium on Linux).
export function launchBrowser(chromium, options = {}) {
  const executablePath = process.env.LISHI_BROWSER;
  return chromium.launch(executablePath ? { ...options, executablePath } : { ...options, channel: "msedge" });
}
