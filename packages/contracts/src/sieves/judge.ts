import { SIEVE_LANG, touchesSieve, type BuiltinSieveId, type SieveDef } from './catalog.ts';
import { EVIDENCE_MIN, evidenceRunIds, type SieveReportRow } from './report.ts';

// ---------------------------------------------------------------- судья

/**
 * Команда проверок проекта, найденная панелью. В доказательстве её узнают по
 * самой команде или по точной записи-синониму (`pnpm run lint` для `pnpm lint`).
 */
export interface ProjectCheck {
  command: string;
  aliases?: string[];
}

/** Что панель сама нашла по git и файлам копии (`sieve-facts.ts` сервера). */
export interface SieveMechanics {
  /** Файлы с конфликтом при слиянии со свежей основной. */
  conflicts?: string[];
  /** Файлы, где ветка удалила строки, пришедшие в основную после старта группы. */
  foreignRemovals?: string[];
  /** Удалённое имя/тест-id и файлы вне диффа, где оно ещё встречается. */
  consumers?: { token: string; files: string[] }[];
  /** Манифесты зависимостей, изменённые без своего lockfile. */
  lockfiles?: string[];
  /** Файлы, где в добавленных строках найден ключ, токен или приватный ключ. */
  secrets?: string[];
  /** Файлы с `.only`, `debugger`, `breakpoint()` или маркером конфликта в добавленном. */
  debugLeftovers?: string[];
  /** Добавленные файлы, которых в git быть не должно: игнорируемые, `.env`, ключи, крупные. */
  artifacts?: string[];
  /** Переменные окружения, которые дифф начал читать и которые нигде не объявлены. */
  envVars?: string[];
  /** Файлы кода, изменённые веткой, в которой не изменён ни один тест. */
  untestedCode?: string[];
  /** Файлы миграций с разрушающими операторами в добавленном. */
  destructive?: string[];
  /** Команды проверок проекта (lint, типы, тесты), найденные в его манифестах. */
  checks?: ProjectCheck[];
}

/** Что панель узнала о прогоне блока «Тесты», на который сослалось доказательство. */
export interface SieveRunFact {
  /** Прогон записан в истории блока копии и закончен. */
  found: boolean;
  /** Красные кейсы прогона (`failed`/`blocked`). */
  red: string[];
  /** Пути, изменённые в ветке ПОСЛЕ коммита прогона (коммита нет в ветке — все её пути). */
  changedAfter: string[];
}

/**
 * Проверяемость доказательства. Без него судья ведёт себя как прежде — по словам
 * отчёта; с ним — строка, сданная до правки задетого кода, не в счёт, а живая
 * проверка в проекте с блоком «Тесты» доказывается записанным прогоном.
 */
export interface SieveProofFacts {
  /** id строки → пути, изменённые коммитами ветки после её сдачи (`row.at`). */
  changedAfterRow?: Record<string, string[]>;
  /** В копии есть кейсы блока «Тесты» — сита живой проверки требуют `run:<id>`. */
  testsBlock?: boolean;
  /** Прогоны, на которые сослались строки, — по id. */
  runs?: Record<string, SieveRunFact>;
}

/** Пробел сита: код текста сервера и параметры — строку собирает сервер. */
export interface SieveGap {
  code:
    | 'sieve-gap-conflicts'
    | 'sieve-gap-foreign-removals'
    | 'sieve-gap-consumers'
    | 'sieve-gap-unreported'
    | 'sieve-gap-no-evidence'
    | 'sieve-gap-failed'
    | 'sieve-gap-lockfile'
    | 'sieve-gap-secrets'
    | 'sieve-gap-debug'
    | 'sieve-gap-artifacts'
    | 'sieve-gap-env'
    | 'sieve-gap-untested'
    | 'sieve-gap-checks'
    | 'sieve-gap-destructive'
    | 'sieve-gap-stale'
    | 'sieve-gap-no-run'
    | 'sieve-gap-run-missing'
    | 'sieve-gap-run-red'
    | 'sieve-gap-run-stale';
  params: Record<string, string>;
}

/**
 * Все ли пути названы в доказательстве — так снимается механическое срабатывание.
 * Имя файла без пути годится, только если оно среди отмеченных одно: иначе
 * «index.ts» снимал бы разом `apps/a/index.ts` и `apps/b/index.ts` (ревью сит).
 */
function namesAll(evidence: string, files: readonly string[]): boolean {
  const low = evidence.replace(/\\/g, '/').toLowerCase();
  const paths = files.map((file) => file.replace(/\\/g, '/').toLowerCase());
  const baseOf = (path: string): string => path.split('/').pop() ?? path;
  const bases = paths.map(baseOf);
  return paths.every((path) => {
    const base = baseOf(path);
    const unique = bases.filter((other) => other === base).length === 1;
    return low.includes(path) || (unique && low.includes(base));
  });
}

