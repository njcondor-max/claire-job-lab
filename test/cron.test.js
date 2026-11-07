// The cron job must call whatever address APP_URL names, including the custom domain.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { cronUrl } = require("../cron");

test("uses a custom-domain APP_URL", () => {
  assert.strictEqual(cronUrl("https://joblab.njc-labs.com"), "https://joblab.njc-labs.com/api/cron/discover");
  assert.strictEqual(cronUrl("https://joblab.njc-labs.com/"), "https://joblab.njc-labs.com/api/cron/discover");
});

test("still works with the old onrender address", () => {
  assert.strictEqual(cronUrl("https://claire-job-lab.onrender.com"), "https://claire-job-lab.onrender.com/api/cron/discover");
});

test("refuses a missing APP_URL instead of calling a relative path", () => {
  assert.throws(() => cronUrl(""), /APP_URL/);
  assert.throws(() => cronUrl(undefined), /APP_URL/);
});

test("no code hard-codes the app's own host", () => {
  for (const f of ["server.js", "cron.js", "discover.js", "public/index.html", ...fs.readdirSync(path.join(__dirname, "../lib")).map(n => "lib/" + n)]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.doesNotMatch(src, /onrender\.com/, `${f} hard-codes a host`);
  }
});
