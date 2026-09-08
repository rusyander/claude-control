import type {
  ProjectTestAutomation,
  ProjectTestBulkInput,
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestDefect,
  ProjectTestDefectState,
  ProjectTestFailure,
  ProjectTestFilter,
  ProjectTestGroup,
  ProjectTestKind,
  ProjectTestLink,
  ProjectTestParameter,
  ProjectTestPriority,
  ProjectTestReadiness,
  ProjectTestStatus,
  ProjectTestStep,
} from '@agentdeck/contracts';
import { toStatus, toSteps, stepText } from '@agentdeck/contracts/test-format';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  TESTS_DIR,
  assertId,
  optional,
  stringList,
  text,
} from './files.ts';
import {
  SECTION_SPLIT_THRESHOLD,
  assertNotPart,
  groupFileExists,
  groupIndexFile,
  listGroupIds,
  readGroupSource,
  removeGroupFiles,
  writeGroupSource,
} from './group-files.ts';
import { readSchema, readSharedSteps } from './library.ts';

/**
 * Файлы тест-кейсов в `.agent/tests/` проверяемого проекта.
 *
 * Пишут сюда двое: панель (человек правит кейс руками) и агент (прогон
 * проставляет статусы, генерация заводит новые кейсы). Отсюда все решения ниже.
 *
 * Разбор ЩАДЯЩИЙ: чужой файл может быть недописан, с лишним полем или просто
 * сломан — тогда группа отдаётся с `error`, а её файл НЕ трогается. Молча
 * перезаписать сломанный JSON значит стереть работу, которую агент писал
 * полчаса, и человек об этом даже не узнает.
 *
 * Модель кейса выросла до уровня TMS (предусловия, ожидание на шаг, приоритет,
 * теги, параметры, вложения, привязка к автотесту), но СТАРЫЕ файлы читаются
 * как были: шаг строкой становится шагом-объектом, отсутствующий тип — кейсом.
 * Обратная совместимость здесь не любезность: файлы уже лежат в чужих проектах.
 */

export { TESTS_DIR, ProjectTestsError, ProjectTestsNotFoundError, SECTION_SPLIT_THRESHOLD };

/** Группы, которые панель заводит сама, если в проекте ещё ничего нет. */
export const DEFAULT_GROUPS: { id: string; title: string; description: string }[] = [
  {
    id: 'gui',
    title: 'GUI',
    description: 'Проверки интерфейса: что нажали, что увидели.',
  },
  {
    id: 'e2e',
    title: 'E2E',
    description: 'Сквозные сценарии целиком — от действия пользователя до результата в данных.',
  },
];

/** Идентификатор группы = имя файла. */
export function assertGroupId(id: string): string {
  return assertId(id, 'Идентификатор группы');
}

/** Путь файла группы от корня проекта — человеку видно, что где лежит. */
export function groupFile(id: string): string {
  return groupIndexFile(id);
}

const KINDS: ProjectTestKind[] = ['case', 'checklist'];
const PRIORITIES: ProjectTestPriority[] = ['blocker', 'high', 'medium', 'low'];
const READINESS: ProjectTestReadiness[] = ['draft', 'ready', 'obsolete'];
const AUTOMATION: ProjectTestAutomation['status'][] = ['manual', 'toAutomate', 'automated'];
const LINK_TYPES: ProjectTestLink['type'][] = ['requirement', 'issue', 'mr', 'doc'];
const DEFECT_STATES: ProjectTestDefectState[] = ['open', 'closed', 'unknown'];
const RETRIES: NonNullable<ProjectTestFailure['retry']>[] = ['confirmed', 'flaky'];

/** Значение из списка допустимых — или ничего. */
function oneOf<T extends string>(value: unknown, allowed: T[]): T | undefined {
  const word = text(value).trim() as T;
  return allowed.includes(word) ? word : undefined;
}

/** То же, но слово вне словаря — отказ с перечнем допустимых, не undefined. */
function strictValue<T extends string>(value: unknown, allowed: T[], what: string): T {
  const word = oneOf(value, allowed);
  if (!word) {
    throw new ProjectTestsError(
      `${what}: допустимо ${allowed.join(', ')}, а не «${text(value).trim()}».`,
    );
  }
  return word;
}

