import {
  BUILTIN_SIEVES,
  SIEVE_LANG,
  touchesSieve,
  type BuiltinSieveId,
  type SieveDef,
} from './catalog.ts';
import {
  citedRunIds,
  EVIDENCE_MIN,
  evidenceRunIds,
  looseRunIds,
  type SieveReportRow,
} from './report.ts';
import {
  claimsTestsBlock,
  countClaimOf,
  countMatches,
  totalCount,
  type RunTestCount,
} from './count-claims.ts';

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
  /** Путь из `foreignRemovals` → коммит основной и строки: «sha «тема», lines 40-46». */
  foreignBlame?: Record<string, string>;
  /**
   * «Чужие −», уже подтверждённые пушем этой ветки (`# sieve-ack:` сита кита), чьи
   * удалённые строки с тех пор те же: в `foreignRemovals` их нет, строки отчёта они
   * не требуют (аудит g0 23.10, F-01).
   */
  foreignAcked?: string[];
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
  /**
   * Файлы поведения в диффе — код продукта (UI и бэкенд), не тесты и не доки.
   * Есть хоть один — живая проверка не сдаётся `n/a` (решение владельца 10.10).
   */
  behaviour?: string[];
}

/** Что панель узнала о прогоне блока «Тесты», на который сослалось доказательство. */
export interface SieveRunFact {
  /** Прогон записан в истории блока копии и закончен. */
  found: boolean;
  /** Красные кейсы прогона (`failed`/`blocked`). */
  red: string[];
  /** Зелёных результатов в прогоне; 0 — прогон ничего не проверил (всё пропущено или пусто). */
  passed?: number;
  /** Метки кейсов, прошедших в прогоне (`tags` кейса, в нижнем регистре): живой ли он (`liveTags`). */
  tags?: string[];
  /**
   * `codePaths` кейсов, прошедших в прогоне, который блок исполнил сам (не ручная запись):
   * у диффа из одних инструментов (`tools/`, `scripts/`) живой проверкой служит исполнение
   * самого инструмента — у линтера сборки нет стенда (g8 26.10, решение по строке 98).
   */
  executedPaths?: string[];
  /** Пути, изменённые в ветке ПОСЛЕ коммита прогона (коммита нет в ветке — все её пути). */
  changedAfter: string[];
  /** Счёт тестов прогона (не кейсов) — с ним сверяется «N passed» строки (F-12). */
  tests?: RunTestCount;
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
  /**
   * Последние законченные прогоны истории копии, новые первыми (их факты — в `runs`):
   * строке без ссылки пробел называет годный из них — «сошлитесь», а не «прогоните
   * заново» (g3 25.10 прогнала те же кейсы на том же дереве ради номера).
   */
  latest?: string[];
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
    | 'sieve-gap-no-run-cite'
    | 'sieve-gap-run-not-live'
    | 'sieve-gap-flip'
    | 'sieve-gap-run-missing'
    | 'sieve-gap-run-empty'
    | 'sieve-gap-run-red'
    | 'sieve-gap-run-stale'
    | 'sieve-gap-live-na'
    | 'sieve-gap-count-no-cite'
    | 'sieve-gap-count-no-run'
    | 'sieve-gap-count-mismatch';
  params: Record<string, string>;
}

/**
 * Все ли пути названы в доказательстве — так снимается механическое срабатывание.
 * Имя файла без пути годится, только если оно среди отмеченных одно: иначе
 * «index.ts» снимал бы разом `apps/a/index.ts` и `apps/b/index.ts` (ревью сит).
 */
/** Имя стоит в тексте отдельным словом: `src/a.ts` не прячется внутри `src/data.ts`, `FOO` — внутри `FOOBAR` (ревью PR #1). */
function mentions(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1] ?? ' ';
    const after = text[at + name.length] ?? ' ';
    if (!/[\w.-]/.test(before) && !/[\w-]/.test(after)) return true;
  }
  return false;
}

