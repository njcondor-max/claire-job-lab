const express = require("express");
const crypto = require("crypto");
const path = require("path");
const store = require("./lib/store");
const claude = require("./lib/claude");
const { fetchPosting, parseBoardUrl, listBoard } = require("./lib/boards");
const { runDiscovery, rescoreJobs, missionOn } = require("./lib/discover");
const assistant = require("./lib/assistant");

const app = express();
app.set("trust proxy", 1);
const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "jl_session";
const DAYS = 30;

// ---------- auth (one shared password, signed cookie) ----------
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function cookieOk(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [exp, sig] = decodeURIComponent(raw.split("=")[1]).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const attempts = new Map();
const loginPage = (msg = "") => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claire's Job Lab</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Plus+Jakarta+Sans:wght@500;700&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Plus Jakarta Sans",sans-serif;color:#2B2340;background:radial-gradient(700px 400px at 100% 0,#FFE1D2,transparent 60%),radial-gradient(600px 380px at 0 0,#FFF0C2,transparent 55%),#FFF8EF}
.c{background:#fff;border:1px solid #F0E6DA;border-radius:22px;padding:32px;width:min(380px,90vw);box-shadow:0 20px 50px -25px rgba(43,35,64,.35);text-align:center}
h1{font-family:"Bricolage Grotesque";margin:12px 0 4px}p{color:#857A96;margin:0 0 18px}input{width:100%;box-sizing:border-box;border:1px solid #F0E6DA;border-radius:12px;padding:12px;font:inherit;margin-bottom:12px}
button{width:100%;border:0;border-radius:12px;padding:12px;font:inherit;font-weight:700;background:#FF6B4A;color:#fff;cursor:pointer}.e{color:#b72a4e;font-size:14px;margin-bottom:10px}</style></head>
<body><form class="c" method="post" action="/login"><svg width="56" height="56" viewBox="0 0 46 46"><circle cx="23" cy="23" r="23" fill="#FFC23D"/><circle cx="23" cy="23" r="12" fill="#FF6B4A"/><path d="M17 24.5l4 4 8-9" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
<h1>Claire's Job Lab</h1><p>Welcome back! ☀️</p>${msg ? `<div class="e">${msg}</div>` : ""}<input type="password" name="password" placeholder="Password" autofocus required><button>Open my Lab</button></form></body></html>`;

app.get("/healthz", (req, res) => res.send("ok"));
app.get("/login", (req, res) => res.send(loginPage()));
app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip, a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).send(loginPage("Too many tries — wait 15 minutes."));
  const given = String(req.body.password || "");
  const ok = PASSWORD && given.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
  if (!ok) { a.n++; attempts.set(ip, a); return res.status(401).send(loginPage(PASSWORD ? "That password didn’t work." : "APP_PASSWORD isn’t set on the server yet.")); }
  const exp = String(Date.now() + DAYS * 864e5);
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(exp + "." + sign(exp))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${req.secure ? "; Secure" : ""}`);
  res.redirect("/");
});
app.post("/logout", (req, res) => { res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0`); res.redirect("/login"); });

// Daily search trigger for the Render cron job (authenticated by a shared secret, not the login cookie).
let discovering = null;
app.post("/api/cron/discover", async (req, res) => {
  const secret = process.env.CRON_SECRET || "", given = String(req.headers["x-cron-secret"] || "");
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return res.status(401).json({ code: "auth" });
  try {
    const mode = (process.env.WEB_SEARCH || "weekly").toLowerCase();
    const prefs = await store.get("config", "prefs");
    // With mission focus on, search the web twice a week (Mon + Thu) to find mission-driven companies beyond the watch list.
    const days = missionOn(prefs) ? [1, 4] : [1];
    const webSearch = mode === "always" || (mode === "weekly" && days.includes(new Date().getUTCDay()));
    if (!discovering) discovering = runDiscovery({ webSearch, by: "Daily search" }).finally(() => { discovering = null; });
    res.json(await discovering);
  } catch (e) { console.error(e); res.status(500).json({ code: "error", message: e.message }); }
});

app.use((req, res, next) => {
  if (cookieOk(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ code: "auth", message: "Please log in again." });
  res.redirect("/login");
});

// ---------- app ----------
app.use(express.json({ limit: "2mb" }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  const status = e.code === "budget" ? 402 : e.code === "rate_limited" ? 429 : e.status === 404 ? 404 : 500;
  if (status === 500) console.error(e);
  res.status(status).json({ code: e.code || "error", message: e.message, budget: e.budget });
});

