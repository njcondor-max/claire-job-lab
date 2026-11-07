# Claire's Job Lab

An AI-assisted job search dashboard for Claire DeSmith. It runs on Render, and Claude API spending is hard-capped at **$20 a month**.

**Address:** https://joblab.njc-labs.com. The old address, https://claire-job-lab.onrender.com, keeps working (same app, no redirect). Each address keeps its own login, so Claire signs in once on the new one.

- **Today**: her top 5 actions, ranked by impact, urgency and effort, plus new high matches, follow-ups and deadlines.
- **Discover**: verified job postings with a match score and missing qualifications. She can import a job from a link or pasted text, and filter the list.
- **Apply**: Claude builds an application kit: a fit check, tailored resume, cover letter, keywords, answers to application questions, and outreach drafts. A truth check flags any number that isn't in her master resume. Downloads as Word or PDF.
- **Pipeline**: a drag-and-drop board with a full history for each job. It suggests follow-ups and flags applications that have gone quiet.
- **Network**: contacts, referral leads, message drafts written by Claude, and "Open in email app".
- **Analytics**: her funnel, response and interview rates, pay ranges, and results by role type and by source.

The Lab never sends email or submits applications. Claire does both herself.

## How the $20 cap works
1. **In the app:** every Claude call is priced from the API's own token counts and recorded in Postgres. Before each call, the server estimates the worst case and refuses if it could go over `BUDGET_USD` for the month. Claire sees a friendly "budget used up" message, and the meter in the header shows spend. It resets on the 1st.
2. **In the Claude Console (backstop):** also set a monthly spend limit of $20 on the workspace that owns the API key, so the cap holds even if the app has a bug.

Rough costs: about 5¢ per application kit (Sonnet), about 0.2¢ to score one job (Haiku), and about 10–20¢ per weekly web search. $20 covers several hundred kits.

## Deploy (about 10 minutes)
1. **API key:** in the Claude Console (platform.claude.com), create a workspace (e.g. "Claire Job Lab"), set its **monthly spend limit to $20**, add billing credit if needed, and create an API key in that workspace.
2. **GitHub:** create a new **private** repo and push this folder to it.
3. **Render:** New → **Blueprint** → choose the repo. Render reads `render.yaml` and creates:
   - `claire-job-lab` (the web app; the **free** plan sleeps when idle, so the first load takes about 30–60s; switch to `starter` for always-on)
   - `claire-job-lab-daily-search` (cron job, weekdays at 12:00 UTC, which is 5–6am in Denver). It runs `node cron.js`, which calls `APP_URL` + `/api/cron/discover` using `CRON_SECRET` (set the same value on both services).
4. When Render asks, fill in `ANTHROPIC_API_KEY`, `APP_PASSWORD` (the password you'll give Claire), and `DATABASE_URL`: the **Internal Database URL** of your existing Render Postgres (Dashboard → your database → Connect). Use the External URL if the database is in a different region. The Lab keeps its tables in their own `joblab` schema, so it never touches your other app's tables.
5. Open the web app's URL, log in, and send Claire the link and password.

On first boot the database is seeded from `seed.json`: her master resume, starter preferences (she confirms these on first login), the 15 verified jobs from Oct 30, and 7 watched companies.

## Settings (environment variables)
| Variable | Default | What it does |
|---|---|---|
| `BUDGET_USD` | `20` | Monthly Claude API cap |
| `WEB_SEARCH` | `weekly` | `weekly` (Mondays), `always` (every run), or `off`. The board watch always runs. |
| `MODEL_DEFAULT` / `MODEL_QUICK` | `claude-sonnet-5-5` / `claude-haiku-5-5` | Models for kits and drafts, and for scoring |
| `APP_PASSWORD` | — | Login password |
| `DB_SCHEMA` | `joblab` | Postgres schema the Lab's tables live in |
| `APP_URL` | — | The web app's address, `https://joblab.njc-labs.com`. The cron job calls it; set it on both services. |
| `CRON_SECRET` | — | Shared secret the cron job sends to the web app; same value on both services |

## How job discovery works
- **Watched companies** (free): every weekday the cron job reads the official public job-board APIs of the companies on the watch list (Greenhouse, Lever, Ashby). It filters for her titles and locations, skips duplicates, scores each new job with Claude, and marks jobs that have left the board as closed. Claire can add companies in Lab settings by pasting a careers link.
- **Web search** (weekly, budgeted): Claude searches the web for more roles. Every link is fetched by the server and confirmed live before it's added.
- Salaries are kept only if the numbers actually appear in the posting.

## Custom domain
`joblab.njc-labs.com` is a Render custom domain on `claire-job-lab`, with a DNS CNAME `joblab` → `claire-job-lab.onrender.com` at Squarespace. The app builds no links to itself: pages and redirects use relative paths, and the cron job reads `APP_URL`. Sign-in is the app's own password, so there are no outside redirect URIs to update.

## Run locally
```
npm install
npm test
APP_PASSWORD=test ANTHROPIC_API_KEY=sk-... node server.js   # no DATABASE_URL → stores in data.local.json
```
