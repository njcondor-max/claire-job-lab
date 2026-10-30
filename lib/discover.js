// Job discovery: watched company boards (free, exact) + optional Claude web search (budgeted).
// Every job is verified live before it's saved, deduped, and scored against the master resume.
const store = require("./store");
const claude = require("./claude");
const { listBoard, fetchPosting, parseBoardUrl } = require("./boards");

const sl = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dedupeKey = j => `${sl(j.company)}|${sl(j.title)}|${sl(j.location)}`;
const today = () => new Date().toISOString().slice(0, 10);

const TITLE_OK = /(program|project|delivery|product|implementation|release)\s+manager|scrum master|agile coach|\btpm\b|program lead|project lead/i;
const TITLE_NO = /\b(director|vice president|vp|head of|chief|intern|internship|principal|staff product|group product|coordinator|assistant|construction|civil|mechanical|electrical project|facilities|real estate|clinical research|marketing manager)\b/i;
const CO_PLACES = /colorado|denver|boulder|broomfield|englewood|aurora|lakewood|golden|centennial|littleton|louisville|superior|westminster|lone tree|greenwood village|fort collins|\bCO\b/;
function locationOk(j, prefs) {
  const loc = `${j.location || ""}`;
  const modes = (prefs && prefs.workModes) || ["Remote", "Hybrid", "Onsite"];
  const remote = j.workMode === "Remote" || /remote/i.test(loc);
  if (remote && modes.includes("Remote")) {
    // reject remote roles explicitly limited to non-US regions
    if (/(emea|europe|uk|united kingdom|canada only|india|apac|latam|germany|poland|ireland|australia)/i.test(loc) && !/(us|united states|usa|america)/i.test(loc)) return false;
    return true;
  }
  if (CO_PLACES.test(loc)) return true;
  return prefs && prefs.relocation === "Yes";
}
function titleOk(title, prefs) {
  if (TITLE_NO.test(title)) return false;
  if (TITLE_OK.test(title)) return true;
  return ((prefs && prefs.targetTitles) || []).some(t => t && title.toLowerCase().includes(t.toLowerCase()));
}

const TRUTH = `Use ONLY facts from the MASTER RESUME about Claire. Never invent experience, skills, credentials or numbers. Most roles honestly land 50–85.`;

async function scoreJob(c, prefs, resume) {
  const text = (c.text || "").slice(0, 9000);
  const { value } = await claude.callJSON({ tier: "quick", maxTokens: 900, prompt:
`Extract facts from this job posting and assess Claire DeSmith's fit. ${TRUTH}
For "salary", copy the pay range EXACTLY as written in the posting, or null if none is stated. Never estimate pay.
MASTER RESUME:\n"""${resume}"""\nPREFERENCES: ${JSON.stringify(prefs || {})}
POSTING — ${c.title} at ${c.company} (${c.location}):\n"""${text}${c.salaryHint ? `\nCompensation: ${c.salaryHint}` : ""}"""
Return ONLY JSON: {"company":"proper company name","salary":"exact text or null","salaryMin":number|null,"salaryMax":number|null,"seniority":"Mid|Senior|Lead","category":"Technical Program Manager|Technical Project Manager|Senior Project Manager|Product Manager|Agile Delivery Manager|Project Manager","industry":"short","summary":"2 sentences, paraphrased","requirements":["5-8 paraphrased"],"niceToHave":["..."],"deadline":"YYYY-MM-DD or null","score":0-100,"why":"2 sentences specific to her resume","gaps":["real missing qualifications"]}` });
  // Anti-fabrication: keep a salary only if its numbers actually appear in the posting.
  const hay = (text + " " + (c.salaryHint || "")).replace(/[,\s]/g, "");
  let salary = value.salary, smin = value.salaryMin, smax = value.salaryMax;
  if (salary) {
    const nums = (String(salary).match(/\d[\d,]*/g) || []).map(n => n.replace(/,/g, ""));
    if (!nums.length || !nums.every(n => hay.includes(n))) { salary = c.salaryHint || null; smin = null; smax = null; }
  }
  return { ...value, salary, salaryMin: salary ? smin : null, salaryMax: salary ? smax : null };
}

