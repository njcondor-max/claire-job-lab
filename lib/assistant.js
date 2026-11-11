// "Ask Claude" — an assistant that can answer anything, take actions inside the Lab, or walk Claire through it.
// It can change Lab data (jobs, contacts, preferences, watched companies). It can NOT send email or submit applications.
const store = require("./store");
const claude = require("./claude");
const { fetchPosting, parseBoardUrl, listBoard } = require("./boards");
const { runDiscovery, rescoreJobs, scoreJob, dedupeKey } = require("./discover");

const STAGES = ["Discovered", "Shortlisted", "Preparing", "Applied", "Recruiter Contact", "Interviewing", "Final Round", "Offer", "Closed"];
const VIEWS = ["today", "discover", "apply", "pipeline", "network", "analytics", "settings", "resume", "preferences"];
const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const addDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const sl = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const GUIDE = `HOW THE LAB WORKS (use this to walk her through things):
- Top bar: tabs Today, Discover, Apply, Pipeline, Network, Analytics. Top right: AI budget meter, save status, "Lab settings" (preferences, master resume, companies we watch, automation log, log out).
- Today: top 5 recommended actions with buttons, new high matches, coming up (interviews/deadlines), waiting to hear back ("Got a reply" button), follow-ups due, ready to submit.
- Discover: job cards with match score ring, "Why it fits" (AI), missing qualifications, filters (search, min match, min salary, work style, seniority, role type, mission-driven only). Buttons: Shortlist, Open posting, Details, Not for me, Remove from shortlist. "Add a job you found": paste a link (Greenhouse/Lever/Ashby read automatically) or the description. "Check watched companies" and "Deep search" run a search now.
- Apply: left = master resume + shortlist; right = the selected job. "Build my application kit" makes a fit check, tailored resume, cover letter, keywords, application Q&A, contact & outreach drafts. Each has Copy, Save, and Word/PDF download. A truth check flags numbers not in her master resume. When she has submitted on the employer's site, she clicks "I submitted this application".
- Pipeline: drag cards between stages; click a card for details: stage, follow-up date, deadline, interviews, notes/history, documents.
- Network: contacts (Add a contact), message drafts with Claude, "Open in email app", "I sent it" logs the touch and sets a 7-day follow-up.
- Analytics: funnel, response/interview rates, pay ranges, results by role type and source.
- The daily search runs weekday mornings (watched company boards; broad web search on some days). Gmail/Calendar aren't connected.`;

