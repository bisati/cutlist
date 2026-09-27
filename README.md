# Learning Compiler

**[learning-compiler.vercel.app](https://learning-compiler.vercel.app)**

Say what you want to understand and how long you have. Get back the segments worth watching, in the order that teaches best, with exact timestamps.

```
"how RAG works", 2 hours  ->  20 segments, 119 minutes, 19 creators, 8 seconds
```

The unit of YouTube is the video. The unit of learning is the concept. They do not line up, so every video costs a search-and-skip tax and you pay it again on the next one. Someone with two hours can burn thirty minutes before learning anything.

The scarce resource is the learner's time, not the content. **The plan is the product.** You watch on YouTube; nothing is hosted or re-uploaded here, and every link goes to the creator's own video at the right moment in it.

---

## What comes out

```
 0 min  The limitations of standalone LLMs          [intro]      IBM Technology     5 min
 5 min  Defining the LLM context window             [intro]      Matt Pocock        6 min
11 min  Word and sentence embeddings                [mechanism]  codebasics         3 min
14 min  How text embeddings represent data          [mechanism]  Chai aur Code      3 min
        ...
94 min  Limitations of long-context LLMs            [debate]     freeCodeCamp       9 min
```

Each segment carries one line saying what it gives you *at that point in the plan*, a deep link with the timestamp, and a running clock so you can see where your two hours actually go.

Every plan ends with what it could **not** cover, and says why:

> *It covers 9 of the 10 things this topic needs. Reranking is struck through because nothing good enough is indexed, not because it does not matter.*

That honesty is the feature. A thin index should say so rather than quietly filling the gap with something loosely related.

---

## How it works

Eight stages. **Three call a model. Five are plain code.**

| | stage | |
|---|---|---|
| 1 | understand the request | model |
| 2 | retrieve candidates | code, cosine similarity |
| 3 | remove duplicates | code, agglomerative clustering |
| 4 | score | code, weighted formula |
| 5 | **pack to the time budget** | code, greedy set-cover then knapsack |
| 6 | order pedagogically | model |
| 7 | verify | code + model |
| 8 | render | code |

That split is the architecture, not an optimisation, and it came from a failure.

An early version was a chain of agents: twenty cheap models each read one video in parallel, then a strong model selected and ordered from their one-line summaries. It produced a plan containing **"ONDC Architecture" seven times, from seven different creators.**

The cause was structural. The planner saw labels, not content, so seven identical explanations were indistinguishable from seven different ones. Told to fill 120 minutes, it filled them with duplicates. **The information needed to spot the repetition had been destroyed at the boundary between the agents.**

So: deduplication is a similarity problem and belongs to embeddings. Packing is a constraint problem and belongs to an algorithm. A cheap model handed the time budget produced a 15-minute plan against a 120-minute request; it picked fine segments and ignored the constraint entirely.

### Storage

**No vector database. In production, no database at all.**

The index is written once by an offline job and only ever read afterwards. Nothing mutates it at runtime, which makes it a file. It ships inside the deployment as a **6.7MB bundle** that loads in **20ms**: half-precision vectors and transcripts truncated to what the verifier actually reads.

Search is a brute-force cosine loop: 19,060 comparisons in **34ms**, against 7 to 12 seconds of model calls in the same request. An ANN index would add a service and a bill to speed up the part that is already 200x smaller than the part next to it.

Indexing uses SQLite locally, because that side is write-heavy and resumable. A video already indexed is never paid for twice.

---

## Measured

A hand-written golden set of 20 questions at budgets from 30 to 120 minutes, each with what a good plan must cover and what it must not drift into. Written before any were run, so the expectations are not reverse-engineered from the output. Scoring is deterministic code.

| | |
|---|---|
| topics succeeding | 20/20 |
| plans that fill their time budget | **100%** |
| concept coverage | **96%** |
| ordering integrity | **100%** |
| escalation to an expensive model | **0%** |
| minutes drifting off topic | **0** |
| creators per plan | 18.1 |
| per plan | **11.5s, about ₹0.51** |

Index: 1,906 segments from 514 creators, 202 hours of source video.

`npm run eval` reproduces it. `--compare <previous>` diffs two runs, which is how every change below was checked.

---

## Five things building it found

**An instruction is not a constraint.** The ordering model kept silently returning fewer segments than it was given, so a fifth of queries escalated to an expensive fallback. Plan size was not the cause: escalating plans averaged 18.8 segments, clean ones 18.0. Adding `minItems`/`maxItems` to the response schema took escalation to zero and **halved cost and latency**.

**One vector cannot do two jobs.** Embedding a four-minute transcript is right for spotting duplicates and wrong for finding things, because it averages into a blur. Segments now carry a second vector built from their own label. Relevance went from 0.73-0.80 to 0.81-0.87, and the matches became correct: asked for "Vector Embeddings", the old way returned "Vector databases vs SQL".

**Retrieval needs a floor.** Taking the top 40 matches regardless of quality meant a thin index got padded with whatever was 38th-best. A reinforcement learning segment was ranking for "Reranking" because nothing better existed. With a floor, that concept is simply reported as uncovered.

**A prompt is biased by its own wording.** The extractor defined a segment using the word "mechanism" and duly labelled 68% of everything that way.

**The eval harness caught itself lying.** It reported 103% concept coverage, which is not a number. The index is loaded once and shared, so segments kept their concept match between queries and, because matches only update on a *higher* score, stale ones could never be displaced. There is now an invariant that crashes instead.

---

## What is still wrong

- **Labels are wrong about twice per plan.** The verification step flags them on the page rather than hiding them, but that rate is too high. It is the next thing to fix.
- **Must-cover sits at 72%**, part genuine index gaps and part the golden set being phrased more colloquially than any video label.
- **One domain only.** AI and language models. Ask about anything else and it will correctly tell you it has nothing.
- **Rate limits are per serverless instance, not global.** A brake, not a guarantee. The real ceiling is a budget cap on the API project.

---

## Running it

```bash
npm install
npm run web          # localhost:4321

npm run eval         # the golden set
npm run spend        # every API call this project has made, and what it cost
```

Rebuilding the index needs a residential IP, because YouTube refuses transcript fetches from datacenter addresses (58 of 60 succeeded from a laptop, 0 of 3 from a server):

```bash
npm run index:candidates   # plan the domain, search, free
npm run index:run          # extract and embed, this is where the money goes
npm run index:topup        # read the eval, search for exactly what is missing
npm run index:export       # build the deployable bundle
```

---
## Built with

Node, no framework. Gemini for the three model calls and for embeddings. `youtubei.js` and `youtube-transcript` for source material. SQLite via `node:sqlite` for indexing. Vercel for hosting.

MIT licensed. The index contains no video content, only timestamps and short transcript excerpts used to locate and verify segments.
