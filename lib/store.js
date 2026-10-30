// Storage: Postgres when DATABASE_URL is set (Render), otherwise a local JSON file (for dev/testing).
const fs = require("fs");
const path = require("path");

const COLLECTIONS = ["config", "jobs", "contacts", "log"];
let pool = null;
let mem = null;
const FILE = process.env.DATA_FILE || path.join(__dirname, "..", "data.local.json");

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const url = process.env.DATABASE_URL;
    // Render's internal URLs don't need SSL; external ones (*.render.com) do.
    const ssl = /render\.com/.test(url) ? { rejectUnauthorized: false } : false;
    // Keep all Job Lab tables in their own schema so they can share an existing database safely.
    const schema = (process.env.DB_SCHEMA || "joblab").replace(/[^a-z0-9_]/gi, "");
    pool = new Pool({ connectionString: url, ssl, max: 5, options: `-c search_path=${schema}` });
    await pool.query(`create schema if not exists ${schema}`);
    await pool.query(`
      create table if not exists docs (
        coll text not null, id text not null, data jsonb not null,
        updated_at timestamptz not null default now(), primary key (coll, id));
      create table if not exists spend (
        month text primary key, usd numeric not null default 0, calls int not null default 0);
    `);
  } else {
    try { mem = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { mem = { docs: {}, spend: {} }; }
  }
  await seedIfEmpty();
}
function saveMem() { fs.writeFileSync(FILE, JSON.stringify(mem)); }

async function count() {
  if (pool) return Number((await pool.query("select count(*) from docs")).rows[0].count);
  return Object.keys(mem.docs).length;
}
async function seedIfEmpty() {
  if ((await count()) > 0) return;
  const seedFile = path.join(__dirname, "..", "seed.json");
  if (!fs.existsSync(seedFile)) return;
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  for (const d of seed) await put(d.coll, d.id, d.data);
  console.log(`Seeded ${seed.length} documents`);
}

async function all() {
  const out = Object.fromEntries(COLLECTIONS.map(c => [c, []]));
  if (pool) {
    const r = await pool.query("select coll, id, data from docs");
    r.rows.forEach(x => out[x.coll] && out[x.coll].push({ ...x.data, id: x.id }));
  } else {
    Object.entries(mem.docs).forEach(([k, v]) => { const [c, id] = k.split("/"); out[c] && out[c].push({ ...v, id }); });
  }
  return out;
}
async function get(coll, id) {
  if (pool) { const r = await pool.query("select data from docs where coll=$1 and id=$2", [coll, id]); return r.rows[0] ? r.rows[0].data : null; }
  return mem.docs[`${coll}/${id}`] || null;
}
async function put(coll, id, data) {
  if (!COLLECTIONS.includes(coll)) throw new Error("bad collection");
  const clean = { ...data }; delete clean.id;
  if (pool) await pool.query(
    "insert into docs (coll,id,data,updated_at) values ($1,$2,$3,now()) on conflict (coll,id) do update set data=excluded.data, updated_at=now()",
    [coll, id, clean]);
  else { mem.docs[`${coll}/${id}`] = clean; saveMem(); }
}
async function del(coll, id) {
  if (pool) await pool.query("delete from docs where coll=$1 and id=$2", [coll, id]);
  else { delete mem.docs[`${coll}/${id}`]; saveMem(); }
}
async function pruneLog(keep = 300) {
  if (pool) await pool.query(`delete from docs where coll='log' and id not in (
      select id from docs where coll='log' order by (data->>'at') desc limit $1)`, [keep]);
}

// ---- spend tracking (for the monthly AI budget) ----
async function getSpend(month) {
  if (pool) { const r = await pool.query("select usd, calls from spend where month=$1", [month]); return r.rows[0] ? { usd: Number(r.rows[0].usd), calls: r.rows[0].calls } : { usd: 0, calls: 0 }; }
  return mem.spend[month] || { usd: 0, calls: 0 };
}
async function addSpend(month, usd) {
  if (pool) await pool.query(
    "insert into spend (month, usd, calls) values ($1,$2,1) on conflict (month) do update set usd = spend.usd + excluded.usd, calls = spend.calls + 1",
    [month, usd]);
  else { const s = mem.spend[month] || { usd: 0, calls: 0 }; s.usd += usd; s.calls += 1; mem.spend[month] = s; saveMem(); }
}
async function close() { if (pool) await pool.end(); }

module.exports = { init, all, get, put, del, pruneLog, getSpend, addSpend, close, COLLECTIONS };
