// Load the static index bundle into memory, once per serverless instance.
//
// The deployed app carries its index inside the deployment rather than talking
// to a database. The index is written by an offline job and only ever read
// afterwards, so it is a file. That removes a service, a set of credentials, a
// monthly bill, and a network round trip from every query.
//
// 6.7MB, loaded once and reused for the life of the instance.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'data/index-bundle');

let INDEX = null;
let MANIFEST = null;

export function loadBundle() {
  if (INDEX) return { index: INDEX, manifest: MANIFEST };

  MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const meta = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'meta.json.gz'))).toString('utf8'));
  const { dims, count, segments } = meta;

  const readVecs = (file) => {
    const buf = fs.readFileSync(path.join(DIR, file));
    return new Float16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  };
  const label = readVecs('label.f16');
  const trans = readVecs('transcript.f16');

  if (label.length !== count * dims || trans.length !== count * dims) {
    throw new Error(`bundle is inconsistent: ${count} segments but ${label.length / dims} label vectors. Re-run npm run index:export.`);
  }

  // Subarrays are views over the one buffer, so this allocates no copies.
  INDEX = segments.map((m, i) => ({
    videoId: m.v,
    title: m.t,
    channel: m.ch,
    concept: m.c,
    teaches: m.te,
    depth: m.d,
    startSec: m.s,
    endSec: m.e,
    durationSec: m.e - m.s,
    views: m.w,
    published: m.p,
    wordsPerMin: m.wpm,
    duration_sec: m.vd,
    transcript: m.x,
    // The real transcript length, kept because the shipped text is truncated to
    // what the verifier reads. Without this the "is there content here" check
    // would start failing on segments that are fine.
    transcriptLength: m.tl,
    vecLabel: label.subarray(i * dims, (i + 1) * dims),
    vec: trans.subarray(i * dims, (i + 1) * dims),
  }));

  return { index: INDEX, manifest: MANIFEST };
}
