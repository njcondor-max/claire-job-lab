// Job board access via the public, official posting APIs of Greenhouse, Lever and Ashby,
// plus a plain page fetch for anything else.
const UA = "Mozilla/5.0 (compatible; ClaireJobLab/1.0; personal job search)";

function decodeEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}
function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, "\n").replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}
async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`${r.status} from ${new URL(url).host}`), { status: r.status });
  return r.json();
}

// Recognize a careers/board/posting URL.
function parseBoardUrl(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  const p = u.pathname.split("/").filter(Boolean);
  if (/greenhouse\.io$/.test(u.hostname)) {
    const token = u.searchParams.get("for") || p[0];
    const jobId = u.searchParams.get("gh_jid") || (p[1] === "jobs" ? p[2] : null);
    return token ? { type: "greenhouse", token, jobId } : null;
  }
  if (u.hostname === "jobs.lever.co") return p[0] ? { type: "lever", token: p[0], jobId: p[1] || null } : null;
  if (u.hostname === "jobs.ashbyhq.com") return p[0] ? { type: "ashby", token: p[0], jobId: p[1] || null } : null;
  if (u.searchParams.get("gh_jid") && u.searchParams.get("for")) return { type: "greenhouse", token: u.searchParams.get("for"), jobId: u.searchParams.get("gh_jid") };
  return null;
}

function workModeFrom(text, flag) {
  const t = String(text || "").toLowerCase();
  if (flag === "Remote" || flag === "remote" || flag === true) return "Remote";
  if (flag === "Hybrid" || flag === "hybrid" || /hybrid/.test(t)) return "Hybrid";
  if (/remote/.test(t)) return "Remote";
  if (flag === "OnSite" || flag === "onsite" || flag === "on-site") return "Onsite";
  return "Unknown";
}

// List open jobs on a board, normalized.
async function listBoard({ type, token, company }) {
  if (type === "greenhouse") {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`);
    return (d.jobs || []).map(j => {
      const text = htmlToText(j.content);
      const loc = (j.location && j.location.name) || "";
      return { extId: String(j.id), company: company || j.company_name || token, title: j.title, location: loc,
        workMode: workModeFrom(loc + " " + text.slice(0, 400)), url: j.absolute_url, source: "Greenhouse",
        postedDate: (j.first_published || "").slice(0, 10) || null, text };
    });
  }
  if (type === "lever") {
    const d = await getJSON(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
    return (d || []).map(j => {
      const text = [j.descriptionPlain, ...(j.lists || []).map(l => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join("\n\n");
      const loc = (j.categories && (j.categories.location || (j.categories.allLocations || []).join(", "))) || "";
      const sr = j.salaryRange;
      return { extId: j.id, company: company || token, title: j.text, location: loc,
        workMode: workModeFrom(loc, j.workplaceType), url: j.hostedUrl, source: "Lever",
        postedDate: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : null, text,
        salaryHint: sr && sr.min ? `$${sr.min.toLocaleString()} - $${sr.max.toLocaleString()} ${sr.interval || ""}`.trim() : null };
    });
  }
  if (type === "ashby") {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`);
    return (d.jobs || []).filter(j => j.isListed !== false).map(j => {
      const loc = [j.location, ...((j.secondaryLocations || []).map(x => x.location))].filter(Boolean).join("; ");
      return { extId: j.id || (j.jobUrl || "").split("/").pop(), company: company || token, title: j.title, location: loc,
        workMode: j.isRemote ? "Remote" : workModeFrom(loc, j.workplaceType), url: j.jobUrl, source: "Ashby",
        postedDate: (j.publishedAt || "").slice(0, 10) || null, text: j.descriptionPlain || htmlToText(j.descriptionHtml),
        salaryHint: j.compensation && (j.compensation.compensationTierSummary || j.compensation.scrapeableCompensationSalarySummary) || null };
    });
  }
  throw new Error("Unknown board type " + type);
}

const CLOSED = /no longer (accepting|available|open|active)|position (has been )?(filled|closed)|job (is )?(not found|closed)|this job has expired|posting (has )?(closed|expired)|page (you.re looking for )?(could ?n.t|cannot) be found/i;

// Fetch one posting. Returns { live, text, title?, company?, source } — used for imports and expiry checks.
async function fetchPosting(url) {
  const b = parseBoardUrl(url);
  if (b && b.jobId) {
    try {
      if (b.type === "greenhouse") {
        const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs/${b.jobId}?pay_transparency=true`);
        const pay = (j.pay_input_ranges || []).map(p => `${p.title || ""} ${p.currency_type || ""} ${p.min_cents / 100}-${p.max_cents / 100}`.trim()).join("; ");
        return { live: true, title: j.title, company: b.token, location: j.location && j.location.name, text: htmlToText(j.content) + (pay ? `\n\nPay: ${pay}` : ""), source: "Greenhouse" };
      }
      if (b.type === "lever") {
        const j = await getJSON(`https://api.lever.co/v0/postings/${b.token}/${b.jobId}?mode=json`);
        return { live: true, title: j.text, company: b.token, location: j.categories && j.categories.location, text: [j.descriptionPlain, ...(j.lists || []).map(l => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join("\n\n"), source: "Lever" };
      }
      if (b.type === "ashby") {
        const list = await listBoard(b);
        const j = list.find(x => String(x.extId) === String(b.jobId) || (x.url || "").includes(b.jobId));
        if (!j) return { live: false, source: "Ashby" };
        return { live: true, title: j.title, company: b.token, location: j.location, text: j.text + (j.salaryHint ? `\n\nCompensation: ${j.salaryHint}` : ""), source: "Ashby" };
      }
    } catch (e) {
      if (e.status === 404) return { live: false, source: b.type };
      throw e;
    }
  }
  const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (r.status === 404 || r.status === 410) return { live: false };
  if (!r.ok) throw Object.assign(new Error(`That site returned ${r.status}. Paste the job description instead.`), { status: r.status });
  const html = await r.text();
  const text = htmlToText(html).slice(0, 30000);
  const title = (html.match(/<title[^>]*>([^<]+)/i) || [])[1];
  return { live: !CLOSED.test(text.slice(0, 6000)) && text.length > 300, text, title: title && decodeEntities(title).trim(), source: new URL(url).hostname.replace(/^www\./, "") };
}

module.exports = { parseBoardUrl, listBoard, fetchPosting, htmlToText };
