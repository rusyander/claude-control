// P6 (27.10): the panel's own group watcher raises the findings these detectors raise. A flag of ours and the
// panel's WSIG of its rule, for the same group in the same call, are one finding told twice: our text rides on the
// WSIG line, our flag leaves the digest and owes no row (run.mjs drops `folded`), and its waste still arms the pause
// — citing the WSIG (lib/pauses.mjs). No WSIG of that rule in this call (watcher down after a restart, rule off, the
// signal raised in an earlier call) → our flag stands alone: the detector stays as the fallback.
import { one } from '../../../watchdog/scripts/lib/core.mjs';

/** Our flag → the panel rule that raises the same finding. */
export const PANEL_RULE = { RERUN: 'R4', WINDOW: 'R9', SLOW: 'R16', BRIEF: 'R37', RESTART: 'R38', STORM: 'R39', LEDGER: 'R40', GAP: 'R41', RUN: 'R42' };

/** Fold this call's flags into its WSIG lines; an arm already taken by a folded flag is re-cited to its WSIG. */
export function foldPanel(ctx) {
  const { w, s } = ctx;
  const wsig = w.events.filter((e) => e.tag === 'WSIG' && e.rule);
  if (!wsig.length) return;
  for (const e of w.events) {
    const rule = PANEL_RULE[e.tag];
    // Only a finding folds: a plain mid line (a run that was not heavy, a restart cleared) is news of its own.
    if (!rule || e.folded || (!e.waste && e.sev !== 'hi')) continue;
    // A panel-wide flag (STORM, WINDOW, a restart nobody's edits caused) is the panel's signal of any watched group.
    const into = wsig.find((x) => x.rule === rule && (e.unit === '—' || x.unit === e.unit));
    if (!into) continue;
    e.folded = into;
    into.text += ` · +${e.tag}: ${one(e.text, 160)}`;
    if (e.sev === 'hi') into.sev = 'hi';
    if (e.waste && !into.waste) into.waste = e.waste;
    for (const a of Object.values(s.plugin?.armed ?? {})) {
      if (a.ref !== e.ref) continue;
      a.ref = into.ref;
      a.why = `WSIG ${rule}${e.waste ? ` ${e.waste}` : ''}`;
    }
  }
}
