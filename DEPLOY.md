# Deploying this

## What the deployed app is

A static page plus two serverless functions on Vercel. No database.

The index travels inside the deployment as a 6.7MB bundle in `data/index-bundle/`.
It is written by an offline job and only ever read afterwards, which makes it a
file rather than a database. Cold load measured at 20ms.

```
public/index.html      the page
api/compile.mjs        the streaming endpoint, 3 model calls
api/status.mjs         index size and whether the budget is open
data/index-bundle/     the index, generated, not committed
```

## Before every deploy

```
npm run index:export      # rebuild the bundle from data/index.db
node src/indexer/verify-bundle.mjs
```

The verify step replays saved eval topics against both the database and the
bundle and fails if they choose different segments. The bundle quantises
vectors to float16 and truncates transcripts, and neither is worth anything if
it changes what gets selected, because then the deployed product is not the one
the eval measured. Current worst-case cosine error is 8.35e-5, against a
tolerance of 2e-3.

## Environment variables

| variable | what it does |
|---|---|
| `GEMINI_API_KEY` | **required.** Without it the function throws on first call. |
| `LC_DAILY_CAP_INR` | Daily spend ceiling, default 60. |
| `LC_PER_IP_HOUR` | Plans per address per hour, default 8. |
| `LC_PER_IP_DAY` | Plans per address per day, default 25. |
| `LC_DISABLED` | Set to `1` to switch the endpoint off without redeploying. |

```
vercel env add GEMINI_API_KEY production
vercel env add LC_DAILY_CAP_INR production
```

## What actually protects the budget

Be honest about the ordering here, because the app-level controls are weaker
than they look.

**1. A hard budget cap on the Google Cloud project that owns the key.** This is
the only control that cannot be routed around, and it is the one that matters.
Set it in the Cloud console under Billing, Budgets and alerts. Everything below
is a speed bump by comparison.

**2. The plan cache.** Identical requests are free after the first. Hammering
one query is the cheapest kind of abuse to absorb rather than the most
expensive.

**3. The kill switch.** `LC_DISABLED=1` stops it in seconds.

**4. The daily ceiling and the per-IP limiter.** Both live in memory, and
serverless instances do not share memory, so both are **per instance, not
global**. With a handful of warm instances the real ceiling is some multiple of
`LC_DAILY_CAP_INR`. Treat it as a brake, not a guarantee.

Making 2 and 4 global needs a shared store (Vercel KV or Upstash, both have
free tiers). Worth doing if this ever gets real traffic. Not worth doing before
anyone has used it.

## Cost at the margin

About ₹0.51 per uncached plan, three cheap model calls. Cached plans are free.
A thousand distinct questions is roughly ₹510; a thousand repeats of the same
question is ₹0.51.

## Deploying

```
vercel                 # preview, protected, only the account owner can open it
vercel --prod          # public
```

Preview first. A preview deployment carries Vercel's deployment protection, so
it is reachable by the account owner and nobody else, which is the right place
to check a build that spends money.

## Re-indexing later

```
npm run index:topup     # reads the newest eval result, searches for the gaps
npm run index:run       # pays to index what it found
npm run eval            # confirm coverage improved
npm run index:export    # rebuild the bundle
vercel --prod           # ship it
```