const flat = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** Команды, которых доказательство не называет ни дословно, ни синонимом. */
function unnamedChecks(evidence: string, checks: readonly ProjectCheck[]): string[] {
  const text = flat(evidence);
  return checks
    .filter(
      (check) =>
        ![check.command, ...(check.aliases ?? [])].some((form) => text.includes(flat(form))),
    )
    .map((check) => check.command);
}

/**
 * Сдаёт ли группа строку этого сита сама. Механику панель судит без неё; поиск
 * потребителей — исключение: панель видит удалённые имена, но не переименованный
 * test-id, поэтому группа сдаёт свой поиск, пока панель ничего не отметила.
 */
export function needsRow(sieve: SieveDef): boolean {
  return !sieve.mechanical || sieve.id === 'consumers-repo-wide';
}

const NAMED_MAX = 5;
function named(files: readonly string[]): string {
  const head = files.slice(0, NAMED_MAX).join(', ');
  return files.length > NAMED_MAX ? `${head} (+${files.length - NAMED_MAX})` : head;
}

/**
 * Механика панели, которая снимается строкой отчёта, называющей КАЖДЫЙ
 * отмеченный файл или имя (`tests-alongside` — любым доказательством).
 */
const FLAGS: readonly {
  id: BuiltinSieveId;
  code: SieveGap['code'];
  items: (mechanics: SieveMechanics) => readonly string[];
  param: 'files' | 'names';
}[] = [
  {
    id: 'foreign-removals',
    code: 'sieve-gap-foreign-removals',
    items: (m) => m.foreignRemovals ?? [],
    param: 'files',
  },
  {
    id: 'lockfile-sync',
    code: 'sieve-gap-lockfile',
    items: (m) => m.lockfiles ?? [],
    param: 'files',
  },
  { id: 'secrets', code: 'sieve-gap-secrets', items: (m) => m.secrets ?? [], param: 'files' },
  {
    id: 'debug-leftovers',
    code: 'sieve-gap-debug',
    items: (m) => m.debugLeftovers ?? [],
    param: 'files',
  },
  {
    id: 'committed-artifacts',
    code: 'sieve-gap-artifacts',
    items: (m) => m.artifacts ?? [],
    param: 'files',
  },
  { id: 'env-config', code: 'sieve-gap-env', items: (m) => m.envVars ?? [], param: 'names' },
  {
    id: 'tests-alongside',
    code: 'sieve-gap-untested',
    items: (m) => m.untestedCode ?? [],
    param: 'files',
  },
];

/** Пробел доказательства прогоном: нет прогона, он красный или старше правки. */
function runGap(sieve: SieveDef, id: string, fact: SieveRunFact | undefined): SieveGap | undefined {
  if (!fact?.found) return { code: 'sieve-gap-run-missing', params: { sieve: sieve.id, run: id } };
  if (fact.red.length > 0) {
    return {
      code: 'sieve-gap-run-red',
      params: { sieve: sieve.id, run: id, cases: named(fact.red) },
    };
  }
  const touched = touchesSieve(sieve, fact.changedAfter);
  if (touched.length > 0) {
    return {
      code: 'sieve-gap-run-stale',
      params: { sieve: sieve.id, run: id, files: named(touched) },
    };
  }
  return undefined;
}

/**
 * Проверяемость строки: сдана ли она на нынешнем коде и, для живой проверки в
 * проекте с блоком «Тесты», стоит ли за ней настоящий прогон. Одного годного
 * прогона среди названных хватает.
 */
function proofGap(
  sieve: SieveDef,
  row: SieveReportRow,
  proof: SieveProofFacts | undefined,
): SieveGap | undefined {
  if (!proof) return undefined;
  const touched = touchesSieve(sieve, proof.changedAfterRow?.[sieve.id] ?? []);
  if (touched.length > 0) {
    return { code: 'sieve-gap-stale', params: { sieve: sieve.id, files: named(touched) } };
  }
  if (sieve.proof !== 'run' || row.status !== 'pass' || !proof.testsBlock) return undefined;
  const ids = evidenceRunIds(row.evidence);
  if (ids.length === 0) return { code: 'sieve-gap-no-run', params: { sieve: sieve.id } };
  let first: SieveGap | undefined;
  for (const id of ids) {
    const gap = runGap(sieve, id, proof.runs?.[id]);
    if (!gap) return undefined;
    first ??= gap;
  }
  return first;
}

