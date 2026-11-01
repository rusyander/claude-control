import type { MutantPlanRow } from '@agentdeck/contracts/core/records';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readBaseEnv } from '../../platform/base-env.ts';
import { eolOf } from '../../platform/encoding.ts';
import { platformMutateIo } from './io.ts';
import { journalPlace, OwnJournal, settleJournals, type LiveForeign } from './journal.ts';
import {
  MutateRefusal,
  type MutantResult,
  type MutateIo,
  type RunPlanOptions,
  type TestRunContext,
  type TestRunOutcome,
  type TestRunner,
} from './mutate.types.ts';
import { vitestRunner } from './vitest-runner.ts';

/**
 * Прогон плана мутантов (G6, 04:72-74): на каждую строку — `find` ровно один раз, зелёный прогон
 * без мутации (тест реально прошёл, а не пропущен), подмена, тот же тест обязан упасть на своём
 * утверждении, файл возвращается байт в байт и проверяется чтением. Подмена — в рабочей копии под
 * журналом mustfail: пока прогон жив, `tools/mutation-guard.mjs` отказывает чужим наборам тестов.
 */

const WAIT_STEP_MS = 2_000;
// Разброс шага ожидания: два прогона, отступившие друг перед другом, не сталкиваются снова в такт.
const WAIT_JITTER_MS = 500;

/** Прогон этого процесса; `journal` пуст, пока дерево ещё не захвачено. */
interface Active {
  journal?: OwnJournal;
}
let active: Active | undefined;

