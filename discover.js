// Render Cron Job entry point: node discover.js
// Runs the board watch every time; adds a Claude web search on Mondays (or when WEB_SEARCH=always).
const store = require("./lib/store");
const { runDiscovery } = require("./lib/discover");

(async () => {
  await store.init();
  const mode = (process.env.WEB_SEARCH || "weekly").toLowerCase();
  const webSearch = mode === "always" || (mode === "weekly" && new Date().getUTCDay() === 1);
  const r = await runDiscovery({ webSearch, by: "Daily search" });
  console.log(r.text); if (r.errors.length) console.log("Errors:", r.errors);
  await store.close();
})().catch(async e => { console.error(e); process.exit(1); });