const BRACE_GROUP = /\{([^{}\n]*,[^{}\n]*)\}/;
const BRACE_WORD = /\S*\{[^{}\n]*,[^{}\n]*\}\S*/g;
/** Предел раскрытий одного слова: дальше не раскрытое остаётся неназванным, не «названным». */
const BRACE_MAX = 256;

/** Раскрытия слова со скобками, как у оболочки: `a/{x,y}/b` → `a/x/b`, `a/y/b`; несколько групп — по очереди. */
function braceForms(word: string): string[] {
  const done: string[] = [];
  const todo = [word];
  while (todo.length > 0 && done.length + todo.length <= BRACE_MAX) {
    const current = todo.shift() as string;
    const group = BRACE_GROUP.exec(current);
    if (!group) {
      done.push(current);
      continue;
    }
    const head = current.slice(0, group.index);
    const tail = current.slice(group.index + group[0].length);
    for (const alt of (group[1] as string).split(',')) todo.push(`${head}${alt.trim()}${tail}`);
  }
  return done;
}

/**
 * Доказательство вместе с раскрытыми скобочными путями: группа #0 23.10 (!1071)
 * назвала `content/{ru,en,uz}/api/chats.mdx`, судья искал путь буквально, и
 * одноимённые en/ru не снимались — доставка ушла на круг. Исходный текст остаётся.
 */
function withBraces(evidence: string): string {
  const words = evidence.match(BRACE_WORD) ?? [];
  return words.length === 0 ? evidence : `${evidence} ${words.flatMap(braceForms).join(' ')}`;
}

/** Отмеченные, которых доказательство не называет (`files` в исходном виде). */
function unnamedOf(evidence: string, files: readonly string[]): string[] {
  const low = withBraces(evidence).replace(/\\/g, '/').toLowerCase();
  const paths = files.map((file) => file.replace(/\\/g, '/').toLowerCase());
  const baseOf = (path: string): string => path.split('/').pop() ?? path;
  const bases = paths.map(baseOf);
  return files.filter((_, at) => {
    const path = paths[at] ?? '';
    const base = baseOf(path);
    const unique = bases.filter((other) => other === base).length === 1;
    return !(mentions(low, path) || (unique && mentions(low, base)));
  });
}

