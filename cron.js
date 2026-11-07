// Render Cron Job entry point: wakes the web app and asks it to run the daily job search.
// APP_URL is the web app's address (e.g. https://joblab.njc-labs.com); nothing here hard-codes a host.
const cronUrl = appUrl => {
  if (!/^https?:\/\//.test(appUrl || "")) throw new Error("APP_URL must be set to the web app's address, e.g. https://joblab.njc-labs.com");
  return appUrl.replace(/\/+$/, "") + "/api/cron/discover";
};
module.exports = { cronUrl };

if (require.main === module) (async () => {
  let url;
  try { url = cronUrl(process.env.APP_URL); } catch (e) { console.log(e.message); process.exit(1); }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET || "" }, signal: AbortSignal.timeout(15 * 60e3) });
      const body = await r.text();
      console.log(r.status, body.slice(0, 1000));
      if (r.ok) return;
      if (r.status === 401) process.exit(1);
    } catch (e) { console.log(`Attempt ${attempt} failed: ${e.message}`); }
    await new Promise(res => setTimeout(res, 30000)); // free web services take ~1 min to wake up
  }
  process.exit(1);
})();
