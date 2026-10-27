#!/usr/bin/env node
// kit-twins — the panel kit and the owner's personal layer (~/.claude) carry the SAME behaviours in two
// copies: hook modules (hooks/lib), situational rule cards, kit tools and skills. "Maintained in both"
// was a habit; this makes it a check. Ledger: apps/server/assets/kit/twins.json.
//
//   pair       a file on both sides. `same: true` = the two must stay byte-equal (EOL ignored);
//              otherwise a deliberate port (de-branded, kit paths) — both fingerprints are recorded and
//              a change on EITHER side is red until the other side got the change and the pair is
//              re-accepted. That is the whole enforcement: nobody edits one copy and forgets the other.
//   kitOnly / globalOnly   a file that exists on one side on purpose, each with its reason.
//   rename     per root, kit name -> global name, for a pair whose two copies are named differently.
//   globalPrivate  per root, {pattern, why}: global-only files matched by it are the owner's private
//              cards (company projects) — accepted unlisted, so this public ledger never names them.
//   wiring     a shared module must also be WIRED on both sides: the kit manifest and hooks.json
//              matcher, the personal dispatcher and the settings.json matcher. settings.json is the
//              owner's to change (agents may not), so a missing tool there is a WARNING naming the
//              script that fixes it, never red.
//
// Red (exit 1): a fingerprint moved, a `same` pair differs, a file on a strict root is not in the
// ledger, a ledger entry is stale. The personal side is skipped when absent (CI, another machine):
// the kit side is still checked against its recorded fingerprints.
//
//   node tools/kit-twins.mjs                     check (global dir: --global, KIT_TWINS_GLOBAL, CLAUDE_CONFIG_DIR, ~/.claude)
//   node tools/kit-twins.mjs --accept <key>      re-record one pair after porting the change (key as printed)
//   node tools/kit-twins.mjs --accept-all        re-record every pair (only after reading every diff)
//   node tools/kit-twins.mjs --init              add unlisted files with the root's default reason
//   --json                                       machine output
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KIT_ASSETS = join(REPO, 'apps', 'server', 'assets', 'kit');
export const LEDGER = join(KIT_ASSETS, 'twins.json');

export const fingerprint = (text) =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

