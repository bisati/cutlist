// Gemini client. Every call is metered against the on-disk budget before it is
// made, and recorded after. There is no way to call the API from this codebase
// without going through here, which is the point.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBudget, record, warnIfClose } from './spend.mjs';

// Environment variable first, so the deployed function has a key without a file
// on disk, and so the key it uses can be a different one from the laptop's.
// Falls back to the local file for the indexer and the CLI tools.
function readKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.config/gemini/api_key'), 'utf8').trim();
  } catch {
    throw new Error('No Gemini key. Set GEMINI_API_KEY, or put one at ~/.config/gemini/api_key.');
  }
}
const KEY = readKey();
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const redact = (s) => String(s).replaceAll(KEY, '[KEY]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body, { tries = 4, timeoutMs = 180000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      // Without this a hung socket blocks the whole batch indefinitely.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let r, text;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        text = await r.text();
      } finally { clearTimeout(timer); }

      if (r.ok) return JSON.parse(text);
      last = new Error(`${r.status} ${redact(text).slice(0, 220)}`);
      // Retrying an identical malformed or missing-model request cannot help.
      if (r.status === 400 || r.status === 404) throw last;
    } catch (e) {
      if (/^40[04] /.test(e.message)) throw e;
      last = e;
    }
    if (i < tries - 1) await sleep(1500 * 2 ** i);
  }
  throw last;
}

/**
 * One generateContent call.
 * `label` is required: it is what shows up in the spend ledger, so an
 * unexplained charge is impossible by construction.
 */
export async function gen(model, prompt, { label, schema = null, temperature = 0, estimateInr = 0 } = {}) {
  if (!label) throw new Error('gen() needs a label so the spend ledger stays readable');
  assertBudget(label, estimateInr);

  const generationConfig = { temperature };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }

  const t0 = Date.now();
  const json = await post(`${BASE}/${model}:generateContent?key=${KEY}`, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });
  const ms = Date.now() - t0;

  record({ model, label, usage: json.usageMetadata, ms });
  warnIfClose();

  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
  if (!text) throw new Error(`empty response from ${model} (finish: ${cand?.finishReason})`);
  return { text, data: schema ? JSON.parse(text) : null, ms, usage: json.usageMetadata };
}

export const EMBED_MODEL = 'gemini-embedding-2';
export const EMBED_DIMS = 768;
const EMBED_BATCH = 100;

/** Embed many texts. Free tier on embedding-2, but still metered. */
export async function embed(texts, { label, taskType = 'SEMANTIC_SIMILARITY' } = {}) {
  if (!label) throw new Error('embed() needs a label');
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const chunk = texts.slice(i, i + EMBED_BATCH);
    assertBudget(label);
    const t0 = Date.now();
    const json = await post(`${BASE}/${EMBED_MODEL}:batchEmbedContents?key=${KEY}`, {
      requests: chunk.map((t) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: t.slice(0, 8000) }] },
        taskType,
        outputDimensionality: EMBED_DIMS,
      })),
    });
    // batchEmbedContents reports no usage, so the ledger gets an estimate at
    // roughly 4 characters per token. Flagged in the note so it is never
    // mistaken for a measured figure.
    record({
      model: EMBED_MODEL, label, ms: Date.now() - t0,
      usage: { promptTokenCount: Math.ceil(chunk.join('').length / 4) },
      note: 'token count estimated: batchEmbedContents reports no usage',
    });
    out.push(...json.embeddings.map((e) => e.values));
  }
  warnIfClose();
  return out;
}

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
