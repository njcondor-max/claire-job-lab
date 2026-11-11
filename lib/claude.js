// Claude API calls with a hard monthly budget. Every call is priced from the API's own usage numbers.
const store = require("./store");

// USD per million tokens [input, output]. Update if Anthropic changes pricing.
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
const MODELS = {
  quick: process.env.MODEL_QUICK || "claude-haiku-5-5",
  default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5",
  complex: process.env.MODEL_COMPLEX || "claude-sonnet-5-5",
};
const WEB_SEARCH_USD = 0.01; // per search
const API_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";

class BudgetError extends Error { constructor(msg, budget) { super(msg); this.code = "budget"; this.budget = budget; } }

function month() { return new Date().toISOString().slice(0, 7); }
function cap() { return Number(process.env.BUDGET_USD || 20); }
async function budget() {
  const s = await store.getSpend(month());
  return { month: month(), spent: Math.round(s.usd * 10000) / 10000, cap: cap(), calls: s.calls, remaining: Math.max(0, cap() - s.usd) };
}

async function call({ prompt, tier = "default", maxTokens = 4000, webSearches = 0, system, allowedDomains }) {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error("ANTHROPIC_API_KEY is not set on the server."), { code: "config" });
  const model = MODELS[tier] || MODELS.default;
  const [pi, po] = PRICES[model] || [4, 20];
  // Worst-case estimate for this call; refuse if it could push us over the cap.
  const estIn = Math.ceil(prompt.length / 3) + (webSearches ? webSearches * 6000 : 0);
  const estimate = (estIn * pi + maxTokens * po) / 1e6 + webSearches * WEB_SEARCH_USD;
  const b = await budget();
  if (b.spent + estimate > b.cap) {
    throw new BudgetError(`This month's AI budget is used up ($${b.spent.toFixed(2)} of $${b.cap}). It resets on the 1st.`, b);
  }

  const messages = [{ role: "user", content: prompt }];
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (webSearches) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: webSearches, ...(allowedDomains && allowedDomains.length ? { allowed_domains: allowedDomains } : {}) }];

  let text = "", cost = 0;
  for (let turn = 0; turn < 3; turn++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (r.error && r.error.message) || `Claude API error ${res.status}`;
      throw Object.assign(new Error(msg), { code: res.status === 429 || res.status === 529 ? "rate_limited" : "api_error", status: res.status });
    }
    const u = r.usage || {};
    const c = ((u.input_tokens || 0) * pi + (u.cache_creation_input_tokens || 0) * pi * 1.25 + (u.cache_read_input_tokens || 0) * pi * 0.1 + (u.output_tokens || 0) * po) / 1e6
      + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * WEB_SEARCH_USD;
    cost += c;
    await store.addSpend(month(), c);
    text += (r.content || []).filter(x => x.type === "text").map(x => x.text).join("");
    if (r.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: r.content }); // continue a paused web-search turn
  }
  return { text, cost, model, truncated: false };
}

// Raw Messages API call (used by the assistant's tool loop). Budget-checked and priced like call().
async function raw({ tier = "default", system, messages, tools, maxTokens = 2500 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error("ANTHROPIC_API_KEY is not set on the server."), { code: "config" });
  const model = MODELS[tier] || MODELS.default;
  const [pi, po] = PRICES[model] || [4, 20];
  const size = JSON.stringify(messages).length + JSON.stringify(system || "").length + JSON.stringify(tools || []).length;
  const hasSearch = (tools || []).some(t => String(t.type || "").startsWith("web_search"));
  const estimate = (Math.ceil(size / 3) * pi + maxTokens * po) / 1e6 + (hasSearch ? 3 * WEB_SEARCH_USD : 0);
  const b = await budget();
  if (b.spent + estimate > b.cap) throw new BudgetError(`This month's AI budget is used up ($${b.spent.toFixed(2)} of $${b.cap}). It resets on the 1st.`, b);
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (r.error && r.error.message) || `Claude API error ${res.status}`;
    throw Object.assign(new Error(msg), { code: res.status === 429 || res.status === 529 ? "rate_limited" : "api_error", status: res.status });
  }
  const u = r.usage || {};
  const cost = ((u.input_tokens || 0) * pi + (u.cache_creation_input_tokens || 0) * pi * 1.25 + (u.cache_read_input_tokens || 0) * pi * 0.1 + (u.output_tokens || 0) * po) / 1e6
    + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * WEB_SEARCH_USD;
  await store.addSpend(month(), cost);
  return { content: r.content || [], stop: r.stop_reason, cost };
}

function parseJSON(text, expect) {
  const t = String(text || "").replace(/```(?:json)?/gi, "").trim();
  // Try the expected shape first (array or object), then the other; every plausible start so stray brackets in prose don't break parsing.
  const order = expect === "array" ? ["[", "{"] : expect === "object" ? ["{", "["] : (t.indexOf("[") >= 0 && (t.indexOf("{") < 0 || t.indexOf("[") < t.indexOf("{")) ? ["[", "{"] : ["{", "["]);
  for (const open of order) {
    const close = open === "{" ? "}" : "]";
    let start = t.indexOf(open);
    while (start >= 0) {
      const end = t.lastIndexOf(close);
      if (end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch {} }
      start = t.indexOf(open, start + 1);
    }
  }
  throw new Error("Claude didn't return JSON.");
}
async function callJSON(opts) {
  let r = await call(opts);
  try { return { value: parseJSON(r.text, opts.expect), cost: r.cost }; }
  catch (e) {
    console.error(`[claude] unreadable JSON (${(r.text || "").length} chars): ${(r.text || "").slice(0, 200).replace(/\s+/g, " ")} … ${(r.text || "").slice(-120).replace(/\s+/g, " ")}`);
    // One retry with more room and a stricter reminder.
    r = await call({ ...opts, maxTokens: Math.min((opts.maxTokens || 4000) * 2, 8000), prompt: opts.prompt + "\n\nIMPORTANT: Reply with ONLY the JSON object — no prose before or after, and keep every string short." });
    try { return { value: parseJSON(r.text, opts.expect), cost: r.cost }; }
    catch { throw Object.assign(new Error("Claude's answer couldn't be read — please try again."), { code: "bad_json" }); }
  }
}

module.exports = { call, callJSON, raw, budget, BudgetError, MODELS, parseJSON };