/** Ссылки кейса: чужой мусор отбрасывается поштучно, а не целиком. */
function parseLinks(raw: unknown): ProjectTestLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const links = raw
    .map((item): ProjectTestLink | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const url = optional(record.url);
      if (!url) return undefined;
      return {
        type: oneOf(record.type, LINK_TYPES) ?? 'doc',
        url,
        title: optional(record.title),
      };
    })
    .filter((item): item is ProjectTestLink => item !== undefined);
  return links.length > 0 ? links : undefined;
}

/** Параметры кейса: имя без `%` и список значений. */
function parseParameters(raw: unknown): ProjectTestParameter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parameters = raw
    .map((item): ProjectTestParameter | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const name = optional(record.name)?.replace(/^%/, '');
      const values = stringList(record.values);
      if (!name || values.length === 0) return undefined;
      return { name, values };
    })
    .filter((item): item is ProjectTestParameter => item !== undefined);
  return parameters.length > 0 ? parameters : undefined;
}

/** Свои поля проекта: только строковые значения, ключи как есть. */
function parseAttributes(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const item = optional(value);
    if (item) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Привязка к коду автотеста. */
function parseAutomation(raw: unknown): ProjectTestAutomation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const status = oneOf(record.status, AUTOMATION);
  const file = optional(record.file);
  const testName = optional(record.testName);
  const externalId = optional(record.externalId);
  if (!status && !file && !testName && !externalId) return undefined;
  return { status: status ?? (file ? 'automated' : 'manual'), file, testName, externalId };
}

/**
 * Разбор провала, оставленный прогоном.
 *
 * Разбирается снисходительно: агент пишет это поле руками, и «шаг 3» строкой
 * вместо числа встречается чаще, чем хотелось бы. Половина разбора лучше, чем
 * выброшенный целиком провал.
 */
function parseFailure(raw: unknown): ProjectTestFailure | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const step = Number(String(record.step ?? '').replace(/\D+/g, ''));
  const failure: ProjectTestFailure = {
    step: Number.isFinite(step) && step > 0 ? step : undefined,
    expected: optional(record.expected),
    actual: optional(record.actual),
    retry: oneOf(record.retry, RETRIES),
    retryNote: optional(record.retryNote),
  };
  return Object.values(failure).some((value) => value !== undefined) ? failure : undefined;
}

/** Дефекты, заведённые по провалам. */
function parseDefects(raw: unknown): ProjectTestCase['defects'] {
  if (!Array.isArray(raw)) return undefined;
  const defects = raw
    .map((item): ProjectTestDefect | undefined => {
      if (typeof item === 'string') {
        const url = item.trim();
        return url ? { url } : undefined;
      }
      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const url = optional(record.url);
      return url
        ? {
            url,
            title: optional(record.title),
            createdAt: optional(record.createdAt),
            key: optional(record.key),
            state: oneOf(record.state, DEFECT_STATES),
            stateLabel: optional(record.stateLabel),
            stateCheckedAt: optional(record.stateCheckedAt),
          }
        : undefined;
    })
    .filter((item): item is NonNullable<ProjectTestCase['defects']>[number] => item !== undefined);
  return defects.length > 0 ? defects : undefined;
}

/**
 * Кейс из сырых данных. Агент пишет файл руками и ошибается в мелочах: шаги
 * одной строкой вместо списка, статус словом «ok», отсутствующий id. Всё это
 * чинится здесь, потому что альтернатива — красная вкладка вместо списка.
 */
