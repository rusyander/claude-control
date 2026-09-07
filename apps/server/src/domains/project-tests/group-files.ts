import { existsSync, rmSync } from 'node:fs';
import {
  ProjectTestsError,
  assertId,
  listFiles,
  optional,
  readJson,
  testsFile,
  testsPath,
  text,
  writeJson,
} from './files.ts';

/**
 * Файлы одной группы: обычно один, а на большом наборе — несколько.
 *
 * Набор из тысячи кейсов в одном JSON — это мегабайт, который целиком читается
 * на каждый показ вкладки, целиком переписывается на каждую правку и целиком
 * встаёт в дифф одной строкой. Поэтому группа, переросшая
 * `SECTION_SPLIT_THRESHOLD`, раскладывается по СЕКЦИЯМ в соседние файлы, а
 * читается обратно одной вкладкой: секция — это то, как человек и так делит
 * набор, и правка «Чата» после разделения не трогает файл «Аналитики».
 *
 * Обратная совместимость здесь жёсткая:
 * - набор меньше порога лежит РОВНО как раньше — один файл, без единого нового
 *   ключа: проект, записанный прошлой версией, открывается неизменным;
 * - файл-часть помечен ключом `group`, а индекс перечисляет части в `parts`,
 *   поэтому часть не превращается в отдельную вкладку;
 * - сломанная часть гасит СВОЮ группу с названной причиной и НЕ переписывается —
 *   то же правило, что и для одиночного файла.
 */

/** Суффикс файла группы: по нему группа и опознаётся среди прочего в папке. */
export const SUFFIX = '.tests.json';

/**
 * После скольких кейсов группа раскладывается по секциям. Двести — это примерно
 * та граница, за которой файл перестаёт читаться человеком в ревью, а список в
 * панели всё ещё листается.
 */
export const SECTION_SPLIT_THRESHOLD = 200;

/** Сколько частей имеет смысл заводить: больше — это уже не разбиение, а свалка. */
const MAX_PARTS = 24;

/** Описание части в индексе группы. */
interface PartRef {
  id: string;
  section: string;
  file: string;
  count?: number;
}

/** Содержимое файла группы на диске — индекс или часть. */
interface GroupFileBody {
  version?: number;
  title?: unknown;
  description?: unknown;
  cases?: unknown;
  parts?: unknown;
  /** У части — идентификатор её группы; у обычного файла ключа нет. */
  group?: unknown;
  section?: unknown;
}

/** Группа, собранная из своих файлов. */
export interface GroupSource {
  title?: string;
  description?: string;
  /** Сырые кейсы в порядке чтения: разбирает их уже хранилище. */
  cases: unknown[];
  /** Файлы группы от корня проекта — первый всегда индекс. */
  files: string[];
  /** Файл не разобрался: причина словами, ничего не переписываем. */
  error?: string;
}

function bodyOf(data: unknown): GroupFileBody | undefined {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as GroupFileBody)
    : undefined;
}

function casesOf(body: GroupFileBody | undefined): unknown[] {
  return Array.isArray(body?.cases) ? body.cases : [];
}

/** Части, объявленные индексом. Чужой мусор в `parts` просто игнорируется. */
function partsOf(body: GroupFileBody | undefined): PartRef[] {
  if (!Array.isArray(body?.parts)) return [];
  return body.parts
    .map((item): PartRef | undefined => {
      const record = bodyOf(item) as Record<string, unknown> | undefined;
      const id = optional(record?.id);
      if (!id) return undefined;
      return { id, section: text(record?.section), file: testsFile(`${id}${SUFFIX}`) };
    })
    .filter((item): item is PartRef => item !== undefined);
}

/** Все идентификаторы файлов группы в папке — включая части. */
function fileIds(root: string): string[] {
  return listFiles(root, '', SUFFIX);
}

/**
 * Идентификаторы групп: файлы-части сюда не попадают, иначе кусок набора стал
 * бы отдельной вкладкой рядом со своей же группой.
 */
export function listGroupIds(root: string): string[] {
  const ids = fileIds(root);
  const claimed = new Set<string>();
  for (const id of ids) {
    const body = bodyOf(readJson(root, `${id}${SUFFIX}`).data);
    if (!body) continue;
    const owner = optional(body.group);
    // Часть знает свою группу сама — этого достаточно даже без индекса.
    if (owner && owner !== id) claimed.add(id);
    for (const part of partsOf(body)) if (part.id !== id) claimed.add(part.id);
  }
  return ids.filter((id) => !claimed.has(id));
}

/** Прочитать группу целиком: индекс плюс части. */
export function readGroupSource(root: string, id: string): GroupSource {
  const indexFile = testsFile(`${id}${SUFFIX}`);
  const { data, error } = readJson(root, `${id}${SUFFIX}`);
  if (error) return { cases: [], files: [indexFile], error };
  if (data === undefined) {
    return { cases: [], files: [indexFile], error: 'Файл не читается: файла нет.' };
  }

  const body = bodyOf(data);
  const parts = partsOf(body);
  const files = [indexFile];
  const cases = [...casesOf(body)];

  for (const part of parts) {
    files.push(part.file);
    const read = readJson(root, `${part.id}${SUFFIX}`);
    if (read.error) {
      // Часть сломана — молчать нельзя: иначе группа тихо потеряет треть
      // кейсов, а следующая запись затрёт сломанный файл целиком.
      return { cases: [], files, error: `${part.file}: ${read.error}` };
    }
    if (read.data === undefined) {
      return { cases: [], files, error: `${part.file}: файла нет, а индекс на него ссылается.` };
    }
    cases.push(...casesOf(bodyOf(read.data)));
  }

  return {
    title: optional(body?.title),
    description: optional(body?.description),
    cases,
    files,
  };
}

