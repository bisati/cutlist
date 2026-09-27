// Load the index from SQLite, for local tools.
//
// The deployed app does NOT use this. It reads a static bundle instead, because
// the index is written once by an offline job and only ever read afterwards,
// which makes it a file rather than a database. See app/lib/bundle.mjs.

import { allSegments } from './store.mjs';

export function loadIndex(db) {
  return allSegments(db).filter((s) => s.vec && s.vecLabel);
}