export function parseCase(raw: unknown, index: number): ProjectTestCase | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const title = text(item.title).trim();
  if (!title) return undefined;

  const steps = toSteps(item.steps) as ProjectTestStep[];
  const duration = Number(item.duration);
  const maxDiffRatio = Number(item.maxDiffRatio);

  return {
    id: text(item.id).trim() || `case-${index + 1}`,
    type: oneOf(item.type, KINDS) ?? 'case',
    title,
    purpose: optional(item.purpose),
    area: optional(item.area),
    section: optional(item.section),
    precondition: optional(item.precondition),
    steps,
    expected: optional(item.expected),
    postcondition: optional(item.postcondition),
    oracle: optional(item.oracle),
    priority: oneOf(item.priority, PRIORITIES),
    readiness: oneOf(item.readiness, READINESS),
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    tags: stringList(item.tags).length > 0 ? stringList(item.tags) : undefined,
    links: parseLinks(item.links),
    attributes: parseAttributes(item.attributes),
    parameters: parseParameters(item.parameters),
    attachments: stringList(item.attachments).length > 0 ? stringList(item.attachments) : undefined,
    automation: parseAutomation(item.automation),
    codePaths: stringList(item.codePaths).length > 0 ? stringList(item.codePaths) : undefined,
    defects: parseDefects(item.defects),
    // Порог сравнения скриншотов — доля, а не проценты: значение вне 0–1 это
    // чужая опечатка, и лучше общий порог, чем «сойдётся что угодно».
    maxDiffRatio:
      Number.isFinite(maxDiffRatio) && maxDiffRatio >= 0 && maxDiffRatio <= 1
        ? maxDiffRatio
        : undefined,
    status: toStatus(item.status) as ProjectTestStatus,
    statusId: optional(item.statusId),
    muted: item.muted === true ? true : undefined,
    muteReason: optional(item.muteReason),
    note: optional(item.note),
    failure: parseFailure(item.failure),
    lastRunAt: optional(item.lastRunAt),
    lastRunId: optional(item.lastRunId),
    source: text(item.source) === 'human' ? 'human' : 'agent',
    updatedAt: optional(item.updatedAt),
    archived: item.archived === true ? true : undefined,
  };
}