async function webSearchCandidates(prefs, existing) {
  const { value } = await claude.callJSON({ tier: "default", maxTokens: 2500, webSearches: 6, prompt:
`Find currently open job postings for Claire DeSmith, a Project Manager in Denver, CO with ~5 years of experience (Agile/Scrum, Jira, healthtech, agency delivery, B.S. Electrical Engineering).
Target titles: ${((prefs && prefs.targetTitles) || []).join(", ")}. Location: Denver metro (hybrid/onsite) or US-remote open to Colorado. Mid–senior level, not director/VP. Skip: ${(prefs && prefs.avoid) || "nothing"}.
Prefer direct postings on job-boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com or company career sites. Skip these companies we already track: ${existing.slice(0, 60).join(", ")}.
Return ONLY JSON: [{"company":"","title":"","url":"direct posting URL"}] with up to 10 items. Only include URLs you actually saw in search results.` });
  return Array.isArray(value) ? value.filter(x => x && x.url && /^https?:\/\//.test(x.url)) : [];
}

async function runDiscovery({ webSearch = false, maxNew = 12, by = "Daily search" } = {}) {
  const started = Date.now();
  const st = await store.all();
  const cfg = Object.fromEntries(st.config.map(d => [d.id, d]));
  const prefs = cfg.prefs || {}, resume = (cfg.resume && cfg.resume.text) || "";
  const boards = (cfg.boards && cfg.boards.list) || [];
  const jobs = st.jobs;
  const urls = new Set(jobs.map(j => j.url));
  const keys = new Set(jobs.map(j => j.dedupe || dedupeKey(j)));
  const avoid = String(prefs.avoid || "").toLowerCase().split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const errors = [], liveByBoard = {};
  let candidates = [], dupes = 0;

  for (const b of boards) {
    try {
      const list = await listBoard(b);
      // An empty board is treated as "unknown", never as "everything closed" (protects against API hiccups).
      if (list.length) liveByBoard[`${b.type}:${b.token}`] = new Set(list.map(x => x.url));
      list.filter(j => titleOk(j.title, prefs) && locationOk(j, prefs)).forEach(j => candidates.push({ ...j, company: b.company || j.company, fromBoard: true }));
    } catch (e) { errors.push(`${b.company || b.token}: ${e.message}`); }
  }
  if (webSearch) {
    try {
      const found = await webSearchCandidates(prefs, [...new Set(jobs.map(j => j.company))]);
      for (const f of found) {
        if (urls.has(f.url)) { dupes++; continue; }
        try {
          const p = await fetchPosting(f.url);
          if (!p.live) continue;
          const b = parseBoardUrl(f.url);
          candidates.push({ company: f.company, title: p.title && p.title.length < 120 ? p.title.replace(/\s*[-|].*(greenhouse|lever|ashby|careers|jobs).*$/i, "") || f.title : f.title,
            location: p.location || "", workMode: /remote/i.test(p.text.slice(0, 3000)) ? "Remote" : /hybrid/i.test(p.text.slice(0, 3000)) ? "Hybrid" : "Unknown",
            url: f.url, source: b ? b.type[0].toUpperCase() + b.type.slice(1) : (p.source || "Company site"), text: p.text, postedDate: null });
        } catch { /* unreachable posting — skip, never guess */ }
      }
    } catch (e) { errors.push(`Web search: ${e.message}`); if (e.code === "budget") webSearch = false; }
  }

  // dedupe
  const fresh = [];
  for (const c of candidates) {
    const k = dedupeKey(c);
    if (urls.has(c.url) || keys.has(k)) { dupes++; continue; }
    if (avoid.some(a => `${c.company} ${c.title}`.toLowerCase().includes(a))) continue;
    urls.add(c.url); keys.add(k); fresh.push(c);
  }

  // score + save
  let added = 0;
  const minSal = Number(prefs.minSalary || 0) * 1000;
  for (const c of fresh.slice(0, maxNew)) {
    try {
      const s = resume ? await scoreJob(c, prefs, resume) : { score: null };
      if (minSal && s.salaryMax && s.salaryMax < minSal) continue;
      const now = new Date().toISOString();
      const id = `job-auto-${sl(c.company).slice(0, 18)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      await store.put("jobs", id, {
        company: c.fromBoard ? c.company : (s.company || c.company), title: c.title, location: c.location, workMode: c.workMode, url: c.url, source: c.source,
        salary: s.salary || null, salaryMin: s.salaryMin || null, salaryMax: s.salaryMax || null, postedDate: c.postedDate || null, deadline: s.deadline || null,
        seniority: s.seniority, category: s.category, industry: s.industry, summary: s.summary, requirements: s.requirements || [], niceToHave: s.niceToHave || [],
        description: (c.text || "").slice(0, 20000),
        verified: true, verifiedAt: today(), origin: "automation", stage: "Discovered", dedupe: dedupeKey(c), createdAt: now, foundAt: now,
        match: s.score != null ? { score: s.score, why: s.why, gaps: s.gaps || [], by: "Claude", at: now } : null,
        history: [{ at: now, text: `Found & verified live on ${c.source} (${by.toLowerCase()})` }],
      });
      added++;
    } catch (e) { errors.push(`${c.company}: ${e.message}`); if (e.code === "budget") break; }
  }

  // expiry: mark closed postings
  let closed = 0, checked = 0;
  for (const j of jobs.filter(j => ["Discovered", "Shortlisted"].includes(j.stage) && !j.expired && j.url)) {
    const b = parseBoardUrl(j.url);
    const boardKey = b && `${b.type}:${b.token}`;
    let live = null;
    if (boardKey && liveByBoard[boardKey]) live = liveByBoard[boardKey].has(j.url) || [...liveByBoard[boardKey]].some(u => b.jobId && u.includes(b.jobId));
    else if (j.verifiedAt !== today() && checked < 15) {
      checked++;
      try { live = (await fetchPosting(j.url)).live; } catch { live = null; }
    }
    if (live === false) { await store.put("jobs", j.id, { ...j, expired: true, expiredAt: new Date().toISOString(), history: [...(j.history || []), { at: new Date().toISOString(), text: "Posting closed (found by daily check)" }] }); closed++; }
    else if (live === true && j.verifiedAt !== today()) await store.put("jobs", j.id, { ...j, verifiedAt: today() });
  }

  const text = `Found ${added} new verified role${added === 1 ? "" : "s"}, skipped ${dupes} duplicate${dupes === 1 ? "" : "s"}, marked ${closed} closed` + (webSearch ? " (incl. web search)" : "");
  const at = new Date().toISOString();
  await store.put("log", `log-discovery-${Date.now()}`, { at, type: "discovery", by, text, secs: Math.round((Date.now() - started) / 1000) });
  if (errors.length) await store.put("log", `log-error-${Date.now()}`, { at, type: "error", by, text: errors.slice(0, 8).join(" · ") });
  await store.pruneLog();
  return { added, dupes, closed, errors, text };
}

module.exports = { runDiscovery, dedupeKey };
