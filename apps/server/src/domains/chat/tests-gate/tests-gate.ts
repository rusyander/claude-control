import type {
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { casesTouching, readGroups, readRuns } from '../../project-tests/project-tests.ts';
import { redOf } from '../../project-tests/red-verdict/red-verdict.ts';
import { currentStamps, freshResult } from '../../project-tests/content-stamp/content-stamp.ts';
import { run as git, touchedPaths } from '../../project-git/sieve-facts/sieve-facts.ts';

/**
 * Группа разделения проверяет свою работу через блок «Тесты» (решение
 * владельца 29.09): вердикт — из кейсов и записанных прогонов блока в её
 * копии, а не из её слов. Так же agentdeck проверяет себя: кейс привязан к
 * файлу, прогон записан в историю, и «проверено» — это запись, а не ответ.
 *
 * Что требуется перед «доставлено»:
 * - задетые диффом группы кейсы находятся по `codePaths` (или зоне);
 * - автоматические среди них прогнаны прогоном, записанным ПОСЛЕ старта
 *   группы и свежим для кейса (Ф23): содержимое его `codePaths` и автотеста то
 *   же, что видел прогон (`content-stamp`); у записи без отпечатка — прогон
 *   после последней правки кода. Последний их результат не красный (карантин
 *   не держит);
 * - красный кейс любого прогона группы — тоже пробел, даже не задетый диффом;
 * - проект, где кейсы привязаны к файлам, но дифф группы не покрыт ни одним, —
 *   пробел «заведите кейс».
 *
 * Блока «Тесты» в копии нет вовсе (ни одного кейса) — проверять нечем:
 * проект им не пользуется, и группу это не держит.
 */

export interface GroupTestsVerdict {
  /** Автоматических кейсов, задетых диффом группы. */
  cases: number;
  /** Из них зелёных в последнем прогоне группы. */
  passed: number;
  /** Последний прогон группы в блоке. */
  runId?: string;
  runAt?: string;
}

export interface TestsDeliveryGaps {
  missing: string[];
  verdict?: GroupTestsVerdict;
  /** Почему не проверено (блока нет) — в журнал, не в пробелы. */
  unchecked?: string;
  /**
   * Красное не из-за ветки (см. `redNotFromBranch`): заметка на карточку и в
   * описание MR, а не пробел.
   */
  notes?: string[];
  /** Кейсы этих заметок — описание MR должно назвать каждый. */
  noted?: string[];
}

/** Сколько кейсов назвать по имени: дальше — числом. */
const NAMED = 5;

const RED: readonly ProjectTestStatus[] = ['failed', 'blocked'];

function named(ids: readonly string[]): string {
  const head = ids.slice(0, NAMED).join(', ');
  return ids.length > NAMED ? `${head} (+${ids.length - NAMED})` : head;
}

/** Длиннее — список кейсов не влезет в строку оболочки: команда без выбора. */
const NARROW_LIMIT = 2000;

/**
 * Команда записи прогона, суженная до кейсов изменённых файлов (L7.3 плана
 * экономии групп): без `--case` группа гоняла ВСЕ кейсы копии — 128 с там,
 * где хватало секунд, — потому что другой команды пробел не называл.
 */
export function narrowedCommand(command: string, keys: readonly string[]): string {
  if (keys.length === 0) return command;
  const narrowed = `${command} --case ${keys.join(',')}`;
  return narrowed.length > NARROW_LIMIT ? command : narrowed;
}

interface LatestResult {
  status: ProjectTestStatus;
  runId: string;
  result: ProjectTestPointResult;
  run: ProjectTestRunRecord;
}

/**
 * Последний результат кейса по прогонам группы (новые первыми). Прогон
 * записан раньше старта группы — не её прогон, а чужой, и не в счёт.
 */
function latestResults(
  runs: readonly ProjectTestRunRecord[],
  counts: (run: ProjectTestRunRecord, key: string) => boolean = () => true,
): Map<string, LatestResult> {
  const latest = new Map<string, LatestResult>();
  for (const run of runs) {
    for (const result of run.results) {
      const key = `${result.groupId}:${result.caseId}`;
      if (!latest.has(key) && counts(run, key)) {
        latest.set(key, { status: result.status, runId: run.id, result, run });
      }
    }
  }
  return latest;
}

/**
 * Признаки красного от окружения, а не от кода: таймаут, сеть, стенд,
 * занятый/запертый файл (Windows), браузер не поднялся, «только на <ОС>»,
 * прогон снят по пределу `tests-cli run` («Предел времени: прогон шёл…»).
 * Кириллица — без `\b`: в JS граница слова видит только латиницу.
 */
const ENVIRONMENT_RED =
  /\b(time[ -]?out|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|EADDRINUSE|EBUSY|EPERM|net::ERR_[A-Z_]+|browserType\.launch|Executable doesn't exist|(windows|win32|linux|macos|darwin)[- ]only|only on (windows|win32|linux|macos|darwin))\b|таймаут|тайм-аут|превышено время|истекло время|предел времени|стенд (не поднят|недоступен|не отвечает|лежит)|только на (windows|linux|macos)/i;

/** Пути сравниваются в одном виде: прямая черта, без `./` и хвостовой черты. */
function normalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export type RedCause = 'baseline' | 'environment';

/**
 * Правило «красное не из-за ветки» (решение владельца 23.10: группа идёт до
 * готового MR сама, держит её только то, что сломала она). Красный кейс НЕ
 * держит доставку, если дифф ветки не задел ни его `codePaths`/зону, ни файл
 * его автотеста, И при этом:
 * - `baseline` — он был красным уже до старта группы (последний результат в
 *   прогонах, записанных раньше `startedAt`, — то есть на основной ветке);
 * - `environment` — он красный от окружения: `blocked` (не смог выполниться),
 *   таймаут, сеть, «только на Windows» и т. п. (`ENVIRONMENT_RED`).
 * Задетый диффом красный кейс держит всегда, какой бы ни была причина: ветка
 * могла сломать его сама. Незадетый без истории и без признаков окружения —
 * тоже держит: доказать, что он не её, нечем. Кейс без `codePaths` окружением
 * не снимается вовсе (F-43): какой код он проверяет, не записано, и «timed
 * out» мог дать повисший код самой ветки.
 */
export function redNotFromBranch(input: {
  groups: readonly ProjectTestGroup[];
  runs: readonly ProjectTestRunRecord[];
  paths: readonly string[];
  startedAt?: string;
}): (latest: {
  result: ProjectTestPointResult;
  run: ProjectTestRunRecord;
}) => RedCause | undefined {
  const live = input.groups.filter((group) => !group.error);
  const touched = new Set(
    casesTouching(input.paths, [...live]).cases.map((item) => `${item.groupId}:${item.caseId}`),
  );
  const files = input.paths.map(normalPath);
  const cases = new Map<string, ProjectTestGroup['cases'][number]>(
    live.flatMap((group) => group.cases.map((item) => [`${group.id}:${item.id}`, item] as const)),
  );
  const since = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  // До старта группы — то, что было на основной: группа к этим прогонам непричастна.
  const before = Number.isFinite(since)
    ? latestResults(
        input.runs
          .filter((run) => run.status !== 'running' && Date.parse(run.startedAt) < since)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
      )
    : new Map<string, LatestResult>();
  return ({ result, run }) => {
    const key = `${result.groupId}:${result.caseId}`;
    // `blocked` — кейс не смог выполниться (стенда нет, браузер не поднялся):
    // вердикта о коде нет, и держать доставку нечем — заметка в MR, даже если
    // дифф задел кейс (решение владельца 23.10, разбор групп: INST b).
    if (result.status === 'blocked') return 'environment';
    if (touched.has(key)) return undefined;
    const item = cases.get(key);
    const file = item?.automation?.file;
    if (file) {
      const needle = normalPath(file);
      if (files.some((path) => path === needle || path.startsWith(`${needle}/`))) return undefined;
    }
    const earlier = before.get(key)?.status;
    if (earlier && RED.includes(earlier)) return 'baseline';
    if ((item?.codePaths ?? []).length === 0) return undefined;
    const said = [result.note, result.failure?.actual, result.failure?.retryNote, run.error].filter(
      Boolean,
    );
    return ENVIRONMENT_RED.test(said.join(' ')) ? 'environment' : undefined;
  };
}

/** Пробелы блока «Тесты» группы перед «доставлено». Чистая часть — для тестов. */
export function judgeTests(input: {
  groups: ProjectTestGroup[];
  runs: readonly ProjectTestRunRecord[];
  paths: readonly string[];
  startedAt?: string;
  /** Последняя правка кода группы: коммит или файл рабочего дерева. */
  changedAt?: string;
  /**
   * Отпечатки содержимого кейсов сейчас (`content-stamp`): у результата с
   * отпечатком свежесть решает он, а не `changedAt` — коммит, rebase и amend,
   * не тронувшие покрытого, прогон не старят. Нет — правило по времени.
   */
  stamps?: ReadonlyMap<string, string>;
  command: string;
}): TestsDeliveryGaps {
  const live = input.groups.filter((group) => !group.error);
  const all = live.flatMap((group) =>
    group.cases
      .filter((testCase) => !testCase.archived)
      .map((testCase) => ({ group: group.id, testCase })),
  );
  if (all.length === 0) return { missing: [], unchecked: 'no-cases' };

  const since = input.startedAt ? Date.parse(input.startedAt) : Number.NEGATIVE_INFINITY;
  const own = input.runs
    .filter((run) => run.status !== 'running')
    .filter((run) => {
      const at = Date.parse(run.startedAt);
      return Number.isFinite(at) && at >= since;
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const latest = latestResults(own);
  // Автоматический кейс засчитывается только исполненным прогоном: запись
  // «проверил» от агента (`tests-cli record`) — слово, а не команда (ревью 30.09).
  const executed = own.filter((run) => !run.attested);
  // Прогон до последней правки покрытого кейсом не видел того, что группа сдаёт
  // (Ф23). Свежесть — по кейсу: отпечаток содержимого, без него — время правки.
  const changed = input.changedAt ? Date.parse(input.changedAt) : Number.NEGATIVE_INFINITY;
  const latestExecuted = latestResults(executed, (run, key) =>
    freshResult(run, key, changed, input.stamps),
  );
  const byKey = new Map(all.map((item) => [`${item.group}:${item.testCase.id}`, item]));

  const touched = casesTouching(input.paths, live).cases.map(
    (item) => `${item.groupId}:${item.caseId}`,
  );
  const automated = touched.filter(
    (key) => byKey.get(key)?.testCase.automation?.status === 'automated',
  );
  const missing: string[] = [];

  const linked = all.some((item) => (item.testCase.codePaths ?? []).length > 0);
  const code = input.paths.filter((path) => !path.startsWith('.agent/'));
  if (touched.length === 0 && linked && code.length > 0) {
    missing.push(serverText('tests-gap-uncovered', { files: named(code) }));
  }

  if (automated.length > 0 && executed.length === 0) {
    // Запись словом есть, а исполненного прогона нет: «ни одного прогона» тут
    // неправда, и агент спорит с панелью вместо того, чтобы запустить команду.
    missing.push(
      serverText(own.length > 0 ? 'tests-gap-word-only' : 'tests-gap-no-run', {
        cases: named(automated.map((key) => key.split(':')[1] ?? key)),
        command: narrowedCommand(input.command, automated),
      }),
    );
  } else if (automated.length > 0 && !automated.some((key) => latestExecuted.has(key))) {
    missing.push(
      serverText('tests-gap-stale', {
        run: executed[0]?.id ?? '',
        files: named(code),
        command: narrowedCommand(input.command, automated),
      }),
    );
  } else {
    const unrun = automated.filter((key) => {
      const status = latestExecuted.get(key)?.status;
      return !status || status === 'skipped' || status === 'unknown';
    });
    if (unrun.length > 0) {
      missing.push(
        serverText('tests-gap-unrun', {
          cases: named(unrun.map((key) => key.split(':')[1] ?? key)),
          command: narrowedCommand(input.command, unrun),
        }),
      );
    }
  }

  // Красное в прогонах группы — пробел, задет кейс диффом или нет: группа
  // сама его прогнала и сама увидела. Карантин (`muted`) не держит. Красное
  // не из-за ветки (`redNotFromBranch`: было красным до старта группы или
  // упало от окружения, а дифф кейса не задел) — заметка, а не пробел.
  const cause = redNotFromBranch({
    groups: input.groups,
    runs: input.runs,
    paths: input.paths,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
  });
  const red: string[] = [];
  const noted: Record<RedCause, string[]> = { baseline: [], environment: [] };
  // Красное — объединение (RF-EF-03, то же правило, что у конца хода): запись
  // словом не перекрывает исполненный красный (F-22), а красное слово не прячется
  // за более ранним исполненным зелёным.
  const ran = latestResults(executed);
  for (const [key, word] of latest) {
    const result = redOf(word, ran.get(key));
    if (!result || byKey.get(key)?.testCase.muted) continue;
    const id = key.split(':')[1] ?? key;
    const why = cause(result);
    if (why) noted[why].push(id);
    else red.push(id);
  }
  if (red.length > 0) missing.push(serverText('tests-gap-failed', { cases: named(red) }));
  const notes = [
    ...(noted.baseline.length > 0
      ? [serverText('tests-note-red-baseline', { cases: named(noted.baseline) })]
      : []),
    ...(noted.environment.length > 0
      ? [serverText('tests-note-red-environment', { cases: named(noted.environment) })]
      : []),
  ];

  const passed = automated.filter((key) => latestExecuted.get(key)?.status === 'passed').length;
  const last = executed[0] ?? own[0];
  return {
    missing,
    ...(notes.length > 0 ? { notes, noted: [...noted.baseline, ...noted.environment] } : {}),
    verdict: {
      cases: automated.length,
      passed,
      ...(last ? { runId: last.id, runAt: last.finishedAt ?? last.startedAt } : {}),
    },
  };
}

/**
 * Последняя правка кода группы (Ф23): время коммита HEAD и mtime файлов,
 * изменённых в рабочем дереве поверх него. Коммит старше старта группы ничего
 * не сдвигает — свежесть меряется от позднего из двух. Только для записей без
 * отпечатка содержимого: дата коммита старила прогон, после которого лишь
 * закоммитили то же самое.
 */
async function lastChangeAt(cwd: string, paths: readonly string[]): Promise<string | undefined> {
  const head = await git(cwd, ['log', '-1', '--format=%cI', 'HEAD']);
  let latest = head.code === 0 ? Date.parse(head.stdout.trim()) : Number.NaN;
  const dirty = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (dirty.code === 0) {
    const touched = new Set(paths);
    for (const entry of dirty.stdout.split('\u0000')) {
      const path = entry.slice(3).trim();
      if (!path || !touched.has(path)) continue;
      try {
        const mtime = statSync(join(cwd, path)).mtimeMs;
        if (!(latest >= mtime)) latest = mtime;
      } catch {
        // Удалённый файл — времени правки нет; его покрывает коммит или старт.
      }
    }
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
}

/** Пробелы блока «Тесты» в копии группы: кейсы и прогоны читаются с диска копии. */
export async function testsDeliveryGaps(input: {
  cwd: string;
  startedAt?: string;
  /** Команда, которой группа записывает прогон в блок своей копии. */
  command: string;
}): Promise<TestsDeliveryGaps> {
  const groups = readGroups(input.cwd);
  if (!groups.some((group) => group.cases.length > 0)) {
    return { missing: [], unchecked: 'no-cases' };
  }
  const paths = await touchedPaths(input.cwd);
  const changedAt = await lastChangeAt(input.cwd, paths);
  const runs = readRuns(input.cwd);
  const touched = casesTouching(paths, groups).cases.map(
    (item) => `${item.groupId}:${item.caseId}`,
  );
  return judgeTests({
    groups,
    runs,
    paths,
    stamps: currentStamps(input.cwd, groups, runs, touched),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(changedAt ? { changedAt } : {}),
    command: input.command,
  });
}