/** Одинаковые id внутри группы ломают адресацию правок — разводим их здесь. */
function withUniqueIds(cases: ProjectTestCase[]): ProjectTestCase[] {
  const seen = new Set<string>();
  return cases.map((item) => {
    let id = item.id;
    let attempt = 2;
    while (seen.has(id)) id = `${item.id}-${attempt++}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/**
 * Одна группа с диска. Файл сломан → группа с `error` и пустым списком.
 * Большой набор собирается из нескольких файлов (см. `group-files.ts`), но
 * наружу это одна вкладка — разложенность видна только полем `files`.
 */
export function readGroup(root: string, id: string): ProjectTestGroup {
  const file = groupFile(id);
  const base: ProjectTestGroup = { id, title: id.toUpperCase(), file, cases: [] };

  const source = readGroupSource(root, assertGroupId(id));
  if (source.error) return { ...base, error: source.error };

  const cases = withUniqueIds(
    source.cases
      .map((item, index) => parseCase(item, index))
      .filter((item): item is ProjectTestCase => item !== undefined),
  );

  return {
    id,
    title: text(source.title).trim() || base.title,
    description: optional(source.description),
    file,
    files: source.files.length > 1 ? source.files : undefined,
    cases,
  };
}

/** Все группы проекта. Пустой список — тестов в проекте ещё нет. */
export function readGroups(root: string): ProjectTestGroup[] {
  return listGroupIds(root).map((id) => readGroup(root, id));
}

/** Запись группы целиком. Сломанную группу писать нельзя — иначе затрём файл. */
export function writeGroup(root: string, group: ProjectTestGroup): void {
  if (group.error) throw new ProjectTestsError(group.error);
  writeGroupSource(root, assertGroupId(group.id), {
    title: group.title,
    description: group.description,
    cases: group.cases,
  });
}

/**
 * Группа, готовая к правке: сломанную возвращаем ошибкой, а не пустышкой.
 *
 * Читается ПРЯМО ПЕРЕД записью, а не берётся из ответа, показанного человеку:
 * между показом списка и нажатием «Сохранить» проходят минуты, и всё это время
 * в тот же файл пишет агент.
 */
export function loadForWrite(root: string, id: string): ProjectTestGroup {
  assertNotPart(root, assertGroupId(id));
  const group = readGroup(root, id);
  if (group.error && groupFileExists(root, id)) throw new ProjectTestsError(group.error);
  return { ...group, error: undefined };
}

/**
 * Группа для правки ЧЕЛОВЕКОМ: файла нет — 404, а не тихая новая вкладка.
 *
 * `loadForWrite` мягкий нарочно — черновик генерации вправе предложить кейсы
 * в группу, которой ещё нет, и применение её создаёт. Но кейс, импорт или
 * массовая правка с опечаткой в имени группы заводили вкладку «nope» с тремя
 * кейсами, и никто не понимал, откуда она.
 */
export function requireGroup(root: string, id: string): ProjectTestGroup {
  const group = loadForWrite(root, id);
  if (!groupFileExists(root, group.id)) {
    throw new ProjectTestsNotFoundError(`Группы «${id}» в проекте нет.`);
  }
  return group;
}

/** Создать группу (вкладку). Существующую не трогаем — вернём как есть. */
export function createGroup(
  root: string,
  id: string,
  title?: string,
  description?: string,
): ProjectTestGroup {
  const groupId = assertGroupId(id);
  if (groupFileExists(root, groupId)) return readGroup(root, groupId);
  const known = DEFAULT_GROUPS.find((item) => item.id === groupId);
  const group: ProjectTestGroup = {
    id: groupId,
    title: title?.trim() || known?.title || groupId.toUpperCase(),
    description: description?.trim() || known?.description,
    file: groupFile(groupId),
    cases: [],
  };
  writeGroup(root, group);
  return group;
}

/**
 * Переименовать группу или сменить её описание. Идентификатор не трогаем: он
 * же имя файла, и его смена оторвала бы группу от истории прогонов и от
 * ссылок в планах.
 */
export function updateGroup(
  root: string,
  id: string,
  title?: string,
  description?: string,
): ProjectTestGroup {
  const group = loadForWrite(root, assertGroupId(id));
  if (!groupFileExists(root, group.id)) {
    throw new ProjectTestsNotFoundError(`Группы «${id}» в проекте нет.`);
  }
  const next: ProjectTestGroup = {
    ...group,
    title: title?.trim() || group.title,
    description: description?.trim() || group.description,
  };
  writeGroup(root, next);
  return next;
}

/** Удалить группу вместе с её файлами — это осознанное действие человека. */
export function removeGroup(root: string, id: string): void {
  const groupId = assertGroupId(id);
  if (!groupFileExists(root, groupId)) {
    throw new ProjectTestsNotFoundError(`Группы «${id}» в проекте нет.`);
  }
  removeGroupFiles(root, groupId);
}

/** Свободный идентификатор кейса внутри группы. */
function nextCaseId(group: ProjectTestGroup): string {
  const used = new Set(group.cases.map((item) => item.id));
  let index = group.cases.length + 1;
  let id = `${group.id}-${String(index).padStart(3, '0')}`;
  while (used.has(id)) {
    index += 1;
    id = `${group.id}-${String(index).padStart(3, '0')}`;
  }
  return id;
}

/** Шаги из формы: строки и объекты приходят вперемешку. */
function inputSteps(steps: ProjectTestCaseInput['steps']): ProjectTestStep[] {
  return toSteps(steps ?? []) as ProjectTestStep[];
}

/**
 * Ссылка на общий шаг, которого нет, — опечатка в запросе. Форма выбирает `ref`
 * из списка, а с телефона или из скрипта можно прислать что угодно; при прогоне
 * такой шаг раскрылся бы в пустоту, и агент шёл бы дальше, будто его не было.
 */
function assertRefs(root: string, steps: ProjectTestStep[]): void {
  const refs = steps.map((step) => step.ref?.trim()).filter((ref): ref is string => !!ref);
  if (refs.length === 0) return;
  const known = new Set(readSharedSteps(root).map((step) => step.id));
  const missing = refs.find((ref) => !known.has(ref));
  if (missing) throw new ProjectTestsError(`Общего шага «${missing}» в проекте нет.`);
}

/**
 * Проверка своих полей проекта при правке ИЗ ПАНЕЛИ.
 *
 * Ровно то, ради чего свои поля заводят: поле, объявленное обязательным,
 * должно быть заполнено, а список — содержать одно из своих значений. Иначе
 * «обязательное поле» остаётся подписью в форме, и в наборе снова заводятся
 * кейсы без компонента и без версии.
 *
 * Файлы, написанные агентом руками, сюда не попадают: их читают щадяще, и
 * ронять из-за незаполненного поля весь раздел было бы хуже, чем пустое поле.
 */
function assertAttributes(root: string, attributes?: Record<string, string>): void {
  const schema = readSchema(root);
  if (schema.attributes.length === 0) return;
  const values = attributes ?? {};
  for (const field of schema.attributes) {
    const value = values[field.key]?.trim();
    if (field.required && !value) {
      throw new ProjectTestsError(`Поле «${field.title}» обязательно.`);
    }
    if (
      value &&
      field.type === 'select' &&
      field.options?.length &&
      !field.options.includes(value)
    ) {
      throw new ProjectTestsError(
        `Поле «${field.title}»: допустимые значения — ${field.options.join(', ')}.`,
      );
    }
    if (value && field.type === 'number' && !Number.isFinite(Number(value))) {
      throw new ProjectTestsError(`Поле «${field.title}» — это число.`);
    }
  }
}

/**
 * Поле, которого в запросе НЕТ, берётся с диска.
 *
 * В этом вся разница между «сохранить кейс» и «перезаписать кейс». Форма панели
 * знает не про все поля (их два десятка, и агент заполняет часть сам), а пока
 * человек держал её открытой, тот же кейс мог дополнить прогон. Отсутствующее
 * поле — «не трогай», явно пустое (`""`, `[]`) — «очисти».
 */
function patchText(value: unknown, previous?: string): string | undefined {
  return value === undefined ? previous : optional(value);
}

function patchList<T>(value: T[] | undefined, previous?: T[]): T[] | undefined {
  if (value === undefined) return previous;
  return value.length > 0 ? value : undefined;
}

/**
 * Создать или обновить кейс. Правка из панели помечает кейс человеческим:
 * агенту велено такие не удалять, иначе он снесёт то, что человек только что
 * дописал, посчитав это своим устаревшим кейсом.
 *
 * Правка сводится ПО `id` с тем, что лежит на диске ПРЯМО СЕЙЧАС, а не заменяет
 * кейс целиком: результат прогона (`status`, `note`, `lastRunAt`, вложения,
 * дефекты) принадлежит тому, кто гонял, и сохранение описания его не стирает.
 */
export function upsertCase(
  root: string,
  groupId: string,
  input: ProjectTestCaseInput,
  now: string,
): ProjectTestCase {
  const title = input.title?.trim();
  if (!title) throw new ProjectTestsError('У теста должно быть название.');

  const group = requireGroup(root, groupId);
  const existing = input.id ? group.cases.find((item) => item.id === input.id) : undefined;
  // `id` в запросе значит «правлю этот кейс»: нет такого — значит, его удалили,
  // пока форма была открыта, и молча завести его заново было бы ошибкой. Новый
  // кейс сохраняют без id, идентификатор выдаёт панель.
  if (input.id && !existing) {
    throw new ProjectTestsNotFoundError(
      `Кейса «${input.id}» в группе «${groupId}» нет: новый кейс сохраняют без id.`,
    );
  }
  assertAttributes(root, input.attributes ?? existing?.attributes);
  const steps = input.steps === undefined ? (existing?.steps ?? []) : inputSteps(input.steps);
  if (input.steps !== undefined) assertRefs(root, steps);

  const next: ProjectTestCase = {
    id: existing?.id ?? nextCaseId(group),
    type: input.type ?? existing?.type ?? 'case',
    title,
    purpose: patchText(input.purpose, existing?.purpose),
    area: patchText(input.area, existing?.area),
    section: patchText(input.section, existing?.section),
    precondition: patchText(input.precondition, existing?.precondition),
    steps,
    expected: patchText(input.expected, existing?.expected),
    postcondition: patchText(input.postcondition, existing?.postcondition),
    oracle: patchText(input.oracle, existing?.oracle),
    priority: input.priority ?? existing?.priority,
    readiness: input.readiness ?? existing?.readiness,
    duration: input.duration ?? existing?.duration,
    tags: patchList(input.tags, existing?.tags),
    links: patchList(input.links, existing?.links),
    attributes:
      input.attributes === undefined
        ? existing?.attributes
        : Object.keys(input.attributes).length > 0
          ? input.attributes
          : undefined,
    parameters: patchList(input.parameters, existing?.parameters),
    // Вложения и дефекты пишет прогон: форма про них не знает и стереть их
    // сохранением описания не может.
    attachments: patchList(input.attachments, existing?.attachments),
    automation: input.automation ?? existing?.automation,
    codePaths: patchList(input.codePaths, existing?.codePaths),
    defects: existing?.defects,
    maxDiffRatio: input.maxDiffRatio ?? existing?.maxDiffRatio,
    status: input.status ?? existing?.status ?? 'unknown',
    statusId: input.statusId ?? existing?.statusId,
    // Карантин снимается явным `false` — иначе форма, не сказавшая о нём ни
    // слова (кнопка «в архив», правка с телефона), молча выпускала бы кейс из
    // карантина и красила прогон.
    muted: input.muted ?? existing?.muted,
    muteReason: patchText(input.muteReason, existing?.muteReason),
    note: patchText(input.note, existing?.note),
    // Разбор провала принадлежит прогону, как и `note`: правка описания кейса
    // из панели не должна стирать номер шага, на котором он лёг.
    failure: existing?.failure,
    lastRunAt: existing?.lastRunAt,
    lastRunId: existing?.lastRunId,
    source: 'human',
    updatedAt: now,
    archived: input.archived ?? existing?.archived,
  };

  const cases = existing
    ? group.cases.map((item) => (item.id === next.id ? next : item))
    : [...group.cases, next];
  writeGroup(root, { ...group, cases });
  return next;
}

/** Удалить кейс. */
export function removeCase(root: string, groupId: string, caseId: string): void {
  const group = requireGroup(root, groupId);
  if (!group.cases.some((item) => item.id === caseId)) {
    throw new ProjectTestsNotFoundError(`Кейса «${caseId}» в группе «${groupId}» нет.`);
  }
  writeGroup(root, { ...group, cases: group.cases.filter((item) => item.id !== caseId) });
}

/**
 * Сбросить статусы перед полным перетестом. Без этого «пройдено» осталось бы от
 * прошлого прогона и человек не отличил бы проверенное сейчас от старого.
 */
export function resetStatuses(root: string, groupId: string, caseIds?: string[]): void {
  const group = loadForWrite(root, groupId);
  const touch = (item: ProjectTestCase): ProjectTestCase =>
    caseIds && !caseIds.includes(item.id)
      ? item
      : {
          ...item,
          status: 'unknown',
          note: undefined,
          failure: undefined,
          lastRunAt: undefined,
          lastRunId: undefined,
        };
  writeGroup(root, { ...group, cases: group.cases.map(touch) });
}

/** Результат прохода, который нужно записать в кейс. */
export interface CaseResultPatch {
  groupId: string;
  caseId: string;
  status: ProjectTestStatus;
  statusId?: string;
  note?: string;
  /** Разбор провала: номер шага, ожидание, что вышло. */
  failure?: ProjectTestFailure;
  runId?: string;
  at?: string;
  defect?: { url: string; title?: string; createdAt?: string };
  /** Доказательства прохода — пути от корня проекта; в кейсе копятся, не заменяются. */
  attachments?: string[];
}

/**
 * Проставить результаты в файлы кейсов пачкой.
 *
 * Пачкой — потому что импорт из CI приносит сотню результатов сразу, и сто
 * отдельных перезаписей одного файла означали бы сто шансов встретиться с
 * агентом на той же секунде.
 */
export function applyResults(root: string, patches: CaseResultPatch[], now: string): number {
  const byGroup = new Map<string, CaseResultPatch[]>();
  for (const patch of patches) {
    const list = byGroup.get(patch.groupId) ?? [];
    list.push(patch);
    byGroup.set(patch.groupId, list);
  }

  let applied = 0;
  for (const [groupId, list] of byGroup) {
    const group = loadForWrite(root, groupId);
    const map = new Map(list.map((patch) => [patch.caseId, patch]));
    const cases = group.cases.map((item) => {
      const patch = map.get(item.id);
      if (!patch) return item;
      applied += 1;
      const defects = patch.defect
        ? [...(item.defects ?? []), patch.defect].filter(
            (defect, index, all) => all.findIndex((other) => other.url === defect.url) === index,
          )
        : item.defects;
      return {
        ...item,
        status: patch.status,
        statusId: patch.statusId ?? item.statusId,
        note: patch.note ?? item.note,
        // Разбор описывает ПОСЛЕДНИЙ провал. Кейс, ставший зелёным, с прошлым
        // разбором на борту выглядел бы доказанным провалом, которого больше нет.
        failure:
          patch.failure ??
          (patch.status === 'failed' || patch.status === 'blocked' ? item.failure : undefined),
        attachments: patch.attachments?.length
          ? [...new Set([...(item.attachments ?? []), ...patch.attachments])]
          : item.attachments,
        lastRunAt: patch.at ?? now,
        lastRunId: patch.runId ?? item.lastRunId,
        defects,
      };
    });
    writeGroup(root, { ...group, cases });
  }
  return applied;
}

/** Ответ трекера про один дефект — его надо положить обратно в файл кейса. */
export interface DefectStatePatch {
  groupId: string;
  caseId: string;
  /** Адрес дефекта — им он и опознаётся в списке кейса. */
  url: string;
  state: ProjectTestDefectState;
  stateLabel?: string;
  key?: string;
}

/**
 * Записать судьбу дефектов в файлы кейсов.
 *
 * Отдельно от `applyResults`: там результат прохода, здесь ответ чужой системы.
 * Статус кейса при этом НЕ трогается — закрытый дефект означает «перепроверь»,
 * а не «пройдено»: решает это прогон, а не трекер.
 */
export function applyDefectStates(root: string, patches: DefectStatePatch[], now: string): number {
  const byGroup = new Map<string, DefectStatePatch[]>();
  for (const patch of patches) {
    const list = byGroup.get(patch.groupId) ?? [];
    list.push(patch);
    byGroup.set(patch.groupId, list);
  }

  let applied = 0;
  for (const [groupId, list] of byGroup) {
    const group = loadForWrite(root, groupId);
    const cases = group.cases.map((item) => {
      const mine = list.filter((patch) => patch.caseId === item.id);
      if (mine.length === 0 || !item.defects) return item;
      const defects = item.defects.map((defect) => {
        const patch = mine.find((one) => one.url === defect.url);
        if (!patch) return defect;
        applied += 1;
        return {
          ...defect,
          key: patch.key ?? defect.key,
          state: patch.state,
          stateLabel: patch.stateLabel,
          stateCheckedAt: now,
        };
      });
      return { ...item, defects };
    });
    writeGroup(root, { ...group, cases });
  }
  return applied;
}

/** Совпал ли кейс с фильтром. Пустой фильтр пропускает всё, кроме архива. */
export function matchesFilter(
  item: ProjectTestCase,
  groupId: string,
  filter: ProjectTestFilter,
): boolean {
  if (item.archived && !filter.includeArchived) return false;
  if (filter.muted !== undefined && (item.muted === true) !== filter.muted) return false;
  if (filter.groupIds?.length && !filter.groupIds.includes(groupId)) return false;
  if (filter.types?.length && !filter.types.includes(item.type)) return false;
  if (filter.statuses?.length && !filter.statuses.includes(item.status)) return false;
  if (filter.priorities?.length && !filter.priorities.includes(item.priority ?? 'medium')) {
    return false;
  }
  if (filter.readiness?.length && !filter.readiness.includes(item.readiness ?? 'ready')) {
    return false;
  }
  if (
    filter.automation?.length &&
    !filter.automation.includes(item.automation?.status ?? 'manual')
  ) {
    return false;
  }
  if (filter.areas?.length && !filter.areas.includes(item.area ?? '')) return false;
  if (filter.sections?.length) {
    const section = item.section ?? '';
    if (!filter.sections.some((prefix) => section === prefix || section.startsWith(`${prefix}/`))) {
      return false;
    }
  }
  if (filter.tags?.length && !filter.tags.some((tag) => item.tags?.includes(tag))) return false;
  if (filter.query) {
    const haystack = [
      item.title,
      item.purpose ?? '',
      item.area ?? '',
      item.section ?? '',
      ...item.steps.map((step) => stepText(step)),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filter.query.toLowerCase())) return false;
  }
  return true;
}

/** Кейсы всех групп, прошедшие фильтр, вместе с их группой. */
export function selectCases(
  groups: ProjectTestGroup[],
  filter: ProjectTestFilter = {},
): { groupId: string; testCase: ProjectTestCase }[] {
  const selected: { groupId: string; testCase: ProjectTestCase }[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (matchesFilter(testCase, group.id, filter)) selected.push({ groupId: group.id, testCase });
    }
  }
  return selected;
}

/** Массовое действие над отмеченными кейсами. Возвращает, скольких коснулось. */
const BULK_ACTIONS: ProjectTestBulkInput['action'][] = [
  'tag',
  'untag',
  'priority',
  'readiness',
  'automation',
  'section',
  'move',
  'duplicate',
  'archive',
  'restore',
  'mute',
  'unmute',
  'delete',
];

export function bulkCases(root: string, input: ProjectTestBulkInput, now: string): number {
  // Неизвестное действие раньше «трогало» кейсы вхолостую: штамп updatedAt
  // сдвигался у всех отмеченных, а ответ был 200 с честным touched.
  if (!BULK_ACTIONS.includes(input.action)) {
    throw new ProjectTestsError(`Неизвестное действие «${String(input.action)}».`);
  }
  const group = requireGroup(root, input.groupId);
  const ids = new Set(input.caseIds);
  if (ids.size === 0) throw new ProjectTestsError('Не выбрано ни одного теста.');
  const value = input.value?.trim();

  // Карантин без причины — тихое удаление кейса: он перестаёт красить прогон и
  // никто уже не вспомнит, чего он ждал. Единственное исключение — кейс, у
  // которого причина уже записана: повторный карантин её не стирает.
  if (input.action === 'mute' && !value) {
    const blank = group.cases.filter((item) => ids.has(item.id) && !item.muteReason?.trim());
    if (blank.length > 0) {
      throw new ProjectTestsError(
        'Карантин без причины не ставится: напишите, чего он ждёт и до каких пор.',
      );
    }
  }

  if (input.action === 'delete') {
    const cases = group.cases.filter((item) => !ids.has(item.id));
    const removed = group.cases.length - cases.length;
    writeGroup(root, { ...group, cases });
    return removed;
  }

  if (input.action === 'move') {
    if (!value) throw new ProjectTestsError('Не указана группа-приёмник.');
    const target = requireGroup(root, value);
    const moving = group.cases.filter((item) => ids.has(item.id));
    if (moving.length === 0) return 0;
    const taken = new Set(target.cases.map((item) => item.id));
    const moved = moving.map((item) => {
      let id = item.id;
      let attempt = 2;
      while (taken.has(id)) id = `${item.id}-${attempt++}`;
      taken.add(id);
      return { ...item, id, updatedAt: now };
    });
    writeGroup(root, { ...target, cases: [...target.cases, ...moved] });
    writeGroup(root, { ...group, cases: group.cases.filter((item) => !ids.has(item.id)) });
    return moved.length;
  }

  if (input.action === 'duplicate') {
    const copies: ProjectTestCase[] = [];
    const taken = new Set(group.cases.map((item) => item.id));
    for (const item of group.cases) {
      if (!ids.has(item.id)) continue;
      let id = `${item.id}-copy`;
      let attempt = 2;
      while (taken.has(id)) id = `${item.id}-copy-${attempt++}`;
      taken.add(id);
      copies.push({
        ...item,
        id,
        title: `${item.title} (копия)`,
        status: 'unknown',
        note: undefined,
        lastRunAt: undefined,
        lastRunId: undefined,
        source: 'human',
        updatedAt: now,
      });
    }
    writeGroup(root, { ...group, cases: [...group.cases, ...copies] });
    return copies.length;
  }

  // Слово вне словаря раньше проходило молча: `oneOf` отдавал undefined, и
  // «readiness: meh» СТИРАЛ готовность у всех отмеченных, а «automation: robot»
  // делал их manual. Массовая правка с опечаткой должна остановиться, а не
  // переписать сотню кейсов не тем, что просили.
  const chosen =
    input.action === 'priority'
      ? strictValue(value, PRIORITIES, 'Приоритет')
      : input.action === 'readiness'
        ? strictValue(value, READINESS, 'Готовность')
        : input.action === 'automation'
          ? strictValue(value, AUTOMATION, 'Статус автоматизации')
          : undefined;

  let touched = 0;
  const cases = group.cases.map((item) => {
    if (!ids.has(item.id)) return item;
    touched += 1;
    const next: ProjectTestCase = { ...item, updatedAt: now };
    if (input.action === 'tag' && value) {
      next.tags = [...new Set([...(item.tags ?? []), value])];
    }
    if (input.action === 'untag' && value) {
      const rest = (item.tags ?? []).filter((tag) => tag !== value);
      next.tags = rest.length > 0 ? rest : undefined;
    }
    if (input.action === 'priority') next.priority = chosen as ProjectTestPriority;
    if (input.action === 'readiness') next.readiness = chosen as ProjectTestReadiness;
    if (input.action === 'automation') {
      const status = chosen as ProjectTestAutomation['status'];
      next.automation = { ...(item.automation ?? {}), status };
    }
    if (input.action === 'section') next.section = value || undefined;
    if (input.action === 'archive') next.archived = true;
    if (input.action === 'restore') next.archived = undefined;
    if (input.action === 'mute') {
      next.muted = true;
      // Причина обязательна и проверена выше: карантин без объяснения через
      // месяц никто не решится снять — неизвестно, чего он ждал.
      next.muteReason = value || item.muteReason;
    }
    if (input.action === 'unmute') {
      next.muted = undefined;
      next.muteReason = undefined;
    }
    return next;
  });
  writeGroup(root, { ...group, cases });
  return touched;
}
