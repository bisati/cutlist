// Local store for the index.
//
// SQLite rather than Postgres for now. The indexer and the CLI iterate many
// times a day and neither needs a server, credentials, or a network hop. Column
// names mirror the Postgres schema this was planned against exactly, and
// embeddings are stored as raw float32, so moving to Supabase and pgvector later
// is a dump and a load rather than a rewrite.
//
// Uses node:sqlite, built into Node 22+, so this adds no dependency.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_PATH = process.env.LC_DB || path.join(ROOT, 'data/index.db');

export const toBlob = (arr) => Buffer.from(new Float32Array(arr).buffer);
export const fromBlob = (buf) =>
  buf ? Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)) : null;

export function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      slug        TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      indexed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS subtopics (
      id          INTEGER PRIMARY KEY,
      domain      TEXT NOT NULL REFERENCES domains(slug),
      name        TEXT NOT NULL,
      queries     TEXT NOT NULL,             -- JSON array of search strings
      UNIQUE(domain, name)
    );

    CREATE TABLE IF NOT EXISTS videos (
      id               TEXT PRIMARY KEY,     -- YouTube video id
      domain           TEXT NOT NULL REFERENCES domains(slug),
      title            TEXT,
      channel          TEXT,
      channel_id       TEXT,
      duration_sec     INTEGER,
      views            INTEGER,
      published_at     TEXT,
      found_via        TEXT,                 -- which subtopic surfaced it
      -- found: search only. usable: transcript fetched and passed filters.
      -- extracted: segments written. rejected/failed: see the reason column.
      status           TEXT NOT NULL DEFAULT 'found',
      reason           TEXT,
      transcript_lines INTEGER,
      words_per_min    REAL,
      indexed_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS videos_status ON videos(domain, status);

    CREATE TABLE IF NOT EXISTS segments (
      id          INTEGER PRIMARY KEY,
      video_id    TEXT NOT NULL REFERENCES videos(id),
      start_sec   INTEGER NOT NULL,
      end_sec     INTEGER NOT NULL,
      concept     TEXT NOT NULL,
      teaches     TEXT NOT NULL,
      depth       TEXT NOT NULL,             -- intro | mechanism | example | debate
      transcript  TEXT NOT NULL,
      merged_from INTEGER NOT NULL DEFAULT 1,
      -- Two vectors, for two different jobs. The transcript one is used for
      -- DEDUPLICATION, where content similarity is what matters. The label one
      -- is concept plus teaches and is used for RETRIEVAL, where a sharp topical
      -- match matters and a 4-minute transcript averages into something too
      -- blurry to discriminate. Measured: top-1 relevance rose from 0.73-0.80
      -- to 0.81-0.87 when retrieval moved to the label vector.
      embedding       BLOB,                  -- float32[768] of the transcript
      embedding_label BLOB,                  -- float32[768] of concept + teaches
      quality     REAL
    );
    CREATE INDEX IF NOT EXISTS segments_video ON segments(video_id);
  `);
  return db;
}

// ----------------------------------------------------------------- write side

export function upsertDomain(db, slug, label) {
  db.prepare(`INSERT INTO domains (slug,label) VALUES (?,?)
              ON CONFLICT(slug) DO UPDATE SET label=excluded.label`).run(slug, label);
}

export function upsertSubtopic(db, domain, name, queries) {
  db.prepare(`INSERT INTO subtopics (domain,name,queries) VALUES (?,?,?)
              ON CONFLICT(domain,name) DO UPDATE SET queries=excluded.queries`)
    .run(domain, name, JSON.stringify(queries));
}

/** Insert a freshly found video. Existing rows are left alone so a re-search
 *  never resets progress or loses which subtopic first surfaced it. */
export function addCandidate(db, domain, v, foundVia) {
  db.prepare(`INSERT INTO videos
      (id,domain,title,channel,channel_id,duration_sec,views,published_at,found_via,status)
      VALUES (?,?,?,?,?,?,?,?,?,'found')
      ON CONFLICT(id) DO NOTHING`)
    .run(v.id, domain, v.title, v.channel, v.channelId || null,
         v.durationSec, v.views, v.published || null, foundVia);
}

export function setVideoStatus(db, id, status, reason = null) {
  db.prepare('UPDATE videos SET status=?, reason=? WHERE id=?').run(status, reason, id);
}

export function markExtracted(db, id, { transcriptLines, wordsPerMin }) {
  db.prepare(`UPDATE videos SET status='extracted', transcript_lines=?, words_per_min=?,
              indexed_at=? WHERE id=?`)
    .run(transcriptLines, wordsPerMin, new Date().toISOString(), id);
}

export function insertSegments(db, videoId, segs) {
  const stmt = db.prepare(`INSERT INTO segments
    (video_id,start_sec,end_sec,concept,teaches,depth,transcript,merged_from,embedding,embedding_label,quality)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const s of segs) {
    stmt.run(videoId, s.startSec, s.endSec, s.concept, s.teaches, s.depth,
             s.transcript, s.mergedFrom || 1,
             s.vec ? toBlob(s.vec) : null,
             s.vecLabel ? toBlob(s.vecLabel) : null,
             s.quality ?? null);
  }
}