function listRel(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRel(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

const filesOf = (dir, pattern) =>
  new Set(listRel(dir).filter((rel) => new RegExp(pattern).test(rel)));
const readOr = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/**
 * A root may pair files under different names (`rename`: kit name -> global name), e.g. a de-branded rule
 * card. The global side is listed under the KIT name so both sides meet on one key.
 */
const globalName = (root, rel) => root.rename?.[rel] ?? rel;
const isPrivate = (root, rel) =>
  Boolean(root.globalPrivate) && new RegExp(root.globalPrivate.pattern).test(rel);
function globalFilesOf(root, globalRoot) {
  if (!globalRoot) return new Set();
  const back = Object.fromEntries(Object.entries(root.rename ?? {}).map(([k, g]) => [g, k]));
  return new Set([...filesOf(globalRoot, root.pattern)].map((rel) => back[rel] ?? rel));
}

/** The global layer, or null when this machine has none (no hooks/lib there). */
export function globalDirOf(argv = [], env = process.env) {
  const i = argv.indexOf('--global');
  const dir =
    (i >= 0 && argv[i + 1]) ||
    env.KIT_TWINS_GLOBAL ||
    env.CLAUDE_CONFIG_DIR ||
    join(homedir(), '.claude');
  return existsSync(join(dir, 'hooks', 'lib')) ? dir : null;
}

/** Anchored, like the CLI reads a hooks matcher against a tool name. */
const matcherHits = (matcher, tool) => {
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
};

function dispatcherMatcher(groups, needle) {
  for (const group of groups ?? []) {
    if ((group.hooks ?? []).some((h) => needle.test(String(h.command ?? ''))))
      return group.matcher ?? '';
  }
  return null;
}

/**
 * The whole verdict: `problems` (red) and `warnings` (owner action), both lists of {key, text}.
 * Pure over the directories it is given, so a test runs it on a fixture.
 */
export function checkTwins({ kitAssets = KIT_ASSETS, globalDir = null, ledger }) {
  const problems = [];
  const warnings = [];
  const red = (key, text) => problems.push({ key, text });
  const seen = new Set();
  for (const root of ledger.roots) {
    const kitRoot = join(kitAssets, root.kit);
    const globalRoot = globalDir ? join(globalDir, root.global) : null;
    const kitFiles = filesOf(kitRoot, root.pattern);
    const globalFiles = globalFilesOf(root, globalRoot);
    const keyOf = (rel) => `${root.id}:${rel}`;
    for (const rel of new Set([...kitFiles, ...globalFiles])) {
      const key = keyOf(rel);
      seen.add(key);
      const pair = ledger.pairs[key];
      const inKit = kitFiles.has(rel);
      const inGlobal = globalFiles.has(rel);
      if (pair) continue; // judged below
      if (inGlobal && !inKit && isPrivate(root, rel)) continue;
      if (inKit && inGlobal)
        red(
          key,
          'on both sides but not in the ledger: add it as a pair (--init), port or mark same',
        );
      else if (inKit && !(key in ledger.kitOnly) && root.strict)
        red(key, 'kit-only file not in the ledger: say why in kitOnly (--init)');
      else if (inGlobal && !(key in ledger.globalOnly) && root.strict)
        red(key, 'global-only file not in the ledger: say why in globalOnly (--init)');
      else if (inKit && globalDir && key in ledger.globalOnly)
        red(key, 'listed globalOnly but the kit has it now');
      else if (inGlobal && key in ledger.kitOnly)
        red(key, 'listed kitOnly but the global layer has it now: make it a pair');
    }
    for (const [key, pair] of Object.entries(ledger.pairs)) {
      if (!key.startsWith(`${root.id}:`)) continue;
      const rel = key.slice(root.id.length + 1);
      const kitText = readOr(join(kitRoot, rel));
      if (kitText === null) {
        red(key, 'pair recorded but the kit file is gone: drop the pair or restore the file');
        continue;
      }
      if (fingerprint(kitText) !== pair.kit)
        red(
          key,
          `kit side changed (${pair.kit} → ${fingerprint(kitText)}): port the change to ${root.global}/${globalName(root, rel)}, then --accept ${key}`,
        );
      if (!globalRoot) continue;
      const globalText = readOr(join(globalRoot, globalName(root, rel)));
      if (globalText === null) {
        red(
          key,
          `pair recorded but ${root.global}/${globalName(root, rel)} is missing in the global layer`,
        );
        continue;
      }
      if (fingerprint(globalText) !== pair.global)
        red(
          key,
          `global side changed (${pair.global} → ${fingerprint(globalText)}): port the change to the kit copy, then --accept ${key}`,
        );
      if (pair.same && kitText.replace(/\r\n/g, '\n') !== globalText.replace(/\r\n/g, '\n'))
        red(key, 'marked same, but the two copies differ: copy one over the other');
    }
  }
  for (const list of ['kitOnly', 'globalOnly']) {
    for (const key of Object.keys(ledger[list])) {
      const root = ledger.roots.find((r) => key.startsWith(`${r.id}:`));
      if (!root) red(key, `${list} entry names no known root`);
      else if (!seen.has(key) && (list === 'kitOnly' || globalDir))
        red(key, `${list} entry is stale: the file is gone`);
    }
  }
  for (const wire of ledger.wiring ?? []) {
    const key = `wiring:${wire.module}`;
    const items = readOr(join(kitAssets, 'agentdeck-kit', 'hooks', 'lib', 'items.mjs')) ?? '';
    if (!items.includes(`'${wire.module}'`))
      red(key, `kit manifest (hooks/lib/items.mjs) does not run ${wire.module}`);
    const kitHooks = JSON.parse(
      readOr(join(kitAssets, 'agentdeck-kit', 'hooks', 'hooks.json')) ?? '{}',
    );
    const kitMatcher = dispatcherMatcher(
      kitHooks.hooks?.PreToolUse,
      /\/hooks\/lib\/run\.mjs"?\s+pre\b/,
    );
    for (const tool of wire.tools)
      if (kitMatcher === null || !matcherHits(kitMatcher, tool))
        red(key, `kit hooks.json PreToolUse matcher misses ${tool}`);
    if (!globalDir) continue;
    const dispatcher = readOr(join(globalDir, 'hooks', 'pre-tool-dispatch.mjs')) ?? '';
    if (!dispatcher.includes(`'${wire.module}'`))
      red(key, `global hooks/pre-tool-dispatch.mjs does not load ${wire.module}`);
    let settings = {};
    try {
      settings = JSON.parse(readOr(join(globalDir, 'settings.json')) ?? '{}');
    } catch {
      /* unreadable settings: reported below as a missing matcher */
    }
    const globalMatcher = dispatcherMatcher(settings.hooks?.PreToolUse, /pre-tool-dispatch\.mjs/);
    for (const tool of wire.tools)
      if (globalMatcher === null || !matcherHits(globalMatcher, tool))
        warnings.push({
          key,
          text: `settings.json PreToolUse matcher misses ${tool} — owner runs: ${wire.apply ?? 'see ledger'}`,
        });
  }
  return { problems, warnings };
}

/** --init / --accept: the ledger after recording. Never drops an entry. */
export function recordTwins({
  kitAssets = KIT_ASSETS,
  globalDir,
  ledger,
  accept = null,
  init = false,
}) {
  const next = structuredClone(ledger);
  for (const root of next.roots) {
    const kitRoot = join(kitAssets, root.kit);
    const globalRoot = globalDir ? join(globalDir, root.global) : null;
    const kitFiles = filesOf(kitRoot, root.pattern);
    const globalFiles = globalFilesOf(root, globalRoot);
    for (const rel of new Set([...kitFiles, ...globalFiles])) {
      const key = `${root.id}:${rel}`;
      const both = kitFiles.has(rel) && globalFiles.has(rel);
      const wanted = accept === '*' ? Boolean(next.pairs[key]) : accept === key;
      if ((init && both && !next.pairs[key]) || (wanted && both)) {
        const kitText = readFileSync(join(kitRoot, rel), 'utf8');
        const globalText = readFileSync(join(globalRoot, globalName(root, rel)), 'utf8');
        // A recorded `same` stays as the ledger says: accepting a `same` pair that now differs
        // keeps it red ("copy one over the other") instead of quietly turning it into a port.
        const existing = next.pairs[key];
        const same = existing ? existing.same : fingerprint(kitText) === fingerprint(globalText);
        next.pairs[key] = {
          ...(existing ?? {}),
          same,
          kit: fingerprint(kitText),
          global: fingerprint(globalText),
        };
      } else if (init && !both && kitFiles.has(rel) && root.strict && !(key in next.kitOnly)) {
        next.kitOnly[key] = root.kitOnlyWhy;
      } else if (
        init &&
        !both &&
        globalFiles.has(rel) &&
        root.strict &&
        !isPrivate(root, rel) &&
        !(key in next.globalOnly)
      ) {
        next.globalOnly[key] = root.globalOnlyWhy;
      }
    }
  }
  const sort = (obj) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  return {
    ...next,
    pairs: sort(next.pairs),
    kitOnly: sort(next.kitOnly),
    globalOnly: sort(next.globalOnly),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const globalDir = globalDirOf(argv);
  const at = argv.indexOf('--accept');
  const accept = argv.includes('--accept-all') ? '*' : at >= 0 ? argv[at + 1] : null;
  if (at >= 0 && !accept) {
    console.error('--accept needs a key, as the check prints it (e.g. hooks-lib:git-guard.mjs)');
    process.exit(2);
  }
  if (accept || argv.includes('--init')) {
    if (!globalDir) {
      console.error('no global layer here (hooks/lib missing): recording needs both sides');
      process.exit(2);
    }
    const next = recordTwins({ globalDir, ledger, accept, init: argv.includes('--init') });
    writeFileSync(LEDGER, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`ledger written: ${LEDGER}`);
  }
  const current = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const { problems, warnings } = checkTwins({ globalDir, ledger: current });
  if (argv.includes('--json'))
    console.log(JSON.stringify({ globalDir, problems, warnings }, null, 2));
  else {
    const pairs = Object.keys(current.pairs).length;
    console.log(`kit-twins: ${pairs} pairs, global layer ${globalDir ?? 'absent (kit side only)'}`);
    for (const p of problems) console.log(`RED   ${p.key} — ${p.text}`);
    for (const w of warnings) console.log(`WARN  ${w.key} — ${w.text}`);
    console.log(problems.length ? `${problems.length} drift problem(s)` : 'no drift');
  }
  process.exit(problems.length ? 1 : 0);
}
