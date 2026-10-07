/**
 * acceptance — the acceptance table of a live run (skill `agentdeck-kit:ticket-delivery` §10).
 *
 * Why. «Verified» without a table rests on the agent's word. Here every statement from the plan
 * becomes a row, a row carries an expectation and a fact taken off the running system, and the
 * output is a ready markdown table that goes into the MR and the QA comment unrewritten. What did
 * not reach the table was not verified, and that is visible to everyone, the agent included.
 *
 * The negative case is not decoration: `expectFail` records that broken input got the RIGHT refusal
 * rather than silent acceptance. A run without a single negative row is marked incomplete.
 *
 * Depth is COMPUTED. The table asks `<kit>/tools/risk-tier.mjs --json` for the tier and the
 * radius of the change, and demands accordingly:
 *   · T2 — at least two variations (`variation`): one request delayed, a role without the write
 *     right, empty/limit, bad input. The happy path is green by construction; defects live beside it;
 *   · T1 and T2 — a positive pass (`walked`) over EVERY entry point of the radius within the cap:
 *     a shared function is checked on all the screens it reaches, not on the ticket's screen alone.
 *     The cap (T1 — 3, T2 — 6) is the time budget; entries over it are printed «NOT WALKED» by
 *     name rather than lost silently.
 * The tier can be passed explicitly — the table then says «set by the caller». Not computed is also
 * said out loud, and only the base requirements apply: unknown is never shown as T0.
 *
 * An expectation is a string (compared trimmed), a regular expression or a predicate. The fact is
 * taken by the caller — from the DOM, from an API response, from anywhere.
 *
 *   import { pathToFileURL } from 'node:url';
 *   const { suite } = await import(pathToFileURL('<kit>/tools/acceptance.mjs').href);
 *
 *   const t = suite('PROJ-123 — send a message to the agent');   // tier and radius from risk-tier
 *   t.check('button enabled after typing', true, await btn.isEnabled());
 *   t.expectFail('empty message', /required/i, await errorText());
 *   t.variation('delay /agents +1500 ms', 'skeleton', await stateName());
 *   for (const e of t.entries) { … t.walked(e.label, 'screen opens with data', true, await ok()); }
 *   process.exit(t.report());
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root: the git top level of the cwd, else the cwd. risk-tier is run from there. */
function projectRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const top = r.status === 0 ? String(r.stdout || '').trim() : '';
  return top || process.cwd();
}

const ROOT = projectRoot();
const ICON = { ok: '✓', fail: '✗' };
const MARK = { negative: '⊘ ', variation: '≈ ', walked: '→ ' };
const DEFAULT_CAP = { T1: 3, T2: 6 };
const VARIATIONS_AT_T2 = 2;

function matches(expected, actual) {
  if (expected instanceof RegExp) return expected.test(String(actual));
  if (typeof expected === 'function') return Boolean(expected(actual));
  if (typeof expected === 'boolean' || typeof expected === 'number') return expected === actual;
  return String(expected).trim() === String(actual).trim();
}

function show(value) {
  if (value instanceof RegExp) return value.toString();
  if (typeof value === 'function') return '(predicate)';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || '(empty)';
}

