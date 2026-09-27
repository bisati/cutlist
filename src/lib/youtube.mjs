// Search and transcripts. Runs from a laptop on a residential IP, which is the
// whole reason the indexer is offline: the same calls return nothing from a
// datacenter IP (measured 2026-09-24, 0 of 3 from Vercel iad1).

import { Innertube } from 'youtubei.js';
import { YoutubeTranscript } from 'youtube-transcript';

const MIN_SEC = 180;        // under 3 min is a clip, not an explanation
const MAX_SEC = 10800;      // over 3 hr is a stream or a conference recording
const MIN_VIEWS = 5000;

let yt;
const client = async () => (yt ||= await Innertube.create());

function parseViews(s) {
  if (!s) return 0;
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** Search one query, return filtered video stubs. */
export async function search(query, take = 12) {
  const api = await client();
  const res = await api.search(query, { type: 'video' });
  return (res.videos || [])
    .map((v) => ({
      id: v.id,
      title: v.title?.text || '',
      channel: v.author?.name || '',
      channelId: v.author?.id || '',
      durationSec: v.duration?.seconds || 0,
      views: parseViews(v.view_count?.text),
      published: v.published?.text || '',
    }))
    .filter((v) => v.id && v.durationSec >= MIN_SEC && v.durationSec <= MAX_SEC && v.views >= MIN_VIEWS)
    .slice(0, take);
}

/**
 * Fetch a transcript and fold it into ~20s blocks.
 * The blocks are what a model sees: raw caption lines are 2 to 4 words each and
 * drown the prompt in timestamps without adding information.
 */
export async function transcript(videoId) {
  const lines = await YoutubeTranscript.fetchTranscript(videoId);
  if (!lines?.length) throw new Error('empty transcript');
  const blocks = [];
  let cur = { t: lines[0].offset / 1000, parts: [] };
  for (const l of lines) {
    const s = l.offset / 1000;
    if (s - cur.t >= 20 && cur.parts.length) {
      blocks.push({ t: Math.floor(cur.t), text: cur.parts.join(' ') });
      cur = { t: s, parts: [] };
    }
    cur.parts.push(l.text);
  }
  if (cur.parts.length) blocks.push({ t: Math.floor(cur.t), text: cur.parts.join(' ') });
  return { lines, blocks };
}

/** Exact words spoken in [from, to). Used to fill segment.transcript and to verify. */
export function textInRange(lines, from, to) {
  return lines
    .filter((l) => l.offset / 1000 >= from && l.offset / 1000 < to)
    .map((l) => l.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fraction of letters that are Latin script.
 * Searching from an Indian IP returns a lot of Hindi-language AI explainers with
 * Devanagari captions. They are fine videos; they are not usable in an English
 * plan, and mixing scripts inside one plan confounds any judgement of it.
 */
export function latinRatio(text) {
  const letters = text.match(/\p{L}/gu);
  if (!letters?.length) return 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length || 0;
  return latin / letters.length;
}

const MIN_LATIN = 0.8;

/** Fetch transcripts with bounded concurrency; drop the ones that fail. */
export async function transcriptsFor(videos, concurrency = 20, onProgress = () => {}) {
  const out = [];
  const dropped = { noCaptions: 0, notEnglish: 0 };
  let done = 0;
  for (let i = 0; i < videos.length; i += concurrency) {
    const slice = videos.slice(i, i + concurrency);
    await Promise.all(slice.map(async (v) => {
      try {
        const t = await transcript(v.id);
        const sample = t.blocks.slice(0, 12).map((b) => b.text).join(' ');
        if (latinRatio(sample) < MIN_LATIN) { dropped.notEnglish++; return; }
        const words = t.lines.reduce((a, l) => a + l.text.split(/\s+/).length, 0);
        out.push({ ...v, ...t, wordsPerMin: Math.round(words / (v.durationSec / 60)) });
      } catch { dropped.noCaptions++; }
      finally { onProgress(++done, videos.length); }
    }));
  }
  out.dropped = dropped;
  return out;
}
