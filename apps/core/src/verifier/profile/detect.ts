import { createHash } from 'node:crypto';
import type { CheckRegistry } from '@agentdeck/contracts/core/records';
import type { RepoView } from '../../platform/repo-view.types.ts';
import { ciSet, genericFromCi, scanCi, type CiDropped } from './ci.ts';
import { detectGitHooks } from './hooks.ts';
import { detectJs } from './js.ts';
import {
  detectDotnet,
  detectGo,
  detectJvm,
  detectMake,
  detectPython,
  detectRust,
} from './langs.ts';
import { applyProjectFile, PROJECT_FILE } from './project-file.ts';
import type {
  DetectContext,
  DetectedCheck,
  DetectedProfile,
  StackFinding,
} from './profile.types.ts';
import { detectRecipes } from './recipes.ts';
import { detectRuntimes } from './runtimes.ts';
import { ViewIndex } from './view.ts';

/**
 * Профиль из вида репозитория (04:45-52, 04:88-91, 04:121-123) — чистая функция: тот же вид —
 * тот же профиль, на любой ОС кроме названного (каталог venv). Набор публикации: есть CI — то,
 * что он гоняет (04:48); CI нет — тесты и статические проверки (сборка и e2e — нет). Неизвестный
 * стек — `generic`, назван, проверки — из CI и Makefile.
 */

/**
 * Версия обнаружения: новая логика — новый отпечаток, профиль переобнаруживается сам.
 * 3 — узкий прогон члена воркспейса идёт селектором пакета (A2r3-Q03).
 * 4 — фильтр члена несёт `filesFrom: 'unit'`: `{files}` переводятся от каталога единицы.
 */
export const DETECT_VERSION = 4;

/** Сколько команд назвать в одной заметке: дальше — счёт. */
const NAMED_COMMANDS = 10;

/** Отброшенные команды CI → заметка на файл и причину, команды по имени. */
function droppedNotes(dropped: readonly CiDropped[]): DetectedProfile['notes'] {
  const groups = new Map<string, { file: string; why: string; commands: string[] }>();
  for (const d of dropped) {
    const k = `${d.file}\0${d.why}`;
    const g = groups.get(k) ?? { file: d.file, why: d.why, commands: [] };
    if (!g.commands.includes(d.command)) g.commands.push(d.command);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => {
    const shown = g.commands
      .slice(0, NAMED_COMMANDS)
      .map((c) => (c.length > 120 ? `${c.slice(0, 117)}...` : c));
    const more = g.commands.length - shown.length;
    return {
      subject: g.file,
      why: `${g.why}: ${shown.join('; ')}${more > 0 ? `; +${more} more` : ''}`,
    };
  });
}

export function inputsFingerprint(view: RepoView): string {
  const h = createHash('sha256');
  h.update(`detect-v${DETECT_VERSION}\n`);
  for (const f of [...view.files].sort((a, b) => (a.path < b.path ? -1 : 1)))
    h.update(`${f.path}\0${f.sha}\n`);
  h.update(view.truncated ? 'truncated\n' : 'whole\n');
  return h.digest('hex');
}

export function detectProfile(view: RepoView, ctx: DetectContext): DetectedProfile {
  const idx = new ViewIndex(view);
  const js = detectJs(idx);
  const parts: StackFinding[] = [
    js,
    detectGo(idx),
    detectPython(idx, ctx),
    detectJvm(idx, ctx),
    detectDotnet(idx),
    detectRust(idx),
  ];
  const make = detectMake(idx);
  const stacks = parts.flatMap((p) => p.stacks);
  const notes = [...parts.flatMap((p) => p.notes)];
  const checks: DetectedCheck[] = [...parts.flatMap((p) => p.checks), ...make.checks];
  const scan = scanCi(idx);
  const ci = ciSet(checks, scan);
  const ciIds = new Set(ci.ids);
  if (stacks.length === 0)
    stacks.push({
      stack: 'generic',
      root: '',
      named: 'no known stack: checks come from CI config and Makefile',
    });
  // Команда CI без своей проверки — при любом стеке: проверка `ci:` или названный отказ, молча
  // набор публикации не сужается (04:48).
  const generic = genericFromCi(ci.unmatched);
  for (const g of generic.checks) {
    checks.push(g);
    ciIds.add(g.entry.id);
  }
  notes.push(...droppedNotes([...scan.dropped, ...generic.dropped]));
  // CI есть, но ни одна его команда не легла на проверку (`make ci`, свой скрипт) — пустой набор
  // публикации был бы расширением: правило «без CI» и названная причина.
  const hasCi = scan.files.length > 0 && ciIds.size > 0;
  if (scan.files.length > 0 && !hasCi)
    notes.push({
      subject: scan.files.join(', '),
      why: 'no CI command maps to a detected check: publish set = tests + static checks',
    });
  for (const c of checks) {
    const required = hasCi ? ciIds.has(c.entry.id) : c.role === 'test' || c.role === 'static';
    c.entry.requiredAt = required ? ['publish'] : [];
  }
  for (const u of scan.unparsed)
    notes.push({
      subject: u.file,
      why: `${u.count} CI command(s) are shell strings (pipes, substitution, globs, sh -c): not mapped to checks`,
    });
  if (view.truncated)
    notes.push({
      subject: '.',
      why: 'repository walk hit its entry budget: deeper inputs not seen',
    });
  for (const p of view.overCap)
    notes.push({ subject: p, why: 'input over the size cap: not parsed' });
  const recipes = detectRecipes(idx);
  notes.push(...recipes.notes);
  const units: CheckRegistry['units'] = {};
  for (const p of parts) Object.assign(units, p.units);
  const machinery = [
    ...new Set([
      ...parts.flatMap((p) => p.machinery),
      ...make.machinery,
      ...(idx.has(PROJECT_FILE) ? [PROJECT_FILE] : []),
    ]),
  ].sort();
  const detected: CheckRegistry = {
    units,
    machinery,
    checks: checks.map((c) => c.entry),
    rejected: [],
  };
  const registry = applyProjectFile(detected, idx.text(PROJECT_FILE));
  return {
    stacks,
    packageManager: js.packageManager,
    runtimes: detectRuntimes(idx, stacks, js.packageManager),
    pathEntries: [...new Set(parts.flatMap((p) => p.pathEntries))],
    envNames: recipes.envNames,
    serviceVars: recipes.serviceVars,
    serviceRecipes: recipes.recipes,
    registry,
    ciChecks: [...ciIds].sort(),
    gitHooks: detectGitHooks(idx),
    notes,
  };
}
