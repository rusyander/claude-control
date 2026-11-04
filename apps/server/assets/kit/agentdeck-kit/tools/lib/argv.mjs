// Windows caps a whole command line at 32,767 chars (CreateProcess): a pathspec list past it makes spawnSync
// fail with no stdout at all. A real 1494-file change: one `git diff -- <all>` crashed review-plan and would
// have left review-sweep with an empty diff. Long lists go in batches, outputs concatenated.

export const ARGV_CHARS = 24000;

/** Split `paths` into batches whose joined length (one separator per path) stays ≤ `budget`; [] → [[]]. */
export function pathBatches(paths, budget = ARGV_CHARS) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length && len + p.length + 1 > budget) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length + 1;
  }
  if (cur.length || !out.length) out.push(cur);
  return out;
}
