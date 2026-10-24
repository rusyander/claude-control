import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import {
  applicableSieves,
  BUILTIN_SIEVES,
  evidenceRunIds,
  judgeSieves,
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
import { readGroups, readRuns } from '../../project-tests/project-tests.ts';
import { redNotFromBranch } from '../tests-gate/tests-gate.ts';
import { projectChecks } from '../../project-git/project-checks.ts';
import { readSieveFacts, touchedFacts } from '../../project-git/sieve-facts/sieve-facts.ts';
import { behaviourIn, untestedCodeIn } from '../../project-git/sieve-scan/sieve-scan.ts';
import { sieveProofFacts } from '../sieve-proof/sieve-proof.ts';
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
}): Promise<string> {
  const { paths, base } = await touchedFacts(input.cwd, input.forkedFrom);
  const applicable = applicableSieves(paths);
  const learned = input.store?.forProject(input.projectPath ?? input.cwd, undefined, paths) ?? [];
  const proof = await sieveProofFacts({
    cwd: input.cwd,
    rows: input.done,
    ...(base ? { base } : {}),
    branchPaths: paths,
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

/** «Не проверено: <причина>» — в начале доказательства строки живого сита. */
const UNCHECKED_MARK = /^\s*(?:not checked|unchecked|не проверено)\s*[:—–-]\s*/i;
/** «Не из-за ветки: <почему>» — в начале доказательства строки `fail`. */
const NOT_BRANCH_MARK =
  /^\s*(?:not caused by the branch|pre-existing|не из-за ветки|красное не из-за ветки)\s*[:—–-]\s*/i;
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
 */
function noteRows(
  rows: readonly SieveReportRow[],
  blockingRuns: ReadonlySet<string>,
  baselineRuns: ReadonlySet<string>,
): Map<string, RowNote> {
  const notes = new Map<string, RowNote>();
  for (const row of rows) {
    const unchecked = UNCHECKED_MARK.exec(row.evidence);
    if (unchecked && LIVE_SIEVES.has(row.id) && row.status !== 'pass') {
      const reason = row.evidence.slice(unchecked[0].length).trim();
      if (reason) {
        const text = serverText('sieve-note-unchecked', { sieve: row.id, reason });
        notes.set(row.id, { kind: 'unchecked', text });
      }
      continue;
    }
    const notBranch = NOT_BRANCH_MARK.exec(row.evidence);
    if (notBranch && row.status === 'fail') {
      const reason = row.evidence.slice(notBranch[0].length).trim();
      const cited = evidenceRunIds(row.evidence);
      if (citeRequired(row.id)) {
        if (cited.length === 0 && !COMMAND_CITE.test(reason)) continue;
        if (!cited.every((id) => baselineRuns.has(id))) continue;
      }
      if (reason && !cited.some((id) => blockingRuns.has(id))) {
        const text = serverText('sieve-note-not-branch', { sieve: row.id, reason });
        notes.set(row.id, { kind: 'not-branch', text });
      }
    }
  }
  return notes;
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
}): { notes: string[]; noted: string[]; blocking: Set<string>; baseline: Set<string> } {
  const notes: string[] = [];
  const noted: string[] = [];
  const blocking = new Set<string>();
  const baseline = new Set<string>();
  const runs = input.proof.runs ?? {};
  const red = Object.entries(runs).filter(([, fact]) => fact.found && fact.red.length > 0);
  // Ссылку судят всегда, даже на прогон-доказательство сита (RF-EF-02): зелёный
  // прогон-доказательство раньше проходил мимо обеих проверок.
  const cited = [...new Set(input.cited)];
  if (red.length === 0 && cited.length === 0) return { notes, noted, blocking, baseline };
  let records: ProjectTestRunRecord[];
  let cause: ReturnType<typeof redNotFromBranch>;
  try {
    records = readRuns(input.cwd);
    cause = redNotFromBranch({
      groups: readGroups(input.cwd),
      runs: records,
      paths: input.paths,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    });
  } catch {
    for (const id of [...red.map(([id]) => id), ...cited]) blocking.add(id);
    return { notes, noted, blocking, baseline };
  }
  /**
   * Красные кейсы прогона: какие задела ветка, какие — нет, и какие из
   * незадетых были красными и до старта группы (`baseline` — красное на основной).
   */
  const split = (
    id: string,
  ): { ours: string[]; notOurs: string[]; baseline: string[] } | undefined => {
    const record = records.find((item) => item.id === id);
    if (!record) return undefined;
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
    if (left.length > 0) blocking.add(id);
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
    if (!parts || parts.ours.length > 0 || parts.notOurs.length === 0) blocking.add(id);
    else if (parts.baseline.length > 0) baseline.add(id);
  }
  return { notes, noted, blocking, baseline };
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
  });
  // Красное не из-за ветки в прогонах-доказательствах — до судьи: сито держит
  // только то, что задела ветка (решение владельца 23.10).
  const runRed = triageRunRed({
    cwd: input.cwd,
    proof,
    paths,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    cited: input.rows
      .filter((row) => row.status === 'fail' && NOT_BRANCH_MARK.test(row.evidence))
      .flatMap((row) => evidenceRunIds(row.evidence)),
  });
  const marked = noteRows(input.rows, runRed.blocking, runRed.baseline);
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
    missing: gaps.map((gap) => serverText(gap.code, gap.params)),
    classes,
    ...(facts.unchecked ? { unchecked: facts.unchecked } : {}),
    ...(notes.length > 0 ? { notes, noted } : {}),
  };
}