const TOOLS = [
  { name: "list_jobs", description: "List jobs in the Lab (compact). Filter by stage, text, mission-driven, min score. Use before acting on a job to get its id.",
    input_schema: { type: "object", properties: { stage: { type: "string", enum: STAGES }, query: { type: "string" }, missionOnly: { type: "boolean" }, minScore: { type: "number" }, includeHidden: { type: "boolean" } } } },
  { name: "get_job", description: "Full details for one job: requirements, match, mission, history, interviews, whether an application kit exists.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "update_job", description: "Change a job: stage, follow-up date, deadline, hide/unhide, add a note. Setting stage 'Applied' is only allowed if Claire says she already submitted it herself (set claireSubmitted true).",
    input_schema: { type: "object", properties: { id: { type: "string" }, stage: { type: "string", enum: STAGES }, followUpDate: { type: "string", description: "YYYY-MM-DD or empty to clear" }, deadline: { type: "string" }, hidden: { type: "boolean" }, note: { type: "string" }, claireSubmitted: { type: "boolean" } }, required: ["id"] } },
  { name: "add_interview", description: "Add an interview to a job (moves it to Interviewing if earlier).",
    input_schema: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } }, required: ["id", "date"] } },
  { name: "add_job_from_url", description: "Add a job posting by URL. The Lab opens the posting, confirms it's live, checks for duplicates, scores fit and saves it to Discover. LinkedIn/Indeed links can't be read.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "list_contacts", description: "List networking contacts.", input_schema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "add_contact", description: "Save a networking contact (only details Claire provides or that are on a public page she shared).",
    input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, company: { type: "string" }, email: { type: "string" }, linkedin: { type: "string" }, how: { type: "string", description: "how she knows them" }, jobId: { type: "string" }, nextFollowUp: { type: "string" }, referral: { type: "boolean" }, notes: { type: "string" } }, required: ["name"] } },
  { name: "log_contact_touch", description: "Log a conversation/message with a contact and optionally set the next follow-up date.",
    input_schema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, nextFollowUp: { type: "string" } }, required: ["id", "text"] } },
  { name: "get_preferences", description: "Read her job-search preferences.", input_schema: { type: "object", properties: {} } },
  { name: "update_preferences", description: "Update job-search preferences. Only change what she asked to change.",
    input_schema: { type: "object", properties: {
      location: { type: "string" }, minSalary: { type: "string", description: "in $k, e.g. '110'" }, relocation: { type: "string", enum: ["", "No", "Maybe, for the right role", "Yes"] },
      preferredMode: { type: "string", enum: ["Hybrid", "Remote", "Onsite", "No preference"] }, workModes: { type: "array", items: { type: "string", enum: ["Remote", "Hybrid", "Onsite"] } },
      seniority: { type: "array", items: { type: "string", enum: ["Mid", "Senior", "Lead"] } }, targetTitles: { type: "array", items: { type: "string" } },
      industries: { type: "string" }, avoid: { type: "string" },
      missionPriority: { type: "string", enum: ["Only mission-driven", "Strongly prefer", "Nice to have", "No preference"] }, missionFocus: { type: "array", items: { type: "string" } } } } },
  { name: "add_watched_company", description: "Add a company to the daily board watch by its Greenhouse, Lever or Ashby careers URL. The Lab verifies the board first.",
    input_schema: { type: "object", properties: { careersUrl: { type: "string" }, company: { type: "string" } }, required: ["careersUrl"] } },
  { name: "run_job_search", description: "Run the job search now. webSearch=true adds a broader Claude web search (~10–20¢). Takes 1–3 minutes.",
    input_schema: { type: "object", properties: { webSearch: { type: "boolean" } } } },
  { name: "rescore_jobs", description: "Re-score open jobs against current preferences (e.g. after changing mission focus). ~0.2¢ per job.",
    input_schema: { type: "object", properties: {} } },
  { name: "get_resume", description: "Read her master resume (the only source of truth about her experience).", input_schema: { type: "object", properties: {} } },
  { name: "open_in_lab", description: "Navigate the Lab for her after you reply: open a tab, a job's details, a contact, settings, the resume or preferences editor, or start building an application kit for a job (action 'build_kit').",
    input_schema: { type: "object", properties: { view: { type: "string", enum: VIEWS }, jobId: { type: "string" }, contactId: { type: "string" }, action: { type: "string", enum: ["open_job", "build_kit", "open_contact"] } }, required: ["view"] } },
];

async function loadAll() {
  const st = await store.all();
  const cfg = Object.fromEntries(st.config.map(d => [d.id, d]));
  return { st, cfg };
}
function compactJob(j) {
  return { id: j.id, company: j.company, title: j.title, stage: j.stage, score: j.match && j.match.score, workMode: j.workMode, location: j.location,
    salary: j.salary || null, mission: j.mission ? `${j.mission.driven ? "mission-driven" : "for-profit"}${j.mission.type ? " · " + j.mission.type : ""}` : null,
    followUpDate: j.followUpDate || null, hidden: !!j.hidden, expired: !!j.expired, hasKit: !!j.kit };
}
function hist(o, text) { o.history = [...(o.history || []), { at: nowIso(), text }]; return o; }

