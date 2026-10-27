import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { OWNER_POINT_ID, TASK_POINT_ID } from '@agentdeck/contracts/quality-floor';
import {
  applicableSieves,
  BUILTIN_SIEVES,
  citedRunIds,
  judgeSieves,
  NOT_BRANCH_MARK,
  UNCHECKED_MARK,
  riskTier,
  sievePromptBlock,
  staleSieveIds,
  type SieveClass,
  type SieveGap,
  type SieveMechanics,
  type SieveProofFacts,
  type SieveReportRow,
  type SieveStage,
} from '@agentdeck/contracts/sieves';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { readGroups, readRun, readRuns } from '../../project-tests/project-tests.ts';
import { baseRunsOf, redNotFromBranch } from '../tests-gate/tests-gate.ts';
import { projectChecks } from '../../project-git/project-checks.ts';
import { readSieveFacts, touchedFacts } from '../../project-git/sieve-facts/sieve-facts.ts';
import { behaviourIn, untestedCodeIn } from '../../project-git/sieve-scan/sieve-scan.ts';
import { sieveProofFacts } from '../sieve-proof/sieve-proof.ts';
import { flipWhy } from '../owner-coverage/owner-coverage.ts';
import type { SieveStore } from '../sieve-store/sieve-store.ts';

/**
 * Сита перед MR на двух концах конвейера (решение владельца 28.09):
 *
 * - ЗАДАНИЕ звена ревью/доставки — абзац сит по затронутым путям копии,
 *   выученным ситам проекта и уже сданному отчёту (`sievePrompt`);
 * - ПРОВЕРКА доставки — механика git панели плюс судья отчёта; пробелы
 *   становятся строками «не хватает», и группа получает их напоминанием тем же
 *   путём, что непушнутая ветка (`sieveDeliveryGaps`).
 */

/** Механика, которой не нужна сеть: команды проекта и код без тестов. */
function localMechanics(cwd: string, paths: readonly string[]): SieveMechanics {
  const checks = projectChecks(cwd);
  const untestedCode = untestedCodeIn(paths);
  const behaviour = behaviourIn(paths);
  return {
    ...(checks.length > 0 ? { checks } : {}),
    ...(untestedCode.length > 0 ? { untestedCode } : {}),
    ...(behaviour.length > 0 ? { behaviour } : {}),
  };
}

/**
 * Абзац сит для задания звена. Сит нет (пустой дифф, нет выученных) — пусто.
 * Без сети: пути и развилка — с локальной ссылкой основной, команды проверок —
 * из манифестов копии. Строки, сданные раньше, но устаревшие после новых
 * коммитов, звено делает заново; выученные сита — только задетых областей.
 */
export async function sievePrompt(input: {
  cwd: string;
  stage: SieveStage;
  done: readonly SieveReportRow[];
  store?: SieveStore;
  projectPath?: string;
  /** Ветка предшественника, от которой отведена копия группы (`after`). */
  forkedFrom?: string;
  /** Начало работы группы: кейс агента, заведённый после него, живых меток не доказывает. */
  startedAt?: string;
}): Promise<string> {
  const { paths, base } = await touchedFacts(input.cwd, input.forkedFrom);
  const applicable = applicableSieves(paths);
  const learned = input.store?.forProject(input.projectPath ?? input.cwd, undefined, paths) ?? [];
  const proof = await sieveProofFacts({
    cwd: input.cwd,
    rows: input.done,
    ...(base ? { base } : {}),
    branchPaths: paths,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
  });
  const block = sievePromptBlock({
    stage: input.stage,
    applicable,
    learned,
    done: input.done,
    mechanics: localMechanics(input.cwd, paths),
    stale: staleSieveIds(applicable, proof.changedAfterRow ?? {}),
    risk: riskTier(paths),
    proof,
    ...(proof.testsBlock ? { testsBlock: true } : {}),
  });
  return block ? `${block}\n${NOTE_MARKS_LINE}` : block;
}

/**
 * Живые проверки — те, что группа может не суметь запустить (нет стенда ветки,
 * браузера, сети): сита с доказательством прогоном плюс стенд бэкенда ветки.
 */