/** Часть имени файла из названия секции: латиница и цифры, остальное — номер. */
function slugOf(section: string, index: number): string {
  const slug = section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  return slug || `p${index + 1}`;
}

/** Верхний уровень секции: по нему и режем — «Чат/Вложения» живёт с «Чатом». */
function rootSection(value: unknown): string {
  const record = bodyOf(value) as Record<string, unknown> | undefined;
  const section = text(record?.section).trim();
  return section.split('/')[0]?.trim() ?? '';
}

/** Раскладка кейсов по секциям в порядке первого появления. */
function bySection(cases: unknown[]): Map<string, unknown[]> {
  const groups = new Map<string, unknown[]>();
  for (const item of cases) {
    const section = rootSection(item);
    const list = groups.get(section) ?? [];
    list.push(item);
    groups.set(section, list);
  }
  return groups;
}

/** Что писать: индекс и, если набор велик, части. */
interface Layout {
  index: { cases: unknown[]; parts: PartRef[] };
  parts: { id: string; section: string; cases: unknown[] }[];
}

/**
 * Как разложить набор. Меньше порога — один файл ровно прежней формы; больше и
 * секций хотя бы две — по файлу на секцию, кейсы без секции остаются в индексе.
 * Секций меньше двух — резать нечего: один большой файл лучше, чем один большой
 * файл плюс пустой индекс.
 */
function planLayout(groupId: string, cases: unknown[]): Layout {
  if (cases.length <= SECTION_SPLIT_THRESHOLD) return { index: { cases, parts: [] }, parts: [] };

  const sections = bySection(cases);
  const named = [...sections.keys()].filter((section) => section !== '');
  if (named.length < 2) return { index: { cases, parts: [] }, parts: [] };

  const taken = new Set<string>([groupId]);
  const parts: Layout['parts'] = [];
  const refs: PartRef[] = [];

  for (const [index, section] of named.slice(0, MAX_PARTS).entries()) {
    let id = `${groupId}--${slugOf(section, index)}`.slice(0, 40);
    let attempt = 2;
    while (taken.has(id)) id = `${groupId}--${slugOf(section, index)}-${attempt++}`.slice(0, 40);
    taken.add(id);
    const list = sections.get(section) ?? [];
    parts.push({ id, section, cases: list });
    refs.push({ id, section, file: testsFile(`${id}${SUFFIX}`), count: list.length });
  }

  // Всё, что не уехало в части (без секции и хвост сверх MAX_PARTS), остаётся в
  // индексе: терять кейс из-за раскладки нельзя ни при каких обстоятельствах.
  const moved = new Set(parts.map((part) => part.section));
  const rest = cases.filter((item) => !moved.has(rootSection(item)));
  return { index: { cases: rest, parts: refs }, parts };
}

/** Части, лежащие на диске сейчас, — их надо убрать, если раскладка изменилась. */
function existingParts(root: string, groupId: string): string[] {
  const body = bodyOf(readJson(root, `${groupId}${SUFFIX}`).data);
  return partsOf(body).map((part) => part.id);
}

/** Записать группу: одним файлом или по секциям, в зависимости от размера. */
export function writeGroupSource(
  root: string,
  id: string,
  group: { title?: string; description?: string; cases: unknown[] },
): string[] {
  assertId(id, 'Идентификатор группы');
  const before = existingParts(root, id);
  const layout = planLayout(id, group.cases);

  for (const part of layout.parts) {
    writeJson(root, `${part.id}${SUFFIX}`, {
      version: 1,
      // `group` делает файл частью даже в отрыве от индекса: без этого ключа
      // потерянный индекс превратил бы кусок набора в отдельную вкладку.
      group: id,
      section: part.section,
      cases: part.cases,
    });
  }

  writeJson(root, `${id}${SUFFIX}`, {
    version: 1,
    title: group.title,
    description: group.description,
    // Ключ `parts` появляется ТОЛЬКО у разложенной группы: обычный файл обязан
    // остаться байт в байт тем же, что писала прошлая версия панели.
    ...(layout.index.parts.length > 0 ? { parts: layout.index.parts } : {}),
    cases: layout.index.cases,
  });

  const kept = new Set(layout.parts.map((part) => part.id));
  for (const partId of before) {
    if (!kept.has(partId)) rmSync(testsPath(root, `${partId}${SUFFIX}`), { force: true });
  }

  return [
    testsFile(`${id}${SUFFIX}`),
    ...layout.parts.map((part) => testsFile(`${part.id}${SUFFIX}`)),
  ];
}

/** Удалить группу вместе со всеми её файлами. */
export function removeGroupFiles(root: string, id: string): void {
  const parts = existingParts(root, id);
  rmSync(testsPath(root, `${id}${SUFFIX}`), { force: true });
  for (const partId of parts) rmSync(testsPath(root, `${partId}${SUFFIX}`), { force: true });
}

/** Есть ли у группы файл (индекс) — по нему и решают, что группа существует. */
export function groupFileExists(root: string, id: string): boolean {
  return existsSync(testsPath(root, `${id}${SUFFIX}`));
}

/** Путь файла-индекса группы от корня проекта. */
export function groupIndexFile(id: string): string {
  return testsFile(`${id}${SUFFIX}`);
}

/** Часть чужой группы правится только через саму группу. */
export function assertNotPart(root: string, id: string): void {
  const body = bodyOf(readJson(root, `${id}${SUFFIX}`).data);
  const owner = optional(body?.group);
  if (owner && owner !== id) {
    throw new ProjectTestsError(`Это часть группы «${owner}» — правь её через саму группу.`);
  }
}