async function runTool(name, input, ctx) {
  const { st, cfg } = await loadAll();
  const job = id => st.jobs.find(j => j.id === id);
  switch (name) {
    case "list_jobs": {
      let js = st.jobs.filter(j => input.includeHidden || !j.hidden);
      if (input.stage) js = js.filter(j => j.stage === input.stage);
      if (input.query) { const q = input.query.toLowerCase(); js = js.filter(j => `${j.company} ${j.title} ${j.location} ${j.industry}`.toLowerCase().includes(q)); }
      if (input.missionOnly) js = js.filter(j => j.mission && j.mission.driven);
      if (input.minScore) js = js.filter(j => (j.match && j.match.score || 0) >= input.minScore);
      js.sort((a, b) => (b.match && b.match.score || 0) - (a.match && a.match.score || 0));
      return { count: js.length, jobs: js.slice(0, 40).map(compactJob) };
    }
    case "get_job": {
      const j = job(input.id); if (!j) return { error: "No job with that id" };
      const { description, kit, versions, ...rest } = j;
      return { ...rest, description: (description || "").slice(0, 3000), hasKit: !!kit, kitSummary: kit && kit.analysis ? kit.analysis.summary : null };
    }
    case "update_job": {
      const j = job(input.id); if (!j) return { error: "No job with that id" };
      const changes = [];
      if (input.stage && input.stage !== j.stage) {
        if (input.stage === "Applied" && !input.claireSubmitted) return { error: "Only mark Applied after Claire confirms she submitted it herself." };
        if (input.stage === "Applied" && !j.appliedAt) { j.appliedAt = nowIso(); j.followUpDate = addDays(7); }
        if (["Recruiter Contact", "Interviewing", "Final Round", "Offer"].includes(input.stage) && !j.respondedAt) j.respondedAt = nowIso();
        hist(j, `Moved from ${j.stage} to ${input.stage} (via Ask Claude)`); changes.push(`stage → ${input.stage}`); j.stage = input.stage;
      }
      if (input.followUpDate !== undefined) { j.followUpDate = input.followUpDate || null; changes.push(`follow-up ${input.followUpDate || "cleared"}`); }
      if (input.deadline !== undefined) { j.deadline = input.deadline || null; changes.push(`deadline ${input.deadline || "cleared"}`); }
      if (input.hidden !== undefined) { j.hidden = input.hidden; if (input.hidden && ["Shortlisted", "Preparing"].includes(j.stage)) j.stage = "Discovered"; changes.push(input.hidden ? "hidden" : "unhidden"); }
      if (input.note) { hist(j, "📝 " + input.note); changes.push("note added"); }
      await store.put("jobs", j.id, j);
      ctx.changes.push(`${j.company}: ${changes.join(", ") || "no change"}`);
      return { ok: true, job: compactJob(j) };
    }
    case "add_interview": {
      const j = job(input.id); if (!j) return { error: "No job with that id" };
      j.interviews = [...(j.interviews || []), { label: input.label || "Interview", date: input.date }];
      if (!["Interviewing", "Final Round", "Offer"].includes(j.stage)) { j.stage = "Interviewing"; if (!j.respondedAt) j.respondedAt = nowIso(); }
      hist(j, `Interview scheduled: ${input.label || "Interview"} on ${input.date} (via Ask Claude)`);
      await store.put("jobs", j.id, j); ctx.changes.push(`${j.company}: interview on ${input.date}`);
      return { ok: true };
    }
    case "add_job_from_url": {
      const url = String(input.url || "");
      if (/linkedin\.com|indeed\.com|glassdoor\.com/.test(url)) return { error: "That site blocks automatic reading — ask Claire to paste the description into Discover → Add a job you found." };
      if (st.jobs.some(j => j.url === url)) return { error: "Already in the Lab", job: compactJob(st.jobs.find(j => j.url === url)) };
      const p = await fetchPosting(url);
      if (!p.live) return { error: "That posting looks closed or couldn't be read." };
      const b = parseBoardUrl(url);
      const c = { company: p.company || "", title: p.title || "Role", location: p.location || "", text: p.text };
      const s = await scoreJob(c, cfg.prefs || {}, (cfg.resume && cfg.resume.text) || "");
      const company = s.company || c.company;
      const key = dedupeKey({ company, title: c.title, location: c.location });
      const dup = st.jobs.find(j => (j.dedupe || dedupeKey(j)) === key);
      if (dup) return { error: "Looks like a duplicate", job: compactJob(dup) };
      const id = `job-${sl(company).slice(0, 18)}-${Date.now().toString(36)}`;
      const j = { company, title: c.title, location: c.location, workMode: /remote/i.test(p.text.slice(0, 3000)) ? "Remote" : /hybrid/i.test(p.text.slice(0, 3000)) ? "Hybrid" : "Unknown",
        url, source: b ? b.type[0].toUpperCase() + b.type.slice(1) : (p.source || "Company site"), salary: s.salary || null, salaryMin: s.salaryMin || null, salaryMax: s.salaryMax || null,
        seniority: s.seniority, category: s.category, industry: s.industry, summary: s.summary, requirements: s.requirements || [], niceToHave: s.niceToHave || [], deadline: s.deadline || null,
        description: p.text.slice(0, 20000), verified: true, verifiedAt: today(), origin: "imported", stage: "Discovered", dedupe: key, createdAt: nowIso(), foundAt: nowIso(),
        match: { score: s.score, why: s.why, gaps: s.gaps || [], by: "Claude", at: nowIso() }, mission: s.mission || null,
        history: [{ at: nowIso(), text: "Added via Ask Claude (verified live)" }] };
      await store.put("jobs", id, j); ctx.changes.push(`Added ${company} — ${c.title} (${s.score}%)`);
      return { ok: true, job: compactJob({ ...j, id }) };
    }
    case "list_contacts": {
      let cs = st.contacts; if (input.query) { const q = input.query.toLowerCase(); cs = cs.filter(c => `${c.name} ${c.company} ${c.role}`.toLowerCase().includes(q)); }
      return { contacts: cs.slice(0, 40).map(c => ({ id: c.id, name: c.name, role: c.role, company: c.company, email: c.email, lastContact: c.lastContact, nextFollowUp: c.nextFollowUp, referral: c.referral })) };
    }
    case "add_contact": {
      const id = `c-${sl(input.name).slice(0, 20)}-${Date.now().toString(36)}`;
      const c = { name: input.name, role: input.role || "", company: input.company || "", email: input.email || "", linkedin: input.linkedin || "", how: input.how || "", jobId: input.jobId || "",
        nextFollowUp: input.nextFollowUp || null, referral: !!input.referral, notes: input.notes || "", createdAt: nowIso(), history: [{ at: nowIso(), text: "Added via Ask Claude" }] };
      await store.put("contacts", id, c); ctx.changes.push(`Added contact ${c.name}${c.company ? " (" + c.company + ")" : ""}`);
      return { ok: true, id };
    }
    case "log_contact_touch": {
      const c = st.contacts.find(x => x.id === input.id); if (!c) return { error: "No contact with that id" };
      hist(c, input.text); c.lastContact = nowIso(); if (input.nextFollowUp) c.nextFollowUp = input.nextFollowUp;
      await store.put("contacts", c.id, c); ctx.changes.push(`Logged touch with ${c.name}`);
      return { ok: true };
    }
    case "get_preferences": return cfg.prefs || {};
    case "update_preferences": {
      const p = { ...(cfg.prefs || {}) }; const changed = [];
      for (const [k, v] of Object.entries(input)) if (v !== undefined) { p[k] = v; changed.push(k); }
      p.updatedAt = nowIso();
      await store.put("config", "prefs", p); ctx.changes.push(`Preferences updated: ${changed.join(", ")}`);
      return { ok: true, prefs: p, tip: changed.some(k => k.startsWith("mission")) ? "Offer to re-score open jobs so mission fit is reflected." : undefined };
    }
    case "add_watched_company": {
      const b = parseBoardUrl(input.careersUrl); if (!b) return { error: "Needs a Greenhouse, Lever or Ashby careers link." };
      const list = await listBoard(b);
      const boards = ((cfg.boards && cfg.boards.list) || []).filter(x => !(x.type === b.type && x.token === b.token));
      boards.push({ type: b.type, token: b.token, company: input.company || b.token });
      await store.put("config", "boards", { list: boards }); ctx.changes.push(`Watching ${input.company || b.token} (${list.length} open jobs)`);
      return { ok: true, openJobs: list.length };
    }
    case "run_job_search": { const r = await runDiscovery({ webSearch: !!input.webSearch, by: "Ask Claude search" }); ctx.changes.push(r.text); return r; }
    case "rescore_jobs": { const r = await rescoreJobs({}); ctx.changes.push(`Re-scored ${r.rescored} jobs`); return r; }
    case "get_resume": return { text: (cfg.resume && cfg.resume.text) || "(no resume saved)" };
    case "open_in_lab": ctx.ui.push(input); return { ok: true, note: "Will open after your reply." };
  }
  return { error: "Unknown tool" };
}