app.get("/api/state", wrap(async (req, res) => {
  const st = await store.all();
  st.log.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  res.json({ ...st, log: st.log.slice(0, 200), budget: await claude.budget(), server: { webSearch: process.env.WEB_SEARCH || "weekly" } });
}));
app.put("/api/doc/:coll/:id", wrap(async (req, res) => {
  const { coll, id } = req.params;
  if (!store.COLLECTIONS.includes(coll) || !/^[\w.:@+~-]{1,160}$/.test(id)) return res.status(400).json({ code: "bad_path" });
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ code: "bad_body" });
  await store.put(coll, id, req.body);
  res.json({ ok: true });
}));
app.delete("/api/doc/:coll/:id", wrap(async (req, res) => { await store.del(req.params.coll, req.params.id); res.json({ ok: true }); }));

app.get("/api/budget", wrap(async (req, res) => res.json(await claude.budget())));
app.post("/api/ai", wrap(async (req, res) => {
  const { prompt, tier, maxTokens } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.length > 60000) return res.status(400).json({ code: "bad_prompt" });
  const r = await claude.callJSON({ prompt, tier: ["quick", "default", "complex"].includes(tier) ? tier : "default", maxTokens: Math.min(Number(maxTokens) || 5000, 8000) });
  res.json({ value: r.value, cost: r.cost, budget: await claude.budget() });
}));

app.post("/api/chat", wrap(async (req, res) => {
  const history = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  const r = await assistant.chat(history);
  const saved = [...history, { role: "assistant", content: r.reply, changes: r.changes, at: new Date().toISOString() }].slice(-40);
  await store.put("config", "chat", { messages: saved, updatedAt: new Date().toISOString() });
  res.json({ ...r, budget: await claude.budget() });
}));
app.delete("/api/chat", wrap(async (req, res) => { await store.put("config", "chat", { messages: [], updatedAt: new Date().toISOString() }); res.json({ ok: true }); }));
app.post("/api/rescore", wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  res.json({ ...(await rescoreJobs({ ids })), budget: await claude.budget() });
}));

app.post("/api/fetch-job", wrap(async (req, res) => {
  const url = String((req.body || {}).url || "");
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ code: "bad_url", message: "That doesn't look like a link." });
  if (/linkedin\.com|indeed\.com|glassdoor\.com/.test(url)) return res.status(422).json({ code: "blocked_site", message: "LinkedIn/Indeed/Glassdoor block automatic reading — paste the description text instead." });
  const p = await fetchPosting(url);
  if (!p.live) return res.status(410).json({ code: "closed", message: "That posting looks closed or removed." });
  res.json(p);
}));

app.post("/api/boards/check", wrap(async (req, res) => {
  const b = parseBoardUrl(String((req.body || {}).url || ""));
  if (!b) return res.status(400).json({ code: "unsupported", message: "Paste a Greenhouse, Lever or Ashby careers link (e.g. job-boards.greenhouse.io/company)." });
  const list = await listBoard(b);
  res.json({ type: b.type, token: b.token, openJobs: list.length });
}));

app.post("/api/discover", wrap(async (req, res) => {
  if (!discovering) discovering = runDiscovery({ webSearch: !!(req.body && req.body.webSearch), by: "Manual search" }).finally(() => { discovering = null; });
  res.json(await discovering);
}));

// Document libraries served from our own server (no third-party CDN needed).
const nm = p => path.join(__dirname, "node_modules", p);
app.get("/vendor/jspdf.js", (q, r) => r.sendFile(nm("jspdf/dist/jspdf.umd.min.js")));
app.get("/vendor/docx.js", (q, r) => r.sendFile(nm("docx/build/index.umd.js")));
app.get("/vendor/mammoth.js", (q, r) => r.sendFile(nm("mammoth/mammoth.browser.min.js")));
app.get("/vendor/pdf.js", (q, r) => r.sendFile(nm("pdfjs-dist/build/pdf.min.js")));
app.get("/vendor/pdf.worker.js", (q, r) => r.sendFile(nm("pdfjs-dist/build/pdf.worker.min.js")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

const PORT = process.env.PORT || 3000;
store.init().then(() => app.listen(PORT, () => {
  console.log(`Claire's Job Lab on :${PORT}`);
  console.log(`Storage: ${process.env.DATABASE_URL ? "Postgres (schema " + (process.env.DB_SCHEMA || "joblab") + ")" : "LOCAL FILE — set DATABASE_URL!"} · Claude key: ${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING"} · Password: ${PASSWORD ? "set" : "MISSING"} · Budget: $${process.env.BUDGET_USD || 20}/mo`);
})).catch(e => { console.error(e); process.exit(1); });