/** Tier and radius: from the options, else from risk-tier. `source` reaches the table verbatim. */
function resolveDepth(opts) {
  const norm = (list) =>
    (list ?? []).map((e) =>
      typeof e === 'string'
        ? { label: e, file: '' }
        : { label: String(e.label ?? e.file ?? ''), file: String(e.file ?? '') },
    );
  const fromJson = (json, source) => ({
    tier: json.tier ?? null,
    entries: norm(json.radius?.entries),
    cap: opts.cap ?? json.caps?.entries ?? DEFAULT_CAP[json.tier] ?? 0,
    source,
  });
  if (opts.riskTier) return fromJson(opts.riskTier, 'computed by risk-tier.mjs');
  if (opts.tier)
    return {
      tier: opts.tier,
      entries: norm(opts.entries),
      cap: opts.cap ?? DEFAULT_CAP[opts.tier] ?? 0,
      source: 'set by the caller',
    };

  const tool =
    process.env.RISK_TIER_TOOL || join(dirname(fileURLToPath(import.meta.url)), 'risk-tier.mjs');
  const run = spawnSync(process.execPath, [tool, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  try {
    const json = JSON.parse(run.stdout);
    if (!/^T[0-2]$/.test(String(json.tier))) throw new Error('no tier in the output');
    return fromJson(json, 'computed by risk-tier.mjs');
  } catch {
    const why = run.error?.code ?? (run.status ? `exit ${run.status}` : 'output not parsed');
    return { tier: null, entries: [], cap: 0, source: `tier not computed (risk-tier: ${why})` };
  }
}

export function suite(title, opts = {}) {
  const rows = [];
  const depth = resolveDepth(opts);
  const owed = depth.tier === 'T1' || depth.tier === 'T2' ? depth.entries.slice(0, depth.cap) : [];
  const overCap = depth.tier === 'T1' || depth.tier === 'T2' ? depth.entries.slice(depth.cap) : [];

  const add = (kind, what, expected, actual, extra = {}) => {
    const ok = matches(expected, actual);
    rows.push({ kind, what, expected, actual, ok, ...extra });
    return ok;
  };

  /** An entry point by reference: an exact name or path, else a unique substring match. */
  const findEntry = (ref) => {
    const needle = String(ref ?? '').trim();
    if (!needle) return { entry: null, why: 'entry point not named' };
    const exact = depth.entries.filter((e) => e.label === needle || e.file === needle);
    if (exact.length === 1) return { entry: exact[0] };
    const low = needle.toLowerCase();
    const loose = depth.entries.filter(
      (e) => e.label.toLowerCase().includes(low) || e.file.toLowerCase().includes(low),
    );
    if (loose.length === 1) return { entry: loose[0] };
    return {
      entry: null,
      why: loose.length
        ? `ambiguous: matches ${loose.length} entry points`
        : 'entry point is not in the radius',
    };
  };

  return {
    /** Tier of the change (`T0|T1|T2|null`) — a scenario may pick its variations by it. */
    tier: depth.tier,
    /** Entry points of the radius owed a pass, within the cap. */
    entries: owed.map((e) => ({ ...e })),

    /** Positive check: this is how it must work. */
    check: (what, expected, actual) => add('positive', what, expected, actual),
    /** Negative: broken input must get a clear refusal. */
    expectFail: (what, expected, actual) => add('negative', what, expected, actual),
    /** A variation one step off the happy path: a delayed request, a role, empty/limit, bad input. */
    variation: (what, expected, actual) => add('variation', what, expected, actual),
    /** A positive pass over a radius entry point: the screen the change reaches is alive and has data. */
    walked: (entryRef, what, expected, actual) => {
      const { entry, why } = findEntry(entryRef);
      return add('walked', `${entry ? entry.label : entryRef}: ${what}`, expected, actual, {
        entry,
        stray: entry ? null : why,
        ref: entryRef,
      });
    },

    /**
     * Prints the table and returns the exit code. Zero when everything matched AND the run is
     * complete: a negative row exists, at T2 two variations, a pass per entry point under the cap.
     * An incomplete run is red on purpose: it is silent about exactly the place where the defects
     * that reach QA live.
     */
    report() {
      const failed = rows.filter((r) => !r.ok);
      const negatives = rows.filter((r) => r.kind === 'negative');
      const variations = rows.filter((r) => r.kind === 'variation');
      const walkedLabels = new Set(
        rows.filter((r) => r.kind === 'walked' && r.entry).map((r) => r.entry.label),
      );
      const notWalked = owed.filter((e) => !walkedLabels.has(e.label));
      const strays = rows.filter((r) => r.kind === 'walked' && r.stray);

      const lines = [
        '',
        `## Acceptance — ${title}`,
        '',
        depth.tier
          ? `Tier: ${depth.tier} — ${depth.source}` +
            (depth.entries.length
              ? ` · entry points in radius ${depth.entries.length}, cap ${depth.cap}`
              : '')
          : `Tier: ${depth.source} — only the base requirements apply`,
        '',
        '| # | Check | Expected | Actual | Result |',
        '|---|-------|----------|--------|--------|',
        ...rows.map(
          (r, i) =>
            `| ${i + 1} | ${MARK[r.kind] ?? ''}${r.what} | ${show(r.expected)} | ` +
            `${show(r.actual)} | ${r.ok ? ICON.ok : ICON.fail} |`,
        ),
        '',
      ];

      const incomplete = [];
      if (negatives.length === 0)
        incomplete.push('no negative check — the run says nothing about bad input.');
      if (depth.tier === 'T2' && variations.length < VARIATIONS_AT_T2) {
        incomplete.push(
          `tier T2 needs ${VARIATIONS_AT_T2} variations (t.variation: one request delayed · a role without write access · ` +
            `empty/limit · bad input), recorded ${variations.length}.`,
        );
      }
      if (notWalked.length) {
        incomplete.push(
          `radius entry points without a pass (t.walked) — ${notWalked.length}: ${notWalked.map((e) => e.label).join('; ')}.`,
        );
      }
      for (const text of incomplete) lines.push(`INCOMPLETE: ${text}`);
      for (const r of strays) lines.push(`NOT COUNTED as a radius pass: «${r.ref}» — ${r.stray}.`);
      if (overCap.length)
        lines.push(
          `NOT WALKED — over the cap ${depth.cap}: ${overCap.map((e) => e.label).join('; ')}.`,
        );
      if (incomplete.length || strays.length || overCap.length) lines.push('');

      lines.push(
        `ACCEPTANCE: ${rows.length - failed.length}/${rows.length}` +
          `${failed.length ? ` · failed ${failed.length}` : ''}` +
          ` · negative ${negatives.length}` +
          (depth.tier === 'T2' ? ` · variations ${variations.length}` : '') +
          (owed.length ? ` · entry points ${owed.length - notWalked.length}/${owed.length}` : ''),
        '',
      );

      process.stdout.write(lines.join('\n'));
      return failed.length === 0 && incomplete.length === 0 ? 0 : 1;
    },
  };
}
