import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ProjectTestCase,
  ProjectTestDraft,
  ProjectTestDraftApplyResult,
  ProjectTestDraftItem,
  ProjectTestDraftRollbackResult,
  ProjectTestDraftSimilar,
  ProjectTestDraftSummary,
  ProjectTestGenerateStamp,
  ProjectTestLink,
} from '@agentdeck/contracts';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  listFiles,
  optional,
  readJson,
  testsFile,
  testsPath,
  writeJson,
} from './files.ts';
import { loadForWrite, parseCase, writeGroup } from './store.ts';

/**
 * Черновик генерации: что прогон ПРЕДЛОЖИЛ добавить в библиотеку.
 *
 * До этого модуля режим `generate` правил настоящие файлы групп прямо во время
 * работы. Увидеть сделанное можно было только `git diff` (а в проекте без git —
 * никак), отменить — нечем, и на пятой генерации библиотека превращалась в
 * свалку почти одинаковых кейсов.
 *
 * Теперь прогон пишет ОДИН файл — `.agent/tests/drafts/<runId>.draft.json`, — а
 * файлы групп меняет только панель, применяя черновик. Это не вопрос доверия к
 * модели: права прогона (`run-permissions.ts`) в режиме `generate` не пускают
 * его никуда, кроме папки черновиков, поэтому галочка «принимать сразу» меняет
 * лишь то, КТО нажимает «применить», и никогда — кто пишет в библиотеку.
 *
 * Удаления в черновике нет вовсе (`op` только `add`/`update`): убрать кейс —
 * решение человека, и предлагать его прогону нечем, кроме догадки о том, что
 * функция «наверное, исчезла».
 */

/** Папка черновиков внутри `.agent/tests/`. */
const DRAFTS_DIR = 'drafts';

/** Разобранные черновики уезжают сюда: отклонённые и вытесненные по возрасту. */
const ARCHIVE_DIR = 'drafts/archive';

/** Суффикс файла черновика. */
const SUFFIX = '.draft.json';

/** Сколько черновиков держим в живой папке — остальные уезжают в архив. */
const KEEP_DRAFTS = 20;

/** Идентификатор прогона = имя файла: диапазон сужен так же, как у групп. */
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Поля, которые принадлежат ПРОГОНУ, а не описанию кейса. */
type RunOwned = Pick<
  ProjectTestCase,
  | 'status'
  | 'statusId'
  | 'note'
  | 'lastRunAt'
  | 'lastRunId'
  | 'attachments'
  | 'defects'
  | 'muted'
  | 'muteReason'
  | 'archived'
>;

/** Путь файла черновика внутри `.agent/tests/`. */
export function draftRelativePath(runId: string): string {
  return `${DRAFTS_DIR}/${assertRunId(runId)}${SUFFIX}`;
}

/** Путь файла черновика от корня проекта — его называет задание агенту. */
export function draftFile(runId: string): string {
  return testsFile(draftRelativePath(runId));
}

function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId))
    throw new ProjectTestsError(`Черновик «${runId}»: неверный идентификатор.`);
  return runId;
}

/** Идентификатор группы = имя файла; чужое слово в черновик не пускаем. */
function validGroupId(value: unknown): string | undefined {
  const id = optional(value);
  return id && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) ? id : undefined;
}

/** Похожие кейсы из черновика — их считает `similar.ts`, здесь только чтение. */
function parseSimilar(raw: unknown): ProjectTestDraftSimilar[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return undefined;
      const record = entry as Record<string, unknown>;
      const caseId = optional(record.caseId);
      const groupId = validGroupId(record.groupId);
      if (!caseId || !groupId) return undefined;
      const score = Number(record.score);
      return {
        groupId,
        caseId,
        title: optional(record.title) ?? caseId,
        score: Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0,
      };
    })
    .filter((entry): entry is ProjectTestDraftSimilar => entry !== undefined);
  return items.length > 0 ? items : undefined;
}

/**
 * Разбор одной правки. Чужой файл читается щадяще: непонятная правка
 * отбрасывается с причиной, а не роняет весь черновик.
 */
