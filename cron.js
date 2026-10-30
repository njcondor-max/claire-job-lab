// Render Cron Job entry point: wakes the web app and asks it to run the daily job search.
const url = (process.env.APP_URL || "").replace(/\/$/, "") + "/api/cron/discover";
(async () => {
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