/** Вернуть подменённые файлы прямо сейчас (обработчик сигнала CLI). Пусто — нечего возвращать. */
export function restoreActive(): string[] {
  const journal = active?.journal;
  active = undefined;
  if (!journal) return [];
  const stuck = journal.restoreAll();
  if (stuck.length === 0) journal.close();
  return stuck;
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function busy(foreign: LiveForeign): MutateRefusal {
  return new MutateRefusal(
    `mutate: другой прогон мутантов (pid ${foreign.pid}, начат ${foreign.started}) прямо сейчас подменяет файлы этого дерева — второй принял бы его мутанты за оригиналы. Дождитесь конца (--wait <сек>); если pid ${foreign.pid} не мутанты, удалите ${foreign.file}`,
  );
}

/**
 * Захват дерева: свой журнал ложится на диск ДО первого прогона, затем журналы сверяются ещё раз.
 * Два старта в одно мгновение: тот, кто после своей записи видит соседа, отступает и убирает свой
 * журнал — вдвоём не проходят никогда (поздняя сверка всегда видит раннюю запись).
 */
async function holdTree(
  io: MutateIo,
  options: RunPlanOptions,
  pid: number,
  log: (line: string) => void,
  slot: Active,
): Promise<OwnJournal> {
  const place = await journalPlace(io, options.root);
  const deadline = Date.now() + (options.waitMs ?? 0);
  const journal = new OwnJournal(
    io,
    place,
    pid,
    options.cmd ?? `agentdeck core mutate (pid ${pid})`,
  );
  slot.journal = journal;
  for (;;) {
    let foreign: LiveForeign | null = settleJournals(io, place, journal.self, log);
    if (foreign === null) {
      journal.open();
      foreign = settleJournals(io, place, journal.self, log);
      if (foreign === null) return journal;
      journal.close();
    }
    if (Date.now() >= deadline) throw busy(foreign);
    log(`mutate: дерево держит pid ${foreign.pid} — жду`);
    await delay(WAIT_STEP_MS + Math.floor(Math.random() * WAIT_JITTER_MS));
  }
}

function isGreen(run: TestRunOutcome): string | undefined {
  if (run.kind === 'not-run') return run.reason;
  if (run.fileErrors.length > 0) return `файл теста не собрался: ${run.fileErrors[0]}`;
  if (run.tests.length === 0) return 'тест с таким именем не найден (или пропущен)';
  const failed = run.tests.filter((t) => t.status === 'failed');
  if (failed.length > 0) return `красный без мутации: ${failed[0]?.path ?? ''}`;
  if (!run.tests.some((t) => t.status === 'passed')) return 'тест пропущен — ни одного прохода';
  return undefined;
}

function verdictOfMutant(run: TestRunOutcome): Pick<MutantResult, 'outcome' | 'detail'> {
  if (run.kind === 'not-run')
    return { outcome: 'survived', detail: `прогон с мутантом не состоялся: ${run.reason}` };
  const failed = run.tests.filter((t) => t.status === 'failed');
  if (failed.length > 0) return { outcome: 'killed', detail: `упал: ${failed[0]?.path ?? ''}` };
  if (run.fileErrors.length > 0)
    return {
      outcome: 'survived',
      detail: `не убит тестом: файл не собрался (${run.fileErrors[0] ?? ''}) — это не утверждение теста`,
    };
  return { outcome: 'survived', detail: `тест зелёный с мутантом (exit ${run.exit ?? '-'})` };
}

function absolute(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(join(root, path));
}

/**
 * Окружение детей-раннеров: основа — переданная или базовая платформы (не окружение ядра), плюс
 * MUSTFAIL_PID для mutation-guard и своя временная папка прогона. Папка — во временном каталоге
 * системы, НЕ под журналом в `.git`: тест, который заводит репозиторий в TEMP, внутри каталога
 * git получал отказ git («not a work tree») — красный без мутации, а не утверждение теста.
 */
function runnerEnv(
  io: MutateIo,
  base: NodeJS.ProcessEnv,
  pid: number,
): { env: NodeJS.ProcessEnv; temp: string } {
  const temp = join(tmpdir(), `agentdeck-mutate-${pid}-${Date.now().toString(36)}`);
  io.ensureDir(temp);
  return { env: { ...base, MUSTFAIL_PID: String(pid), TMPDIR: temp, TMP: temp, TEMP: temp }, temp };
}

export async function runPlan(
  rows: readonly MutantPlanRow[],
  options: RunPlanOptions,
): Promise<MutantResult[]> {
  // Занять слот процесса синхронно, до первого await: проверка → await → запись пропускала второй вызов.
  if (active) throw new MutateRefusal('mutate: прогон мутантов в этом процессе уже идёт');
  const slot: Active = {};
  active = slot;
  try {
    return await runHeld(rows, options, slot);
  } finally {
    if (active === slot) active = undefined;
  }
}

async function runHeld(
  rows: readonly MutantPlanRow[],
  options: RunPlanOptions,
  slot: Active,
): Promise<MutantResult[]> {
  const io = options.io ?? platformMutateIo();
  const runner: TestRunner = options.runner ?? vitestRunner();
  const log = options.progress ?? (() => undefined);
  const pid = options.pid ?? process.pid;
  let journal: OwnJournal;
  try {
    journal = await holdTree(io, options, pid, log, slot);
  } catch (error) {
    // Свой журнал уже на диске (повторная сверка отказала) — убрать; чужие копии не трогаются.
    slot.journal?.abandon();
    throw error;
  }
  const baselines = new Map<string, string | undefined>();
  const results: MutantResult[] = [];
  let failure: unknown;
  let temp: string | undefined;
  try {
    const own = runnerEnv(io, options.env ?? (await readBaseEnv({ temp: false })), pid);
    temp = own.temp;
    const ctx: TestRunContext = {
      root: options.root,
      scratchDir: journal.backups,
      env: own.env,
    };
    for (const [index, row] of rows.entries()) {
      const label = `#${index + 1} ${row.file} · ${row.test}`;
      const result = await runRow(row, { io, runner, ctx, journal, baselines });
      results.push(result);
      log(`[mutate] ${label}: ${result.outcome} — ${result.detail}`);
    }
  } catch (error) {
    failure = error;
  }
  // Временная папка прогона уходит с ним; не убралась — не повод терять возврат файлов.
  if (temp !== undefined) io.remove(temp);
  const stuck = journal.restoreAll();
  // Журнал остаётся: следующий старт (наш или mustfail) вернёт файлы по нему.
  if (stuck.length > 0) throw new MutateRefusal(`mutate: НЕ ВЕРНУЛИСЬ файлы: ${stuck.join(', ')}`);
  journal.close();
  if (failure !== undefined) throw failure;
  return results;
}

interface RowDeps {
  io: MutateIo;
  runner: TestRunner;
  ctx: TestRunContext;
  journal: OwnJournal;
  baselines: Map<string, string | undefined>;
}

/** План пишется с \n; в CRLF-файле многострочный `find` иначе не находится никогда (как у mustfail). */
function rowForEol(text: string, row: MutantPlanRow): { find: string; replace: string } {
  const { find, replace } = row;
  const eol = eolOf(text);
  if (text.includes(find) || !find.includes('\n') || eol === '\n') return { find, replace };
  return { find: find.replace(/\r?\n/g, eol), replace: replace.replace(/\r?\n/g, eol) };
}

async function runRow(row: MutantPlanRow, deps: RowDeps): Promise<MutantResult> {
  const { io, runner, ctx, journal } = deps;
  const full = absolute(ctx.root, row.file);
  if (!io.inside(journal.place.top, full))
    return { row, outcome: 'not-applied', detail: `${full} вне дерева ${journal.place.top}` };
  const read = io.readBytes(full);
  if (!('value' in read))
    return {
      row,
      outcome: 'not-applied',
      detail: 'absent' in read ? `файла ${full} нет` : `файл не читается: ${read.unknown}`,
    };
  const original = read.value;
  const text = original.toString('utf8');
  // Не UTF-8: мутант, собранный через строку, переписал бы и чужие байты файла.
  if (!Buffer.from(text, 'utf8').equals(original))
    return { row, outcome: 'not-applied', detail: 'файл не UTF-8 текст' };
  const { find, replace } = rowForEol(text, row);
  const hits = text.split(find).length - 1;
  if (hits !== 1)
    return { row, outcome: 'not-applied', detail: `find встречается ${hits} раз, нужно ровно 1` };
  const baseKey = `${row.spec}\u0000${row.test}`;
  if (!deps.baselines.has(baseKey))
    deps.baselines.set(baseKey, isGreen(await runner.run(row, ctx)));
  const notGreen = deps.baselines.get(baseKey);
  if (notGreen !== undefined) return { row, outcome: 'baseline-red', detail: notGreen };
  // База шла минуты: файл мог переписать кто-то ещё — его байты не «оригинал» под нашим журналом.
  const now = io.readBytes(full);
  if (!('value' in now) || !now.value.equals(original))
    return {
      row,
      outcome: 'not-applied',
      detail: `${full} изменился, пока шёл прогон без мутации — чужая запись в дереве, мутант не пишется`,
    };
  const mutated = Buffer.from(
    text.replace(find, () => replace),
    'utf8',
  );
  journal.track(full, original);
  journal.intend(full, mutated);
  io.writeBytes(full, mutated);
  let run: TestRunOutcome;
  try {
    run = await runner.run(row, ctx);
  } finally {
    io.writeBytes(full, original);
  }
  // Сверка возврата — после finally: брошенное оттуда съело бы исходную ошибку прогона.
  const back = io.readBytes(full);
  if (!('value' in back) || !back.value.equals(original))
    throw new MutateRefusal(`mutate: ${full} не вернулся к оригиналу после мутанта`);
  return { row, ...verdictOfMutant(run) };
}