const LIVE_SIEVES: ReadonlySet<string> = new Set([
  ...BUILTIN_SIEVES.filter((sieve) => sieve.proof === 'run').map((sieve) => sieve.id),
  'branch-backend-stand',
]);

/**
 * Ссылка на команду и строку её вывода: `` `команда` → `вывод` `` (или `=>`,
 * `->`, `:`). Проверить её панель не может, но довод без неё — одни слова.
 */
const COMMAND_CITE = /`[^`\n]{2,}`\s*(?:→|=>|->|:)\s*`[^`\n]+`/;
/**
 * Классы, где «не из-за ветки» словами не снимает `fail` (решение 23.10, F-76:
 * строже по умолчанию): строка ссылается на прогон (`run:<id>`, красный и без
 * ветки) или на команду с её выводом. Ссылку на прогон панель проверяет
 * (`blockingRuns`), команда уходит ревьюеру как есть.
 */
const CITE_REQUIRED: ReadonlySet<SieveClass> = new Set(['security', 'data']);

function citeRequired(sieveId: string): boolean {
  const sieve = BUILTIN_SIEVES.find((item) => item.id === sieveId);
  return sieve ? CITE_REQUIRED.has(sieve.class) : false;
}

/**
 * Как сдать то, что группу держать не должно (решение владельца 23.10: группа
 * идёт до готового MR сама). Задание звена из контракта говорит «fail с
 * причиной» — эта строка называет две метки, которые панель читает как
 * заметку, а не пробел (`noteRows`).
 */
export const NOTE_MARKS_LINE =
  'A live check you cannot run here (no stand with this branch, no browser, no network) is ' +
  'reported with status fail and evidence starting "not checked: <reason>" — the panel records ' +
  'it as a note, not a blocker, and the MR description must name that sieve id with the reason. ' +
  'A run-proven live sieve counts only a Tests-block run of a case a human made or tagged live; ' +
  'when none covers the change, that is the reason («no human-made live case covers <what>»), ' +
  'not «no browser». ' +
  'A row red for a reason outside the branch (red on the target branch too, platform-only, a ' +
  'timeout in code the diff does not touch) is fail with evidence starting "not caused by the ' +
  'branch: <why, and how you know>" — also a note named in the MR description; anything the ' +
  'diff could have caused stays a plain fail. For a security or data sieve (secrets, ' +
  'migration-safety) words are not enough: the evidence cites the red on the target branch as ' +
  'run:<id> or as `<command>` → `<output line>`, otherwise the fail holds. A cited run must ' +
  'show that red: a run with no red, or whose red the branch touched, holds the fail too.';

/**
 * Заметка по строке отчёта: `unchecked` снимает все пробелы сита по строке,
 * `not-branch` — только сам `fail`.
 */
interface RowNote {
  kind: 'unchecked' | 'not-branch';
  text: string;
}

/**
 * Строки с метками заметок (`NOTE_MARKS_LINE`). Правило «держит только
 * сломанное веткой» (23.10):
 * - «не проверено» снимает пробелы только у ЖИВОГО сита (`LIVE_SIEVES`) — его
 *   окружение группе может быть недоступно; гигиену, проверки проекта и прочее
 *   локальное «не проверено» не снимает;
 * - «не из-за ветки» снимает только `fail` и только если прогоны, на которые
 *   строка сослалась, не держат красного, задетого веткой (`blockingRuns`):
 *   ссылка на прогон — проверяемый факт, слова без неё — довод группы,
 *   который уходит в описание MR на суд ревьюера; у сит безопасности и данных
 *   (`CITE_REQUIRED`) слов без ссылки мало — `fail` держит;
 * - у сит безопасности и данных ссылка на прогон засчитывается, только если
 *   каждый названный прогон показывает красное, бывшее и до старта группы
 *   (`baselineRuns`, RF-EF-02): ссылка на зелёный или «по таймауту» прогон
 *   красного на основной не доказывает.
 *
 * Не принятая метка у строки `fail` — в `rejected` с причиной и тем, что
 * сделать: без неё пробел звучал как «пункт не выполнен: <та же метка>», и g3
 * 25.10 дважды пересказала то же доказательство (#g3:145/148).
 */
function noteRows(
  rows: readonly SieveReportRow[],
  runs: CitedRuns,
  /** Прогоны строки: `run:<id>` и свободная форма с номером из истории (`citedRunIds`). */
  cite: (evidence: string) => string[],
): { notes: Map<string, RowNote>; rejected: Map<string, string> } {
  const notes = new Map<string, RowNote>();
  const rejected = new Map<string, string>();
  for (const row of rows) {
    const unchecked = UNCHECKED_MARK.exec(row.evidence);
    // Пункт владельца — чаще всего живая проверка («на стенде», «в браузере»):
    // «не проверено» снимает его так же, как живое сито, и описание MR его называет.
    // Пункт задачи (`task-N`, трасса ожиданий задачи) судится так же: его ждёт
    // `taskCoverageGaps` с теми же `noted`/`rejected`, что у пунктов владельца.
    const live =
      LIVE_SIEVES.has(row.id) || OWNER_POINT_ID.test(row.id) || TASK_POINT_ID.test(row.id);
    if (unchecked && row.status === 'fail' && !live) {
      rejected.set(row.id, serverText('note-rejected-not-live', {}));
      continue;
    }
    if (unchecked && live && row.status !== 'pass') {
      const reason = row.evidence.slice(unchecked[0].length).trim();
      if (reason) {
        const text = serverText('sieve-note-unchecked', { sieve: row.id, reason });
        notes.set(row.id, { kind: 'unchecked', text });
      } else if (row.status === 'fail') {
        rejected.set(row.id, serverText('note-rejected-no-reason', {}));
      }
      continue;
    }
    const notBranch = NOT_BRANCH_MARK.exec(row.evidence);
    if (!notBranch || row.status !== 'fail') continue;
    const reason = row.evidence.slice(notBranch[0].length).trim();
    const why = notBranchRejection(row.id, reason, cite(row.evidence), runs);
    if (why) {
      rejected.set(row.id, why);
      continue;
    }
    const text = serverText('sieve-note-not-branch', { sieve: row.id, reason });
    notes.set(row.id, { kind: 'not-branch', text });
  }
  return { notes, rejected };
}

/** Почему «не из-за ветки» строки не принято; принято — `undefined`. */
function notBranchRejection(
  sieveId: string,
  reason: string,
  cited: readonly string[],
  runs: CitedRuns,
): string | undefined {
  if (!reason) return serverText('note-rejected-no-reason', {});
  if (citeRequired(sieveId)) {
    if (cited.length === 0 && !COMMAND_CITE.test(reason)) {
      return serverText('note-rejected-cite-required', {});
    }
    const blocked = runWhy(cited, runs);
    if (blocked) return blocked;
    // Зелёный прогон, прощённый `runWhy`, здесь держит: красного до старта в нём нет.
    const loose = cited.filter((id) => !runs.baseline.has(id));
    if (loose.length > 0)
      return serverText('note-rejected-not-baseline', { runs: loose.join(', ') });
    return undefined;
  }
  return runWhy(cited, runs);
}

/**
 * Причины прогонов, на которые сослалась строка и которые держат, — через «; ».
 * Зелёный прогон рядом с прогоном, где красное не из-за ветки, — довод в пользу
 * строки («кейсы ветки зелёные»), а не против неё (g9 27.10, #g9:1296). Сита
 * безопасности и данных требуют красного до старта от каждого прогона — это
 * проверка `baseline` в `notBranchRejection`.
 */
function runWhy(cited: readonly string[], runs: CitedRuns): string | undefined {
  const shown = cited.some((id) => runs.shows.has(id));
  const reasons = [...new Set(cited)]
    .filter((id) => runs.blocking.has(id) && !(shown && runs.green.has(id)))
    .map((id) => runs.why.get(id) ?? serverText('note-rejected-run-missing', { run: id }));
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

/** Почему прогон-ссылка держит строку: нет его, красное задела ветка, красного нет вовсе. */
function citeHolds(
  id: string,
  parts: { ours: readonly string[]; notOurs: readonly string[] } | undefined,
): string | undefined {
  if (!parts) return serverText('note-rejected-run-missing', { run: id });
  if (parts.ours.length > 0) {
    return serverText('note-rejected-run-ours', { run: id, cases: parts.ours.join(', ') });
  }
  if (parts.notOurs.length === 0) return serverText('note-rejected-run-green', { run: id });
  return undefined;
}

/** Суд прогонов-ссылок: какие держат и почему, какие показывают красное на основной. */
interface CitedRuns {
  blocking: ReadonlySet<string>;
  baseline: ReadonlySet<string>;
  /** Ссылки без единого красного кейса. */
  green: ReadonlySet<string>;
  /** Ссылки, чьё красное всё не из-за ветки, — довод строки подтверждён. */
  shows: ReadonlySet<string>;
  /** Причина, почему прогон держит, — текстом для пробела строки. */
  why: ReadonlyMap<string, string>;
}

/**
 * Красные кейсы прогонов-доказательств — по правилу «красное не из-за ветки»
 * блока «Тесты» (`redNotFromBranch`): такие из `red` уходят, держит только
 * задетое веткой. Блок не читается — прогоны остаются как есть.
 */
function triageRunRed(input: {
  cwd: string;
  proof: SieveProofFacts;
  paths: readonly string[];
  startedAt?: string;
  /** Прогоны, на которые сослались строки «не из-за ветки», — их судят тоже. */
  cited: readonly string[];
  /** Прогоны на текущей развилке с основной — то же правило, что у блока «Тесты». */
  baseRuns?: readonly ProjectTestRunRecord[];
}): CitedRuns & { notes: string[]; noted: string[] } {
  const notes: string[] = [];
  const noted: string[] = [];
  const blocking = new Set<string>();
  const baseline = new Set<string>();
  const green = new Set<string>();
  const shows = new Set<string>();
  const why = new Map<string, string>();
  const done = () => ({ notes, noted, blocking, baseline, green, shows, why });
  const runs = input.proof.runs ?? {};
  const red = Object.entries(runs).filter(([, fact]) => fact.found && fact.red.length > 0);
  // Ссылку судят всегда, даже на прогон-доказательство сита (RF-EF-02): зелёный
  // прогон-доказательство раньше проходил мимо обеих проверок.
  const cited = [...new Set(input.cited)];
  if (red.length === 0 && cited.length === 0) return done();
  let records: ProjectTestRunRecord[];
  let cause: ReturnType<typeof redNotFromBranch>;
  try {
    records = readRuns(input.cwd);
    cause = redNotFromBranch({
      groups: readGroups(input.cwd),
      runs: records,
      paths: input.paths,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.baseRuns?.length ? { baseRuns: input.baseRuns } : {}),
    });
  } catch {
    for (const id of [...red.map(([id]) => id), ...cited]) blocking.add(id);
    return done();
  }
  /**
   * Красные кейсы прогона: какие задела ветка, какие — нет, и какие из
   * незадетых были красными и до старта группы (`baseline` — красное на основной).
   */
  const split = (
    id: string,
  ): { ours: string[]; notOurs: string[]; baseline: string[] } | undefined => {
    const record = records.find((item) => item.id === id);
    if (!record) {
      // Прогон на развилке (`tests-cli base`) — в своём хранилище, не в истории
      // копии; ветки в нём нет, так что всё его красное было и до неё (g9 27.10).
      const base = input.baseRuns?.find((item) => item.id === id);
      if (!base) return undefined;
      const red = (base.results ?? [])
        .filter((result) => result.status === 'failed' || result.status === 'blocked')
        .map((result) => result.caseId);
      return { ours: [], notOurs: red, baseline: red };
    }
    const ours: string[] = [];
    const notOurs: string[] = [];
    const before: string[] = [];
    for (const result of record.results ?? []) {
      if (result.status !== 'failed' && result.status !== 'blocked') continue;
      const why = cause({ result, run: record });
      (why ? notOurs : ours).push(result.caseId);
      if (why === 'baseline') before.push(result.caseId);
    }
    return { ours, notOurs, baseline: before };
  };
  for (const [id, fact] of red) {
    const notOurs = new Set(split(id)?.notOurs ?? []);
    const left = fact.red.filter((caseId) => !notOurs.has(caseId));
    const gone = fact.red.filter((caseId) => notOurs.has(caseId));
    runs[id] = { ...fact, red: left };
    if (left.length > 0) {
      blocking.add(id);
      why.set(id, serverText('note-rejected-run-ours', { run: id, cases: left.join(', ') }));
    }
    if (gone.length > 0) {
      notes.push(serverText('sieve-note-run-red', { run: id, cases: gone.join(', ') }));
      noted.push(...gone);
    }
  }
  // Сослался на прогон, которого нет, где красное задела ветка или где красного
  // нет вовсе (RF-EF-02: «см. run:<зелёный>» — не довод), — строка держит.
  // `baseline` — прогоны, где красное было и до старта группы: только такая
  // ссылка подтверждает «красное на основной» у сит безопасности и данных.
  for (const id of cited) {
    const parts = split(id);
    const reason = citeHolds(id, parts);
    if (reason) {
      blocking.add(id);
      why.set(id, reason);
      if (parts && parts.ours.length === 0 && parts.notOurs.length === 0) green.add(id);
    } else {
      shows.add(id);
      if (parts?.baseline.length) baseline.add(id);
    }
  }
  return done();
}

/**
 * Место абзаца сит в задании звена. Планировщики звеньев синхронные — их
 * событие уходит в ленту в самом конце хода, — а пути копии читаются
 * асинхронно: git на большой копии не имеет права держать сервер. Поэтому план
 * собирается с меткой, а запуск звена ждёт абзац и ставит его на место.
 */
export const SIEVE_SLOT = '<<agentdeck:sieve-slot>>';

/** Какое звено попросило абзац и что уже сдано — запомнено при сборке плана. */
export interface SieveAsk {
  stage: SieveStage;
  done: readonly SieveReportRow[];
}

/** Метка — абзацем; пустой абзац уносит метку вместе с пустыми строками перед ней. */
export function fillSieveSlot(prompt: string, paragraph: string): string {
  return paragraph
    ? prompt.replace(SIEVE_SLOT, () => paragraph)
    : prompt.replace(/\n*<<agentdeck:sieve-slot>>/, '');
}

/** Класс, в который пробел сита идёт в счёт «пойман до MR»; нет — не блокер. */
export function caughtClass(gap: SieveGap): SieveClass | undefined {
  switch (gap.code) {
    case 'sieve-gap-conflicts':
    case 'sieve-gap-foreign-removals':
      return 'integration';
    case 'sieve-gap-consumers':
      return 'consumers';
    case 'sieve-gap-lockfile':
    case 'sieve-gap-env':
      return 'integration';
    case 'sieve-gap-secrets':
      return 'security';
    case 'sieve-gap-debug':
    case 'sieve-gap-artifacts':
    case 'sieve-gap-untested':
      return 'hygiene';
    case 'sieve-gap-destructive':
      return 'data';
    case 'sieve-gap-failed':
    case 'sieve-gap-run-red':
      return BUILTIN_SIEVES.find((sieve) => sieve.id === gap.params.sieve)?.class ?? 'other';
    case 'sieve-gap-stale': {
      // Устаревшее снятие механики (Ф5): срабатывание панели так и стоит — это
      // пойманный блокер; устаревшая строка обычного сита — пробел отчёта.
      const sieve = BUILTIN_SIEVES.find((item) => item.id === gap.params.sieve);
      return sieve?.mechanical ? sieve.class : undefined;
    }
    default:
      // Несданная, устаревшая или недоказанная строка — пробел отчёта, а не
      // пойманный блокер.
      return undefined;
  }
}

export interface SieveDeliveryGaps {
  /** Строки «не хватает» — шаблоны сервера, их читает группа и хаб. */
  missing: string[];
  classes: SieveClass[];
  /** Какие проверки не сделаны (сеть, старый git) — в журнал, не в пробелы. */
  unchecked?: string[];
  /**
   * Заметки вместо пробелов: живое сито «не проверено», красное не из-за
   * ветки — на карточку и в описание MR.
   */
  notes?: string[];
  /** Что описание MR должно назвать по заметкам: id сит и кейсов. */
  noted?: string[];
  /**
   * Строки `fail`, чью метку («не проверено», «не из-за ветки») панель не
   * приняла: id → почему и что сделать. Пункт владельца отсюда берёт причину в
   * свой пробел (`ownerCoverageGaps`).
   */
  rejected?: Record<string, string>;
}

function flipLine(params: Record<string, string>): string {
  return serverText('sieve-gap-flip', {
    sieve: params.sieve ?? '',
    why: flipWhy(params.kind ?? '', params.was ?? ''),
  });
}

/** Пробелы сит группы перед «доставлено». */
export async function sieveDeliveryGaps(input: {
  cwd: string;
  startedAt?: string;
  rows: readonly SieveReportRow[];
  /** Ветка предшественника: сита судят только свои коммиты группы. */
  forkedFrom?: string;
}): Promise<SieveDeliveryGaps> {
  const facts = await readSieveFacts({
    cwd: input.cwd,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
  });
  // Без remote, основной или общей базы git-механика молчит, но сита отчёта — фокус
  // в браузере, граничный ввод — судятся по тем же путям, что попали в задание:
  // иначе такая копия сдавала бы «готово» без единой строки (ревью сит, 28.09).
  const local = facts.paths.length === 0 && facts.unchecked?.length;
  const fallback = local ? await touchedFacts(input.cwd, input.forkedFrom) : undefined;
  const paths = fallback?.paths ?? facts.paths;
  // Без удалённого git-механика молчит, но команды проекта и код без тестов
  // сети не требуют — их проверка остаётся и такой копии.
  const mechanics = fallback
    ? { ...localMechanics(input.cwd, paths), ...facts.mechanics }
    : facts.mechanics;
  const base = fallback?.base ?? facts.base;
  const proof = await sieveProofFacts({
    cwd: input.cwd,
    rows: input.rows,
    ...(facts.commits && !fallback ? { commits: facts.commits } : {}),
    ...(base ? { base } : {}),
    branchPaths: paths,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
  });
  // Красное не из-за ветки в прогонах-доказательствах — до судьи: сито держит
  // только то, что задела ветка (решение владельца 23.10).
  const baseRuns = await baseRunsOf(input.cwd).catch(() => []);
  const cite = (evidence: string): string[] =>
    citedRunIds(evidence, (id) => {
      if (baseRuns.some((run) => run.id === id)) return true;
      try {
        return readRun(input.cwd, id) !== undefined;
      } catch {
        return false;
      }
    });
  const runRed = triageRunRed({
    cwd: input.cwd,
    proof,
    paths,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(baseRuns.length > 0 ? { baseRuns } : {}),
    cited: input.rows
      .filter((row) => row.status === 'fail' && NOT_BRANCH_MARK.test(row.evidence))
      .flatMap((row) => cite(row.evidence)),
  });
  const { notes: marked, rejected } = noteRows(input.rows, runRed, cite);
  const gaps = judgeSieves({
    applicable: applicableSieves(paths),
    rows: input.rows,
    mechanics,
    proof,
  }).filter((gap) => {
    const note = gap.params.sieve ? marked.get(gap.params.sieve) : undefined;
    if (!note) return true;
    // «Не проверено» живого сита снимает все его пробелы по строке; «не из-за
    // ветки» — только сам `fail`.
    return note.kind === 'unchecked' ? false : gap.code !== 'sieve-gap-failed';
  });
  const classes = [
    ...new Set(gaps.map(caughtClass).filter((cls): cls is SieveClass => Boolean(cls))),
  ];
  const notes = [...[...marked.values()].map((note) => note.text), ...runRed.notes];
  const noted = [...marked.keys(), ...runRed.noted];
  return {
    missing: gaps.map((gap) => {
      const why =
        gap.code === 'sieve-gap-failed' ? rejected.get(gap.params.sieve ?? '') : undefined;
      if (why) return serverText('sieve-gap-note-rejected', { ...gap.params, why });
      return gap.code === 'sieve-gap-flip'
        ? flipLine(gap.params)
        : serverText(gap.code, gap.params);
    }),
    classes,
    ...(facts.unchecked ? { unchecked: facts.unchecked } : {}),
    ...(notes.length > 0 ? { notes, noted } : {}),
    ...(rejected.size > 0 ? { rejected: Object.fromEntries(rejected) } : {}),
  };
}