/** Drop a video's segments so it can be re-extracted without duplicating. */
export function clearSegments(db, videoId) {
  db.prepare('DELETE FROM segments WHERE video_id=?').run(videoId);
}

// ------------------------------------------------------------------ read side

/**
 * Videos still to index, interleaved round-robin across subtopics.
 *
 * Ordering by raw view count instead skews the whole index toward whatever is
 * popular, which for AI on YouTube means general-audience overviews of three or
 * four fashionable topics. Rotating across subtopics means a half-finished
 * index is still a balanced one, and stopping early costs breadth evenly rather
 * than dropping whole areas.
 */
export function pendingVideos(db, domain, limit = 1000) {
  const rows = db.prepare(`SELECT * FROM videos WHERE domain=? AND status='found'
                           ORDER BY views DESC`).all(domain);
  const byTopic = new Map();
  for (const r of rows) {
    const k = r.found_via || '(none)';
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push(r);
  }
  const queues = [...byTopic.values()];
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let moved = false;
    for (const q of queues) {
      if (i < q.length) { out.push(q[i]); moved = true; if (out.length >= limit) break; }
    }
    if (!moved) break;
  }
  return out;
}

export function allSegments(db, { withVectors = true } = {}) {
  const rows = db.prepare(`
    SELECT s.*, v.title, v.channel, v.views, v.published_at, v.words_per_min, v.duration_sec
    FROM segments s JOIN videos v ON v.id = s.video_id`).all();
  return rows.map((r) => ({
    ...r,
    durationSec: r.end_sec - r.start_sec,
    startSec: r.start_sec,
    endSec: r.end_sec,
    videoId: r.video_id,
    wordsPerMin: r.words_per_min,
    published: r.published_at,
    vec: withVectors ? fromBlob(r.embedding) : null,
    vecLabel: withVectors ? fromBlob(r.embedding_label) : null,
    embedding: undefined,
    embedding_label: undefined,
  }));
}

export function stats(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  return {
    videos: all(`SELECT status, COUNT(*) n FROM videos GROUP BY status`),
    segments: one(`SELECT COUNT(*) n FROM segments`).n,
    embedded: one(`SELECT COUNT(*) n FROM segments WHERE embedding IS NOT NULL`).n,
    depth: all(`SELECT depth, COUNT(*) n FROM segments GROUP BY depth ORDER BY n DESC`),
    channels: one(`SELECT COUNT(DISTINCT channel) n FROM videos WHERE status='extracted'`).n,
    medianSegSec: one(`SELECT AVG(d) v FROM (
        SELECT (end_sec-start_sec) d FROM segments ORDER BY d
        LIMIT 2 - (SELECT COUNT(*) FROM segments) % 2
        OFFSET (SELECT (COUNT(*)-1)/2 FROM segments))`)?.v ?? 0,
    hoursIndexed: one(`SELECT COALESCE(SUM(end_sec-start_sec),0)/3600.0 h FROM segments`).h,
  };
}
