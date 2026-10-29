import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckEntry, CheckRegistry, CheckRequest } from '@agentdeck/contracts/core/records';
import { matchRequest, normaliseArgv, type Match } from '../../conductor/checks/index.ts';
import { CAPTURE_RUNNERS } from '../../platform/capture-shim.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { expandTemplate } from '../../verifier/run/argv.ts';

/**
 * Дорога `node-preload` видит argv уровня node (`node …/node_modules/vitest/vitest.mjs run`), а
 * реестр профиля знает команду менеджера пакетов (`pnpm run test`). Без перевода ни одна запись
 * реестра не совпадала, и прогон шёл производным `captured:` — запись профиля не повторялась на
 * этой дороге, а сужение посреди работы не наступало (A2-F01).
 *
 * Перевод строгий: скрипт `package.json` папки прогона, чьё тело — ровно имя бегуна и те же
 * аргументы (без цепочек, перенаправлений и кавычек оболочки), и ровно одна запись реестра в той же
 * папке, что гонит этот скрипт `[pm, 'run', s]` (или ярлыком менеджера). Иначе — производная
 * запись, как раньше: прогон идёт, ложного повтора нет. Записи единиц воркспейса (`unit:
 * 'package'`) гонятся из корня через фильтр менеджера, а бегун под ними — из папки единицы: это
 * другая команда, не переводится (названо).
 */

const PMS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Ярлыки npm без `run`; у bun `bun test` — свой бегун, не скрипт, поэтому ярлыков нет. */
const NPM_SHORT: ReadonlySet<string> = new Set(['test', 'start', 'stop', 'restart']);
/**
 * Тело скрипта — не одна команда: цепочка, перенаправление, подстановка, кавычки. Префикс
 * `NAME=…` отсекает сравнение слов: первое слово обязано быть именем бегуна.
 */
const NOT_PLAIN = /[&|;<>$`'"()]/;

/** Слова, которыми тот же прогон записан в скрипте пакета: `[бегун, ...аргументы]`. */
export function nodeRunWords(argv: readonly string[]): string[] | undefined {
  const main = argv[1];
  if (main === undefined) return undefined;
  const norm = main.replace(/\\/g, '/');
  const runner = CAPTURE_RUNNERS.find((r) => r.re.test(norm));
  return runner ? [runner.bin, ...argv.slice(2)] : undefined;
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Скрипты, чьё тело — ровно эти слова. */
export function scriptsRunning(
  scripts: Readonly<Record<string, string>>,
  words: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const [name, body] of Object.entries(scripts)) {
    if (NOT_PLAIN.test(body)) continue;
    if (same(body.trim().split(/\s+/), words)) out.add(name);
  }
  return out;
}

/** Имя скрипта, который запись гонит менеджером пакетов; не такая запись — `undefined`. */
function scriptOfEntry(entry: CheckEntry): string | undefined {
  if (entry.unit === 'package') return undefined;
  const words = normaliseArgv(
    expandTemplate(entry.argv, { unit: '.', selection: [], base: null, files: [] }),
  );
  const [pm, first, second, ...rest] = words;
  if (pm === undefined || !PMS.has(pm) || first === undefined || rest.length > 0) return undefined;
  if (first === 'run') return second;
  if (second !== undefined || first.startsWith('-')) return undefined;
  if (pm === 'pnpm' || pm === 'yarn') return first;
  return pm === 'npm' && NPM_SHORT.has(first) ? first : undefined;
}

/**
 * Запись реестра, которую гонит этот argv уровня node в папке `prefix`. Тот же скрипт обычно
 * гонят двое: найденная детектором (`js:test` — `npm run test`) и объявленная профилем; объявление
 * владельца старше находки. Не одна среди лучших — `undefined`.
 */
export function scriptEntry(
  registry: CheckRegistry,
  argv: readonly string[],
  scripts: Readonly<Record<string, string>>,
  prefix: string,
): CheckEntry | undefined {
  const words = nodeRunWords(argv);
  if (!words) return undefined;
  const names = scriptsRunning(scripts, words);
  if (names.size === 0) return undefined;
  const hits = registry.checks.filter((entry) => {
    const script = entry.cwd === prefix ? scriptOfEntry(entry) : undefined;
    return script !== undefined && names.has(script);
  });
  const declared = hits.filter((entry) => entry.source !== 'detected');
  const best = declared.length > 0 ? declared : hits;
  return best.length === 1 ? best[0] : undefined;
}

/**
 * Сопоставление захваченного прогона с реестром — общее у входа захвата и забора очереди: то же
 * `matchRequest`, а производный прогон дороги `node-preload` ещё раз — через скрипт пакета. Узнан —
 * запрос несёт `checkId` записи (вход судит по id, argv остаётся тем, что исполнено). Скрипты не
 * прочитаны — перевода нет, прогон идёт производным (сомнение → прогон, не повтор чужого).
 */
export function matchCaptured(
  req: CheckRequest,
  registry: CheckRegistry,
  where: { cwd: string; prefix: string },
  scripts: (dir: string) => Fact<Record<string, string>> = readScripts,
): { req: CheckRequest; match: Match; viaScript: boolean } {
  const match = matchRequest(req, registry);
  const own = { req, match, viaScript: false };
  if (match.kind !== 'derived' || req.road !== 'capture-preload') return own;
  const read = scripts(where.cwd);
  if (!('value' in read)) return own;
  const entry = scriptEntry(registry, req.argv ?? [], read.value, where.prefix);
  if (!entry) return own;
  const named: CheckRequest = { ...req, checkId: entry.id };
  return { req: named, match: matchRequest(named, registry), viaScript: true };
}

/** Скрипты `package.json` папки; файла нет — пусто, не прочитан или не JSON — `unknown`. */
export function readScripts(dir: string): Fact<Record<string, string>> {
  const bytes = readBytesSync(join(dir, 'package.json'));
  if ('absent' in bytes) return { value: {} };
  if ('unknown' in bytes) return bytes;
  try {
    const doc = JSON.parse(bytes.value.toString('utf8')) as { scripts?: unknown };
    const scripts = doc.scripts;
    if (!scripts || typeof scripts !== 'object') return { value: {} };
    const out: Record<string, string> = {};
    for (const [name, body] of Object.entries(scripts))
      if (typeof body === 'string') out[name] = body;
    return { value: out };
  } catch (error) {
    return { unknown: `package.json in ${dir}: ${(error as Error).message}` };
  }
}
