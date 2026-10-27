// The human list: <app-data>/deferred-asks.json, the panel's D-n records ({ version, next, records: [{ id, state, scope:
// { kind: 'group', parentChatId, groupIndex }, toolName, input, reason, reasonCode, askedAt }] }). The group keeps working
// while a D-n waits, so its status never shows it: 25.10 D-3 (a test run in a container) sat with the owner for 20 min
// and the watch said nothing. Owner 25.10: every D-n of a watched group outside deletion/merge/super-critical is a defect
// of the judge — DEFER hi, a row, the rule fixed at once (rejudge on restart clears the waiting record).
import fs from 'node:fs';
import path from 'node:path';
import { one } from '../../../watchdog/scripts/lib/core.mjs';
import { appDataOf, mtime, trim } from './common.mjs';

const sameSplit = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

export function scanDeferred(ctx, units) {
  const { o, s, emit } = ctx;
  const P = s.plugin;
  const f = path.join(appDataOf(o), 'deferred-asks.json');
  const t = mtime(f);
  ctx.cover.deferred = t ? 'read' : 'absent';
  if (!t || t === P.deferMtime) return;
  let records;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    records = Array.isArray(j) ? j : (j.records ?? []);
  } catch {
    return; // mid-write: next pass
  }
  P.deferMtime = t;
  P.deferSeen ??= {};
  const waiting = {};
  for (const r of records) {
    if (r.scope?.kind !== 'group' || r.state !== 'waiting') continue;
    const unit = units.find(([, u]) => sameSplit(u.group.parent, r.scope.parentChatId) && u.group.index === r.scope.groupIndex);
    if (!unit) continue;
    const [name] = unit;
    waiting[name] = (waiting[name] ?? 0) + 1;
    if (P.deferSeen[r.id]) continue;
    P.deferSeen[r.id] = r.askedAt ?? true;
    const command = typeof r.input?.command === 'string' ? r.input.command : JSON.stringify(r.input ?? {});
    emit(name, 'hi', 'DEFER', `${r.id} ${r.toolName} waits for the human (${r.reasonCode ?? r.reason ?? '?'}): ${one(command, 300)} — not a deletion/merge/super-critical step ⇒ judge defect: reproduce with groupDecision, fix the rule, restart (rejudge clears it)`);
  }
  P.deferWaiting = waiting;
  trim(P.deferSeen, 200);
}

export const deferredCover = (P, state) =>
  state === 'absent' ? '✓ none yet' : !state ? '✗ unread' : `✓ ${Object.values(P.deferWaiting ?? {}).reduce((a, b) => a + b, 0)} waiting`;
