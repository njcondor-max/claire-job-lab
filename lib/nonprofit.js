// Fact-check nonprofit status with ProPublica's Nonprofit Explorer (IRS data). Free, public API.
const cache = new Map();
const norm = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/\b(inc|incorporated|the|org|organization|foundation|corp|corporation|co|llc)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function lookupNonprofit(company, state) {
  const key = norm(company) + "|" + (state || "");
  if (!key.trim() || key.startsWith("|")) return null;
  if (cache.has(key)) return cache.get(key);
  let found = null;
  try {
    const url = `https://projects.propublica.org/nonprofits/api/v2/search.json?q=${encodeURIComponent(company)}${state ? "&state%5Bid%5D=" + state : ""}`;
    const r = await fetch(url, { headers: { "user-agent": "ClaireJobLab/1.0" }, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d = await r.json();
      const target = norm(company);
      const hit = (d.organizations || []).find(o => { const n = norm(o.name); return n === target || (target.length > 5 && (n.startsWith(target) || target.startsWith(n))); });
      if (hit) found = { ein: hit.strein || hit.ein, name: hit.name, city: hit.city, state: hit.state, subsection: hit.subseccd, url: `https://projects.propublica.org/nonprofits/organizations/${hit.ein}` };
    }
  } catch { /* lookup is a bonus; never block on it */ }
  cache.set(key, found);
  return found;
}
module.exports = { lookupNonprofit };