async function chat(history) {
  const { st, cfg } = await loadAll();
  const prefs = cfg.prefs || {};
  const pipeline = {};
  st.jobs.filter(j => !j.hidden && !j.expired).forEach(j => { pipeline[j.stage] = (pipeline[j.stage] || 0) + 1; });
  const system = [{ type: "text", cache_control: { type: "ephemeral" }, text:
`You are "Ask Claude" inside Claire's Job Lab — Claire DeSmith's personal job-search assistant. Be warm, upbeat, concise and practical. Plain English. Short paragraphs or bullets.
You can answer anything (career advice, interview prep, salary research, nonprofit sector questions, how-tos), take actions in the Lab with your tools, or walk her through doing it herself — whichever she asks for. If unclear, do the reversible thing and say what you did.
RULES:
- Never invent facts about Claire. Her MASTER RESUME (get_resume) is the only source about her experience. Don't claim skills, numbers or credentials she doesn't have.
- You cannot send emails, submit applications, or contact anyone. You can draft text for her to send. Only mark a job Applied when she says she already submitted it.
- Never fabricate job postings, salaries, or contact details. Use web search for current facts and say where they came from.
- Before bulk or hard-to-undo changes (hiding many jobs, overwriting preferences), confirm with her first.
- After taking actions, briefly say what you changed. Use open_in_lab to take her to the right screen when helpful (e.g. build_kit for a job she wants to apply to).
- Each message costs a little of the $${process.env.BUDGET_USD || 20}/month AI budget; don't run searches or re-scores she didn't ask for.
${GUIDE}`},
  { type: "text", text: `TODAY: ${today()}. PREFERENCES: ${JSON.stringify(prefs)}. PIPELINE COUNTS: ${JSON.stringify(pipeline)}. CONTACTS: ${st.contacts.length}. AI BUDGET: ${JSON.stringify(await claude.budget())}.` }];

  const messages = history.slice(-20).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 8000) }))
    .filter((m, i, a) => m.content && !(i === 0 && m.role === "assistant"));
  if (!messages.length || messages[messages.length - 1].role !== "user") throw Object.assign(new Error("Say something first!"), { code: "bad_request" });
  const tools = [...TOOLS, { type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  const ctx = { changes: [], ui: [] };
  let reply = "", cost = 0;
  for (let step = 0; step < 8; step++) {
    const r = await claude.raw({ tier: "default", system, messages, tools, maxTokens: 2000 });
    cost += r.cost;
    const texts = r.content.filter(b => b.type === "text").map(b => b.text).join("");
    if (r.stop === "tool_use") {
      messages.push({ role: "assistant", content: r.content });
      const results = [];
      for (const b of r.content.filter(b => b.type === "tool_use")) {
        let out;
        try { out = await runTool(b.name, b.input || {}, ctx); } catch (e) { out = { error: e.message }; if (e.code === "budget") throw e; }
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    if (r.stop === "pause_turn") { messages.push({ role: "assistant", content: r.content }); continue; }
    reply = texts; break;
  }
  return { reply: reply || "Done!", changes: ctx.changes, ui: ctx.ui, cost };
}

module.exports = { chat };