/** Дополнительные требования отдельных сит к уже сданной строке. */
function contentGap(
  sieve: SieveDef,
  row: SieveReportRow,
  mechanics: SieveMechanics,
): SieveGap | undefined {
  if (sieve.id === 'project-checks' && mechanics.checks?.length) {
    // Проверку, которую не удалось запустить, сдают `fail` с причиной, а не `n/a`.
    const missing =
      row.status === 'n/a'
        ? mechanics.checks.map((check) => check.command)
        : unnamedChecks(row.evidence, mechanics.checks);
    if (missing.length > 0) {
      return { code: 'sieve-gap-checks', params: { sieve: sieve.id, commands: named(missing) } };
    }
  }
  if (sieve.id === 'migration-safety' && mechanics.destructive?.length) {
    if (!namesAll(row.evidence, mechanics.destructive)) {
      return { code: 'sieve-gap-destructive', params: { files: named(mechanics.destructive) } };
    }
  }
  return undefined;
}

/**
 * Судья сит перед «доставлено». Пусто — все применимые сита пройдены.
 *
 * - конфликт со свежей основной не снимается ничем: только rebase;
 * - механическое срабатывание (чужие «−», lockfile, секреты, остатки отладки,
 *   артефакты, новые переменные окружения, потребители) снимается строкой
 *   отчёта этого сита со статусом `pass`/`n/a`, чьё доказательство называет
 *   КАЖДЫЙ отмеченный файл или имя — «проверил, всё ок» без имён не проходит;
 *   код без тестов в ветке снимается строкой с любым доказательством;
 * - немеханическое сито без строки — не пройдено; `pass`/`n/a` без
 *   доказательства — не пройдено; `fail` — не пройдено с доказательством;
 * - проверки проекта названы в доказательстве ВСЕ; разрушающая миграция
 *   названа по файлу;
 * - с `proof`: строка, после сдачи которой ветка меняла задетый ситом код, —
 *   устарела; живая проверка в проекте с блоком «Тесты» — только с прогоном
 *   `run:<id>`, который записан, не красный и не старше правки.
 */
export function judgeSieves(input: {
  applicable: readonly SieveDef[];
  rows: readonly SieveReportRow[];
  mechanics: SieveMechanics;
  proof?: SieveProofFacts;
}): SieveGap[] {
  const gaps: SieveGap[] = [];
  const { mechanics } = input;
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  const cleared = (id: BuiltinSieveId, items: readonly string[], byNames: boolean): boolean => {
    const row = rows.get(id);
    return Boolean(
      row &&
      row.status !== 'fail' &&
      row.evidence.length >= EVIDENCE_MIN &&
      (!byNames || namesAll(row.evidence, items)),
    );
  };

  const conflicts = mechanics.conflicts ?? [];
  if (conflicts.length > 0) {
    gaps.push({ code: 'sieve-gap-conflicts', params: { files: named(conflicts) } });
  }
  for (const flag of FLAGS) {
    const items = flag.items(mechanics);
    if (items.length === 0 || cleared(flag.id, items, flag.id !== 'tests-alongside')) continue;
    gaps.push({ code: flag.code, params: { [flag.param]: named(items) } });
  }
  const consumers = mechanics.consumers ?? [];
  const consumerFiles = [...new Set(consumers.flatMap((hit) => hit.files))];
  const consumersFlagged =
    consumerFiles.length > 0 && !cleared('consumers-repo-wide', consumerFiles, true);
  if (consumersFlagged) {
    gaps.push({
      code: 'sieve-gap-consumers',
      params: {
        tokens: consumers
          .slice(0, NAMED_MAX)
          .map((hit) => hit.token)
          .join(', '),
        files: named(consumerFiles),
      },
    });
  }

  for (const sieve of input.applicable) {
    // Механику панель судит сама выше (`needsRow`).
    if (!needsRow(sieve)) continue;
    if (sieve.id === 'consumers-repo-wide' && consumersFlagged) continue;
    const row = rows.get(sieve.id);
    if (!row) {
      gaps.push({ code: 'sieve-gap-unreported', params: { sieve: sieve.id, lang: SIEVE_LANG } });
    } else if (row.status === 'fail') {
      gaps.push({ code: 'sieve-gap-failed', params: { sieve: sieve.id, evidence: row.evidence } });
    } else if (row.evidence.length < EVIDENCE_MIN) {
      gaps.push({ code: 'sieve-gap-no-evidence', params: { sieve: sieve.id } });
    } else {
      const gap = contentGap(sieve, row, mechanics) ?? proofGap(sieve, row, input.proof);
      if (gap) gaps.push(gap);
    }
  }
  return gaps;
}

/** Сита, чьи сданные строки устарели: в задании их снова надо сделать. */
export function staleSieveIds(
  applicable: readonly SieveDef[],
  changedAfterRow: Readonly<Record<string, readonly string[]>>,
): string[] {
  return applicable
    .filter((sieve) => touchesSieve(sieve, changedAfterRow[sieve.id] ?? []).length > 0)
    .map((sieve) => sieve.id);
}