function namesAll(evidence: string, files: readonly string[]): boolean {
  return unnamedOf(evidence, files).length === 0;
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
  /** Как файл показан в пробеле; снимается строка всё равно по пути. */
  shown?: (mechanics: SieveMechanics, path: string) => string;
}[] = [
  {
    id: 'foreign-removals',
    code: 'sieve-gap-foreign-removals',
    items: (m) => m.foreignRemovals ?? [],
    param: 'files',
    // Чей коммит и какие строки — иначе агенту нечем проверить «чужое» (23.10).
    shown: (m, path) => (m.foreignBlame?.[path] ? `${path} (${m.foreignBlame[path]})` : path),
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

/**
 * Снятие механики привязано к содержимому отмеченного (Ф5): строка, назвавшая
 * файл с секретом, отладкой, артефактом или манифест без лок-файла, не в счёт,
 * если ЭТОТ файл правили после неё. Переменные окружения названы именами — их
 * снимает правка любого кода, который сито покрывает.
 */
function movedSinceRow(
  flag: (typeof FLAGS)[number],
  items: readonly string[],
  proof: SieveProofFacts | undefined,
): string[] {
  const changed = proof?.changedAfterRow?.[flag.id] ?? [];
  if (changed.length === 0) return [];
  if (flag.param === 'names') {
    const sieve = BUILTIN_SIEVES.find((item) => item.id === flag.id);
    return sieve ? touchesSieve(sieve, changed) : [];
  }
  const key = (path: string): string => path.replace(/\\/g, '/').toLowerCase();
  const flagged = new Set(items.map(key));
  return changed.filter((path) => flagged.has(key(path)));
}

/** Метки живой проверки сита через запятую — для текста пробела. */
function liveTagsOf(sieve: SieveDef): string {
  return (sieve.liveTags ?? ['live']).join(', ');
}

/**
 * Прогоны строки: `run:<id>` всегда, свободная форма (`run 664941c8`, `прогон
 * 664941c8`) — только найденная в истории копии (`citedRunIds`).
 */
function proofRunIds(evidence: string, proof: SieveProofFacts): string[] {
  return citedRunIds(evidence, (id) => proof.runs?.[id]?.found === true);
}

/** «Не проверено: …» — метка строки `fail` живого сита (`noteRows` сервера). */
export const UNCHECKED_MARK = /^\s*(?:not checked|unchecked|не проверено)\s*[:—–-]\s*/i;
/** «Не из-за ветки: …» — метка строки `fail`, чьё красное не от ветки. */
export const NOT_BRANCH_MARK =
  /^\s*(?:not caused by the branch|pre-existing|не из-за ветки|красное не из-за ветки)\s*[:—–-]\s*/i;
/**
 * Доказательство само говорит, что проверка красная или не сделана: «красный
 * только на Windows», «still red», «не проверено». Счёт («0 failed», «red: 0»)
 * сюда не попадает — только слово о состоянии.
 */
const STILL_RED =
  /\bnot checked\b|\bunchecked\b|не проверен|\b(?:is|still|stays|remains|only)\s+red\b|\bred\s+(?:only|on|in|because|here)\b|красн\p{L}*\s+(?:только|на|в|из-за|до)(?!\p{L})|(?:остаётся|остался|остаются|всё ещё|только)\s+красн/iu;

/** Слова доказательства без меток и ссылок — для сравнения «то же самое». */
function words(evidence: string): Set<string> {
  const bare = evidence.replace(UNCHECKED_MARK, '').replace(NOT_BRANCH_MARK, '').toLowerCase();
  return new Set(bare.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? []);
}

/** Доля общих слов двух доказательств (Жаккар): ≥ 0.8 — по сути тот же текст. */
function sameSubstance(a: string, b: string): boolean {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return left.size === right.size;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / (left.size + right.size - common) >= 0.8;
}

/**
 * Почему строка `pass` не принята как переворот (g3 25.10, owner-4: fail → pass
 * с тем же «красный только на Windows … run:ac24faf5»):
 * - `mark` — `pass` с меткой заметки («not checked:», «not caused by the branch:»):
 *   метки бывают только у `fail`, и с `pass` заметка молча становилась зачётом;
 * - `red` — строка перевернулась из `fail`, а доказательство говорит «красный»,
 *   «не проверено»;
 * - `same` — перевернулась из `fail` без нового прогона и с тем же по сути текстом.
 * `undefined` — переворота без доказательства нет.
 */
export function flipWithoutProof(row: SieveReportRow): 'mark' | 'red' | 'same' | undefined {
  if (row.status !== 'pass') return undefined;
  if (UNCHECKED_MARK.test(row.evidence) || NOT_BRANCH_MARK.test(row.evidence)) return 'mark';
  if (row.was?.status !== 'fail') return undefined;
  if (STILL_RED.test(row.evidence)) return 'red';
  const runsOf = (text: string): string[] => [
    ...new Set([...evidenceRunIds(text), ...looseRunIds(text)]),
  ];
  const before = new Set(runsOf(row.was.evidence));
  const fresh = runsOf(row.evidence).some((id) => !before.has(id));
  return !fresh && sameSubstance(row.evidence, row.was.evidence) ? 'same' : undefined;
}

/** Путь инструмента сборки или разработки — не продукт, стенда у него нет. */
const TOOLING_PATH = /(?:^|\/)(?:tools|scripts)\//i;

/**
 * Файлы поведения сита, если все они — инструменты (`TOOLING_PATH`); иначе пусто:
 * хоть один файл продукта — и живая проверка снова нужна по меткам.
 */
function toolingOnly(sieve: SieveDef, mechanics: SieveMechanics | undefined): string[] {
  const files = touchesSieve(sieve, mechanics?.behaviour ?? []).map((path) =>
    path.replace(/\\/g, '/'),
  );
  return files.length > 0 && files.every((path) => TOOLING_PATH.test(path)) ? files : [];
}

/** Прошедший исполненный кейс называет хоть один файл инструмента (сам файл или его папку). */
function toolingExecuted(fact: SieveRunFact, tooling: readonly string[]): boolean {
  const named = (fact.executedPaths ?? []).map((path) =>
    path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
  );
  return tooling.some((file) => {
    const path = file.toLowerCase();
    return named.some((own) => own !== '' && (path === own || path.startsWith(`${own}/`)));
  });
}

/** Пробел доказательства прогоном: нет прогона, он красный или старше правки. */
function runGap(
  sieve: SieveDef,
  id: string,
  fact: SieveRunFact | undefined,
  tooling: readonly string[] = [],
): SieveGap | undefined {
  if (!fact?.found) return { code: 'sieve-gap-run-missing', params: { sieve: sieve.id, run: id } };
  if (fact.red.length > 0) {
    return {
      code: 'sieve-gap-run-red',
      params: { sieve: sieve.id, run: id, cases: named(fact.red) },
    };
  }
  // Ревью PR #1: прогон из одних пропусков или без результатов ничего не проверил.
  if (fact.passed === 0)
    return { code: 'sieve-gap-run-empty', params: { sieve: sieve.id, run: id } };
  // Живая проверка — не юнит-тест (g3 25.10): прошёл хоть один кейс с живой меткой.
  const live = sieve.liveTags ?? [];
  const tagged = (fact.tags ?? []).some((tag) => live.includes(tag));
  if (live.length > 0 && !tagged && !(tooling.length > 0 && toolingExecuted(fact, tooling))) {
    return {
      code: 'sieve-gap-run-not-live',
      params: { sieve: sieve.id, run: id, tags: live.join(', ') },
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
  mechanics?: SieveMechanics,
): SieveGap | undefined {
  if (!proof) return undefined;
  const tooling = toolingOnly(sieve, mechanics);
  const touched = touchesSieve(sieve, proof.changedAfterRow?.[sieve.id] ?? []);
  if (touched.length > 0) {
    return { code: 'sieve-gap-stale', params: { sieve: sieve.id, files: named(touched) } };
  }
  const byRun = sieve.proof === 'run';
  if ((!byRun && !sieve.liveTags) || row.status !== 'pass' || !proof.testsBlock) return undefined;
  const ids = proofRunIds(row.evidence, proof);
  // Сито с живыми метками без `proof:'run'` (стенд ветки) доказывается словами, но
  // прогон, на который оно сослалось, судится как живой.
  if (ids.length === 0 && !byRun) return undefined;
  if (ids.length === 0) {
    const fit = (proof.latest ?? []).find((id) => !runGap(sieve, id, proof.runs?.[id], tooling));
    return fit
      ? { code: 'sieve-gap-no-run-cite', params: { sieve: sieve.id, run: fit } }
      : { code: 'sieve-gap-no-run', params: { sieve: sieve.id, tags: liveTagsOf(sieve) } };
  }
  let first: SieveGap | undefined;
  for (const id of ids) {
    const gap = runGap(sieve, id, proof.runs?.[id], tooling);
    if (!gap) return undefined;
    first ??= gap;
  }
  return first;
}

/** Счёт прогона для строки пробела: неточный «прошло» не называется числом. */
function countParams(run: string, count: RunTestCount | undefined): Record<string, string> {
  return {
    run,
    passed: count?.exact ? String(count.passed) : '?',
    failed: count ? String(count.failed) : '?',
  };
}

/**
 * Счёт тестов строки — тот, что напечатал прогон блока «Тесты» (аудит g0 25.10,
 * F-12): «tests-cli … 2117 passed» обязан сослаться на прогон, и числа сверяются с
 * ним — прогон с одним упавшим «2117 passed» без «1 failed» не подтверждает.
 */
function countGap(
  sieve: SieveDef,
  row: SieveReportRow,
  proof: SieveProofFacts | undefined,
): SieveGap | undefined {
  if (!proof?.testsBlock || row.status !== 'pass') return undefined;
  const claim = countClaimOf(row.evidence);
  if (!claim) return undefined;
  const ids = proofRunIds(row.evidence, proof);
  if (!claimsTestsBlock(row.evidence, ids)) return undefined;
  if (ids.length === 0) {
    const last = proof.latest?.[0];
    return last
      ? {
          code: 'sieve-gap-count-no-cite',
          params: {
            sieve: sieve.id,
            claim: claim.text,
            ...countParams(last, proof.runs?.[last]?.tests),
          },
        }
      : { code: 'sieve-gap-count-no-run', params: { sieve: sieve.id, claim: claim.text } };
  }
  const missing = ids.find((id) => !proof.runs?.[id]?.found);
  if (missing) return { code: 'sieve-gap-run-missing', params: { sieve: sieve.id, run: missing } };
  const counts = ids.map((id) => proof.runs?.[id]?.tests);
  // Прогон без счёта (ручная запись) не сверить — строку держит не он.
  if (counts.some((count) => !count)) return undefined;
  const known = counts as RunTestCount[];
  if (known.some((count) => countMatches(claim, count))) return undefined;
  if (known.length > 1 && countMatches(claim, totalCount(known))) return undefined;
  return {
    code: 'sieve-gap-count-mismatch',
    params: { sieve: sieve.id, claim: claim.text, ...countParams(ids[0]!, known[0]) },
  };
}

/** Дополнительные требования отдельных сит к уже сданной строке. */
function contentGap(
  sieve: SieveDef,
  row: SieveReportRow,
  mechanics: SieveMechanics,
): SieveGap | undefined {
  // Живая проверка (`proof: 'run'`) сдаётся `n/a` только на диффе без файлов
  // поведения (решение владельца 10.10): правка кода «не применимой» не бывает,
  // а причина на доках/контракте уходит в описание MR (`mrDescriptionGap`). Считаются
  // только файлы поведения вида этого сита: линтер сборки — не контракт и не бэкенд, и
  // `n/a` контракта по запросу из-за него отбивался (g8 26.10).
  const behaviour =
    sieve.proof === 'run' && row.status === 'n/a'
      ? touchesSieve(sieve, mechanics.behaviour ?? [])
      : [];
  if (behaviour.length > 0) {
    return {
      code: 'sieve-gap-live-na',
      // Метки — в самом отказе (g8 26.10: без них группа искала в коде панели, что
      // считается «живым», 7 чтений).
      params: { sieve: sieve.id, files: named(behaviour), tags: liveTagsOf(sieve) },
    };
  }
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
 * Пробел, который судья запишет по строке сита, сдаваемого группой
 * (`needsRow`), или `undefined` — строку он примет как есть. Одна функция на
 * судью и на задание звена (Ф1): задание не может счесть сданной строку,
 * которую судья потом отклонит, — раньше оно мерило только длину доказательства.
 */
export function rowGap(
  sieve: SieveDef,
  row: SieveReportRow | undefined,
  mechanics: SieveMechanics,
  proof?: SieveProofFacts,
): SieveGap | undefined {
  if (!row) return { code: 'sieve-gap-unreported', params: { sieve: sieve.id, lang: SIEVE_LANG } };
  if (row.status === 'fail') {
    // Строка сита с именами длиннее обычной (`NAMING_SIEVES`) — в напоминание её начало.
    const evidence = row.evidence.length > 600 ? `${row.evidence.slice(0, 600)}…` : row.evidence;
    return { code: 'sieve-gap-failed', params: { sieve: sieve.id, evidence } };
  }
  if (row.evidence.length < EVIDENCE_MIN) {
    return { code: 'sieve-gap-no-evidence', params: { sieve: sieve.id } };
  }
  const flip = flipWithoutProof(row);
  if (flip) {
    return {
      code: 'sieve-gap-flip',
      params: { sieve: sieve.id, kind: flip, was: row.was?.evidence.slice(0, 300) ?? '' },
    };
  }
  if (sieve.id === 'consumers-repo-wide') {
    const gap = consumersGap(mechanics, row);
    if (gap) return gap;
  }
  return (
    contentGap(sieve, row, mechanics) ??
    proofGap(sieve, row, proof, mechanics) ??
    countGap(sieve, row, proof)
  );
}

/** Потребители удалённого вне диффа, не названные строкой поиска потребителей. */
function consumersGap(
  mechanics: SieveMechanics,
  row: SieveReportRow | undefined,
): SieveGap | undefined {
  const consumers = mechanics.consumers ?? [];
  const files = [...new Set(consumers.flatMap((hit) => hit.files))];
  if (files.length === 0) return undefined;
  if (
    row &&
    row.status !== 'fail' &&
    row.evidence.length >= EVIDENCE_MIN &&
    namesAll(row.evidence, files)
  ) {
    return undefined;
  }
  // Назвать нужно каждый файл — пробел называет каждый ещё не названный.
  const left = row && row.status !== 'fail' ? unnamedOf(row.evidence, files) : files;
  return {
    code: 'sieve-gap-consumers',
    params: {
      tokens: consumers
        .slice(0, NAMED_MAX)
        .map((hit) => hit.token)
        .join(', '),
      files: (left.length > 0 ? left : files).join(', '),
    },
  };
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
    if (items.length === 0) continue;
    const byNames = flag.id !== 'tests-alongside';
    if (!cleared(flag.id, items, byNames)) {
      // Требуется назвать каждый — пробел и называет каждый, кого строка ещё не
      // назвала: «(+7)» прятал семь путей, и группа гадала их (!1072, 24.10).
      const row = rows.get(flag.id);
      const left =
        byNames && row && row.status !== 'fail' ? unnamedOf(row.evidence, items) : [...items];
      const todo = left.length > 0 ? left : [...items];
      const shown = flag.shown ? todo.map((item) => flag.shown?.(mechanics, item) ?? item) : todo;
      gaps.push({
        code: flag.code,
        params: { [flag.param]: byNames ? shown.join(', ') : named(shown) },
      });
      continue;
    }
    const moved = movedSinceRow(flag, items, input.proof);
    if (moved.length > 0) {
      gaps.push({ code: 'sieve-gap-stale', params: { sieve: flag.id, files: named(moved) } });
    }
  }
  const consumers = consumersGap(mechanics, rows.get('consumers-repo-wide'));
  if (consumers) gaps.push(consumers);

  for (const sieve of input.applicable) {
    // Механику панель судит сама выше (`needsRow`).
    if (!needsRow(sieve)) continue;
    if (sieve.id === 'consumers-repo-wide' && consumers) continue;
    const gap = rowGap(sieve, rows.get(sieve.id), mechanics, input.proof);
    if (gap) gaps.push(gap);
  }
  return gaps;
}

/**
 * Живые проверки, сданные `n/a`: их причина идёт в описание MR, и проверка
 * доставки требует, чтобы описание назвало каждое такое сито (решение 10.10).
 */
export function liveNaIds(rows: readonly SieveReportRow[]): string[] {
  const live = new Set<string>(BUILTIN_SIEVES.filter((s) => s.proof === 'run').map((s) => s.id));
  return [
    ...new Set(rows.filter((row) => row.status === 'n/a' && live.has(row.id)).map((row) => row.id)),
  ];
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