function parseItem(
  raw: unknown,
  index: number,
  warnings: string[],
): ProjectTestDraftItem | undefined {
  if (!raw || typeof raw !== 'object') {
    warnings.push(`Правка №${index + 1} не разобралась.`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const op = optional(record.op) ?? 'add';
  if (op !== 'add' && op !== 'update') {
    warnings.push(
      `Правка №${index + 1}: «${op}» черновиком не делается — удаление кейсов остаётся человеку.`,
    );
    return undefined;
  }
  const groupId = validGroupId(record.groupId);
  if (!groupId) {
    warnings.push(`Правка №${index + 1}: не названа группа.`);
    return undefined;
  }
  const testCase = parseCase(record.case ?? record.testCase, index);
  if (!testCase) {
    warnings.push(`Правка №${index + 1}: кейс без названия.`);
    return undefined;
  }
  const caseId = optional(record.caseId) ?? testCase.id;
  const state = optional(record.state);
  return {
    op,
    groupId,
    caseId,
    testCase: { ...testCase, id: caseId },
    before: parseCase(record.before, index),
    reason: optional(record.reason),
    similarTo: parseSimilar(record.similarTo),
    state:
      state === 'accepted' || state === 'rejected' || state === 'rolledBack' ? state : 'pending',
    appliedAt: optional(record.appliedAt),
  };
}

/** Состояние черновика по его правкам: пока хоть одна ждёт — он ждёт. */
function statusOf(items: ProjectTestDraftItem[], stored: unknown): ProjectTestDraft['status'] {
  if (items.some((item) => (item.state ?? 'pending') === 'pending')) return 'pending';
  if (items.length > 0 && items.every((item) => item.state === 'rolledBack')) return 'rolledBack';
  if (items.some((item) => item.state === 'accepted')) return 'applied';
  if (items.length > 0) return 'rejected';
  const value = optional(stored);
  return value === 'applied' || value === 'rejected' || value === 'rolledBack' ? value : 'pending';
}

/**
 * Один черновик с диска. Битый файл гасит только себя: возвращается черновик с
 * причиной, а не исключение — иначе одна испорченная генерация закрывала бы
 * вкладку целиком.
 */
export function readDraft(root: string, runId: string): ProjectTestDraft | undefined {
  const relative = draftRelativePath(runId);
  const file = testsFile(relative);
  const { data, error } = readJson(root, relative);
  if (error) {
    return { version: 1, runId, createdAt: '', items: [], file, status: 'pending', error };
  }
  if (!data || typeof data !== 'object') return undefined;

  const source = data as Record<string, unknown>;
  const warnings: string[] = [];
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items = rawItems
    .map((item, index) => parseItem(item, index, warnings))
    .filter((item): item is ProjectTestDraftItem => item !== undefined);

  return {
    version: 1,
    runId,
    source: optional(source.source),
    createdAt: optional(source.createdAt) ?? '',
    items,
    file,
    status: statusOf(items, source.status),
    appliedAt: optional(source.appliedAt),
    auto: source.auto === true ? true : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Черновик одной строкой — для общего вида раздела. */
export function summarizeDraft(draft: ProjectTestDraft): ProjectTestDraftSummary {
  const count = (state: string): number =>
    draft.items.filter((item) => (item.state ?? 'pending') === state).length;
  return {
    runId: draft.runId,
    createdAt: draft.createdAt,
    source: draft.source,
    status: draft.status,
    file: draft.file,
    total: draft.items.length,
    pending: count('pending'),
    accepted: count('accepted'),
    rejected: count('rejected'),
    auto: draft.auto,
    error: draft.error,
  };
}

/** Черновики проекта — от новых к старым. Архив сюда не попадает. */
export function readDrafts(root: string): ProjectTestDraft[] {
  return listFiles(root, DRAFTS_DIR, SUFFIX)
    .map((runId) => readDraft(root, runId))
    .filter((draft): draft is ProjectTestDraft => draft !== undefined)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** То же списком строк — этим живёт общий вид. */
export function readDraftSummaries(root: string): ProjectTestDraftSummary[] {
  return readDrafts(root).map(summarizeDraft);
}

/** Запись черновика: панель дописывает в него решения человека. */
export function writeDraft(root: string, draft: ProjectTestDraft): void {
  const { file: _file, error: _error, warnings: _warnings, ...rest } = draft;
  writeJson(root, draftRelativePath(draft.runId), rest);
}

/**
 * Убрать черновик из живой папки. Файл не удаляется: за ним стоит работа
 * прогона, и «отклонить» не должно означать «стереть без следа».
 */
export function archiveDraft(root: string, runId: string): void {
  const from = testsPath(root, draftRelativePath(runId));
  if (!existsSync(from)) return;
  const to = testsPath(root, `${ARCHIVE_DIR}/${runId}${SUFFIX}`);
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    // Архив — удобство: не переехало (занят файл, чужие права) — черновик
    // остаётся на месте со своим статусом, и это лучше потери.
  }
}

/** Старые разобранные черновики уезжают в архив, чтобы папка не росла вечно. */
function pruneDrafts(root: string): void {
  const drafts = readDrafts(root);
  drafts
    .filter((draft) => draft.status !== 'pending')
    .slice(KEEP_DRAFTS)
    .forEach((draft) => archiveDraft(root, draft.runId));
}

/** Что панель забирает с диска, а не из предложения агента. */
function runOwned(existing: ProjectTestCase): RunOwned {
  return {
    status: existing.status,
    statusId: existing.statusId,
    note: existing.note,
    lastRunAt: existing.lastRunAt,
    lastRunId: existing.lastRunId,
    attachments: existing.attachments,
    defects: existing.defects,
    muted: existing.muted,
    muteReason: existing.muteReason,
    archived: existing.archived,
  };
}

/** Как применить черновик: что именно и от чьего имени. */
export interface ApplyDraftOptions {
  /** Только эти кейсы; пусто — всё, что ещё ждёт решения. */
  caseIds?: string[];
  /** Принято галочкой, без просмотра человеком. */
  auto?: boolean;
  now: string;
  /** Проверка «группу не держит прогон» — её знает маршрут, а не домен. */
  assertUnlocked?: (groupId: string) => void;
  /** След источника генерации — панель проставляет его сама (`generate-sources.ts`). */
  stamp?: ProjectTestGenerateStamp;
}

/**
 * Проставить кейсу то, что следует из источника генерации.
 *
 * Панель дописывает, но не переписывает: свои ссылки и свои `codePaths` агента
 * остаются как есть — он видел кейс, а панель видит только источник. Смысл
 * ровно один: генерация «покрыть QA-42» не имеет права оставить строку матрицы
 * непокрытой из-за того, что модель забыла ссылку.
 */
function stamped(testCase: ProjectTestCase, stamp?: ProjectTestGenerateStamp): ProjectTestCase {
  if (!stamp) return testCase;
  const next = { ...testCase };

  const link = (type: ProjectTestLink['type'], url?: string, title?: string): void => {
    if (!url) return;
    const links = next.links ?? [];
    if (links.some((item) => item.url === url)) return;
    next.links = [...links, title ? { type, url, title } : { type, url }];
  };
  link('requirement', stamp.requirementUrl, stamp.requirementKey);
  link('issue', stamp.defectUrl);

  if (stamp.codePaths?.length && !next.codePaths?.length) next.codePaths = [...stamp.codePaths];
  return next;
}

/**
 * Применить черновик к библиотеке.
 *
 * Снимок прежней версии (`before`) панель делает САМА, читая диск прямо сейчас,
 * а не берёт из файла агента: откат обязан возвращать то, что было на самом
 * деле, иначе он вернёт выдумку.
 */
export function applyDraft(
  root: string,
  runId: string,
  options: ApplyDraftOptions,
): ProjectTestDraftApplyResult {
  const draft = readDraft(root, runId);
  if (!draft) throw new ProjectTestsNotFoundError(`Черновика «${runId}» в проекте нет.`);
  if (draft.error) throw new ProjectTestsError(draft.error);

  const wanted = options.caseIds?.length ? new Set(options.caseIds) : undefined;
  const skipped: { caseId: string; reason: string }[] = [];
  const targets = draft.items.filter(
    (item) => (item.state ?? 'pending') === 'pending' && (!wanted || wanted.has(item.caseId)),
  );

  const byGroup = new Map<string, ProjectTestDraftItem[]>();
  for (const item of targets) {
    const list = byGroup.get(item.groupId);
    if (list) list.push(item);
    else byGroup.set(item.groupId, [item]);
  }

  let applied = 0;
  for (const [groupId, items] of byGroup) {
    let cases: ProjectTestCase[];
    let group;
    try {
      options.assertUnlocked?.(groupId);
      group = loadForWrite(root, groupId);
      cases = [...group.cases];
    } catch (error) {
      for (const item of items)
        skipped.push({ caseId: item.caseId, reason: (error as Error).message });
      continue;
    }

    let touched = false;
    for (const item of items) {
      const existing = cases.find((entry) => entry.id === item.caseId);
      // Кейс человека галочка переписывать не имеет права: за галочкой никто не
      // смотрит, а «дополнить» и «переписать» отличает только тот, кто читает.
      if (existing?.source === 'human' && options.auto) {
        skipped.push({
          caseId: item.caseId,
          reason: 'Кейс написан человеком — правку к нему принимают руками.',
        });
        continue;
      }

      const proposed = stamped(item.testCase, options.stamp);
      const next: ProjectTestCase = existing
        ? {
            ...proposed,
            ...runOwned(existing),
            id: existing.id,
            // Автор кейса не меняется приёмкой: иначе кейс человека, дополненный
            // агентом, потерял бы защиту от удаления следующим же прогоном.
            source: existing.source,
            readiness: options.auto ? 'draft' : (item.testCase.readiness ?? existing.readiness),
            updatedAt: options.now,
          }
        : {
            ...proposed,
            // Результат прогона черновиком не приезжает: генерация описывает
            // проверки, а не проходит их.
            status: 'unknown',
            note: undefined,
            lastRunAt: undefined,
            lastRunId: undefined,
            source: 'agent',
            readiness: options.auto ? 'draft' : (item.testCase.readiness ?? 'draft'),
            updatedAt: options.now,
          };

      cases = existing
        ? cases.map((entry) => (entry.id === next.id ? next : entry))
        : [...cases, next];
      item.before = existing ? { ...existing } : undefined;
      item.op = existing ? 'update' : 'add';
      item.state = 'accepted';
      item.appliedAt = options.now;
      applied += 1;
      touched = true;
    }

    if (touched) writeGroup(root, { ...group, cases });
  }

  const next: ProjectTestDraft = {
    ...draft,
    items: draft.items,
    status: statusOf(draft.items, draft.status),
    appliedAt: applied > 0 ? options.now : draft.appliedAt,
    auto: options.auto ? true : draft.auto,
  };
  writeDraft(root, next);
  pruneDrafts(root);
  return { applied, skipped, draft: next };
}

/** Отклонить черновик целиком: правки помечаются, файл уезжает в архив. */
export function rejectDraft(root: string, runId: string): ProjectTestDraft {
  const draft = readDraft(root, runId);
  if (!draft) throw new ProjectTestsNotFoundError(`Черновика «${runId}» в проекте нет.`);
  const items = draft.items.map((item) =>
    (item.state ?? 'pending') === 'pending' ? { ...item, state: 'rejected' as const } : item,
  );
  const next: ProjectTestDraft = { ...draft, items, status: statusOf(items, 'rejected') };
  if (!draft.error) writeDraft(root, next);
  archiveDraft(root, runId);
  return next;
}

/**
 * Отменить приёмку.
 *
 * Кейс, который человек успел поправить или прогнать после приёмки, не
 * трогается: откат не имеет права стирать работу, сделанную ПОСЛЕ него. Такой
 * кейс называется в отчёте — молчаливый пропуск выглядел бы как неудавшийся
 * откат.
 */
export function rollbackDraft(
  root: string,
  runId: string,
  assertUnlocked?: (groupId: string) => void,
): ProjectTestDraftRollbackResult {
  const draft = readDraft(root, runId);
  if (!draft) throw new ProjectTestsNotFoundError(`Черновика «${runId}» в проекте нет.`);
  if (draft.error) throw new ProjectTestsError(draft.error);

  const kept: { caseId: string; reason: string }[] = [];
  let removed = 0;
  let restored = 0;

  const byGroup = new Map<string, ProjectTestDraftItem[]>();
  for (const item of draft.items) {
    if (item.state !== 'accepted') continue;
    const list = byGroup.get(item.groupId);
    if (list) list.push(item);
    else byGroup.set(item.groupId, [item]);
  }

  for (const [groupId, items] of byGroup) {
    let cases: ProjectTestCase[];
    let group;
    try {
      assertUnlocked?.(groupId);
      group = loadForWrite(root, groupId);
      cases = [...group.cases];
    } catch (error) {
      for (const item of items)
        kept.push({ caseId: item.caseId, reason: (error as Error).message });
      continue;
    }

    let touched = false;
    for (const item of items) {
      const existing = cases.find((entry) => entry.id === item.caseId);
      if (!existing) {
        kept.push({ caseId: item.caseId, reason: 'Кейса в библиотеке уже нет.' });
        item.state = 'rolledBack';
        continue;
      }
      const at = item.appliedAt ?? '';
      if (existing.lastRunAt && existing.lastRunAt > at) {
        kept.push({
          caseId: item.caseId,
          reason: 'Кейс успели прогнать — результат дороже отката.',
        });
        continue;
      }
      if (existing.updatedAt && existing.updatedAt > at) {
        kept.push({ caseId: item.caseId, reason: 'Кейс успели поправить руками.' });
        continue;
      }

      if (item.before) {
        cases = cases.map((entry) => (entry.id === item.caseId ? { ...item.before! } : entry));
        restored += 1;
      } else {
        cases = cases.filter((entry) => entry.id !== item.caseId);
        removed += 1;
      }
      item.state = 'rolledBack';
      touched = true;
    }

    if (touched) writeGroup(root, { ...group, cases });
  }

  const next: ProjectTestDraft = {
    ...draft,
    status: statusOf(draft.items, 'rolledBack'),
    appliedAt: draft.appliedAt,
  };
  writeDraft(root, next);
  if (next.status !== 'pending' && kept.length === 0) archiveDraft(root, runId);
  return { removed, restored, kept, draft: next };
}

/** Есть ли у прогона непринятый черновик — по нему панель зовёт в приёмку. */
export function pendingDraft(root: string, runId: string): ProjectTestDraft | undefined {
  const draft = readDraft(root, runId);
  return draft && draft.status === 'pending' ? draft : undefined;
}
