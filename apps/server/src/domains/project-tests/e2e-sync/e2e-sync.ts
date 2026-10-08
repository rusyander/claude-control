import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ProjectE2eOnboarding,
  ProjectTestCase,
  ProjectTestE2eSync,
  ProjectTestGroup,
} from '@agentdeck/contracts';
import { slugify } from '../../../lib/slug.ts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { ProjectTestsError } from '../files.ts';
import { groupFile, loadForWrite, readGroups, writeGroup } from '../store/store.ts';
import {
  createE2eFolder,
  e2eDirOf,
  e2eFolderView,
  RUNNER_OUTPUT_DIRS,
  SKIP_DIRS,
  specFiles,
} from '../e2e-folder/e2e-folder.ts';
import { parseSpec, type ParsedSpec, type ParsedTest } from '../e2e-parse.ts';
import { parsePytest } from '../e2e-parse-pytest.ts';

/**
 * Сверка папки e2e с кейсами: новые тесты становятся кейсами, у знакомых
 * обновляется привязка к коду.
 *
 * Идемпотентна: второй вызов на той же папке не меняет ни байта. Кейс находится
 * по тому же, по чему потом сводятся результаты (`import-results.ts`): метка
 * `[id]` в имени теста, затем файл + полное имя. Поэтому тест, сведённый здесь,
 * получает свой результат из junit без второй настройки.
 *
 * Описание кейса — работа человека или агента, и сверка его НЕ переписывает:
 * пустое поле она заполняет из сценария в коде, заполненное остаётся. Удалённый
 * из кода тест кейс не удаляет — он возвращается в `missing`, решать человеку.
 */

/** Полное имя теста — так его пишет junit Playwright: `describe › тест`. */
export function fullTestName(test: ParsedTest): string {
  return test.testName || [...test.titlePath, test.title].join(' › ');
}

/** Разобрать файл тестов по его виду: модуль pytest или спека JavaScript. */
export function parseSpecFile(file: string, text: string): ParsedSpec {
  return file.endsWith('.py') ? parsePytest(text, file) : parseSpec(text);
}

const norm = (value: string): string =>
  value.trim().toLowerCase().replace(/[›»>]/g, '>').replace(/\s+/g, ' ');

const CASE_ID = /^[\p{L}\p{N}_-]{1,40}$/u;

/** Группа по файлу: `e2e/auth/login.spec.ts` → `login`. */
export function groupIdOfFile(file: string): string {
  const stem = basename(file)
    .replace(/\.(spec|test|e2e|cy)\.[^.]+$/, '')
    // Дефис — тоже часть имени: группа `user-profile` не должна уходить в `test-user-profile-py`.
    .replace(/^test_([\w-]+)\.py$|^([\w-]+)_test\.py$/, '$1$2');
  const slug = slugify(stem, 40).replace(/^-+/, '');
  return /^[a-z0-9]/.test(slug) ? slug : 'e2e';
}

function nextId(groupId: string, used: Set<string>, taken?: Set<string>): string {
  let index = used.size + 1;
  let id = `${groupId}-${String(index).padStart(3, '0')}`;
  while (used.has(id) || taken?.has(id)) {
    index += 1;
    id = `${groupId}-${String(index).padStart(3, '0')}`;
  }
  return id;
}

interface Located {
  groupId: string;
  item: ProjectTestCase;
}

/** Где уже лежит кейс этого теста: по метке, затем по файлу и полному имени. */
function locate(groups: ProjectTestGroup[], file: string, test: ParsedTest): Located | undefined {
  const name = norm(fullTestName(test));
  // Метка из ЭТОГО файла — раньше чужой: одна метка в двух файлах (копипаста)
  // иначе перетягивала первый кейс туда-сюда между файлами на каждой сверке.
  for (const group of groups) {
    for (const item of group.cases) {
      const auto = item.automation;
      if (test.id && auto?.externalId === test.id && auto.file === file) {
        return { groupId: group.id, item };
      }
    }
  }
  for (const group of groups) {
    for (const item of group.cases) {
      const auto = item.automation;
      if (auto?.file === file && auto.testName && norm(auto.testName) === name) {
        return { groupId: group.id, item };
      }
      // Кейс с тем же id, ещё не привязанный к коду или привязанный к этому файлу:
      // агент завёл кейс черновиком и написал тест с его меткой.
      if (test.id && item.id === test.id && (!auto?.file || auto.file === file)) {
        return { groupId: group.id, item };
      }
    }
  }
  // Метка ушла в другой файл (переименование): кейс идёт следом.
  for (const group of groups) {
    for (const item of group.cases) {
      if (test.id && item.automation?.externalId === test.id) return { groupId: group.id, item };
    }
  }
  return undefined;
}

/** `item` с полями, которые отличают `next` от `before`. */
function withChanges(
  item: ProjectTestCase,
  before: ProjectTestCase,
  next: ProjectTestCase,
): ProjectTestCase {
  const out: Record<string, unknown> = { ...item };
  const was = before as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(was[key])) out[key] = value;
  }
  return out as unknown as ProjectTestCase;
}

/** Привязка к коду + пустые поля из сценария. `undefined` — менять нечего. */
function patched(item: ProjectTestCase, file: string, test: ParsedTest, now: string) {
  const automation = {
    ...item.automation,
    status: 'automated' as const,
    file,
    testName: fullTestName(test),
    ...(test.id ? { externalId: test.id } : {}),
  };
  const next: ProjectTestCase = {
    ...item,
    automation,
    ...(item.steps.length === 0 && test.steps.length > 0
      ? { steps: test.steps.map((action) => ({ action })) }
      : {}),
    ...(!item.precondition && test.precondition ? { precondition: test.precondition } : {}),
    ...(!item.expected && test.expected ? { expected: test.expected } : {}),
  };
  if (JSON.stringify(next) === JSON.stringify(item)) return undefined;
  return { ...next, updatedAt: now };
}

function newCase(id: string, file: string, test: ParsedTest, now: string): ProjectTestCase {
  return {
    id,
    type: 'case',
    title: test.caseTitle,
    ...(test.titlePath.length > 0 ? { section: test.titlePath.join('/') } : {}),
    ...(test.precondition ? { precondition: test.precondition } : {}),
    steps: test.steps.map((action) => ({ action })),
    ...(test.expected ? { expected: test.expected } : {}),
    ...(test.tags.length > 0 ? { tags: test.tags } : {}),
    readiness: 'ready',
    automation: {
      status: 'automated',
      file,
      testName: fullTestName(test),
      ...(test.id ? { externalId: test.id } : {}),
    },
    status: 'unknown',
    source: 'agent',
    updatedAt: now,
  };
}

/** Сверить папку e2e проекта с кейсами. `dir` не задан — папка ищется сама. */
export function syncE2eFolder(
  root: string,
  now: string,
  options: { dir?: string; appData?: string } = {},
): ProjectTestE2eSync {
  const dir = options.dir ?? e2eDirOf(root, options.appData);
  if (!dir) {
    throw coded(new ProjectTestsError('Папки e2e в проекте нет.'), 'e2e-missing');
  }
  const groups = readGroups(root);
  const known = new Set(groups.map((group) => group.id));
  const result: ProjectTestE2eSync = {
    dir,
    files: 0,
    tests: 0,
    added: 0,
    linked: 0,
    groups: [],
    skipped: [],
    missing: [],
  };
  /** Правки по группам: id кейса → новый кейс (замена или добавление). */
  const edits = new Map<string, { title?: string; cases: Map<string, ProjectTestCase> }>();
  const editOf = (groupId: string) => {
    const found = edits.get(groupId) ?? { cases: new Map<string, ProjectTestCase>() };
    edits.set(groupId, found);
    return found;
  };
  const seen = new Set<string>();
  /** Кейс, каким его прочла сверка: при записи переносится только её разница. */
  const originals = new Map<string, ProjectTestCase>();
  /** Id кейсов во ВСЕХ группах и заведённых этой сверкой: id уникален на проект. */
  const allIds = new Set(groups.flatMap((group) => group.cases.map((item) => item.id)));

  for (const file of specFiles(root, dir)) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      result.skipped.push({ file, reason: 'unreadable' });
      continue;
    }
    const spec = parseSpecFile(file, text);
    result.files += 1;
    result.tests += spec.tests.length;
    for (const item of spec.skipped)
      result.skipped.push({ file, reason: `${item.reason}:${item.line}` });

    // Файл = группа. Кейсы файла уже где-то лежат — туда же и новые.
    const linkedGroup = groups.find((group) =>
      group.cases.some((item) => item.automation?.file === file),
    );
    const target = linkedGroup?.id ?? groupIdOfFile(file);
    const broken = groups.find((group) => group.id === target && group.error);
    if (broken) {
      result.skipped.push({ file, reason: 'group-broken' });
      continue;
    }

    for (const test of spec.tests) {
      const hit = locate(groups, file, test);
      if (hit) {
        seen.add(`${hit.groupId}/${hit.item.id}`);
        const next = patched(hit.item, file, test, now);
        if (next) {
          editOf(hit.groupId).cases.set(next.id, next);
          originals.set(`${hit.groupId}/${next.id}`, hit.item);
          result.linked += 1;
        }
        continue;
      }
      const edit = editOf(target);
      if (!known.has(target)) edit.title = spec.topDescribe || target;
      const used = new Set([
        ...(groups.find((group) => group.id === target)?.cases.map((item) => item.id) ?? []),
        ...edit.cases.keys(),
      ]);
      const id =
        test.id && CASE_ID.test(test.id) && !allIds.has(test.id)
          ? test.id
          : nextId(target, used, allIds);
      allIds.add(id);
      edit.cases.set(id, newCase(id, file, test, now));
      seen.add(`${target}/${id}`);
      result.added += 1;
    }
  }

  const prefix = `${dir.replace(/\/+$/, '')}/`;
  for (const group of groups) {
    for (const item of group.cases) {
      const file = item.automation?.file;
      if (file?.startsWith(prefix) && !item.archived && !seen.has(`${group.id}/${item.id}`)) {
        result.missing.push({ groupId: group.id, caseId: item.id, file });
      }
    }
  }

  for (const [groupId, edit] of edits) {
    if (edit.cases.size === 0) continue;
    // Перечитываем прямо перед записью: между разбором и записью мог писать агент.
    const current: ProjectTestGroup = known.has(groupId)
      ? loadForWrite(root, groupId)
      : { id: groupId, title: edit.title ?? groupId, file: groupFile(groupId), cases: [] };
    // Правленый кейс — свежий с диска плюс ТОЛЬКО поля, изменённые сверкой:
    // статус, записанный агентом между разбором и записью, не затирается.
    const replaced = current.cases.map((item) => {
      const next = edit.cases.get(item.id);
      const before = originals.get(`${groupId}/${item.id}`);
      return next && before ? withChanges(item, before, next) : (next ?? item);
    });
    const present = new Set(current.cases.map((item) => item.id));
    const added = [...edit.cases.values()].filter((item) => !present.has(item.id));
    writeGroup(root, { ...current, cases: [...replaced, ...added] });
    if (!known.has(groupId)) result.groups.push(groupId);
  }
  return result;
}

/**
 * Проект только что добавлен в реестр: своя папка e2e — её тесты сразу в кейсы;
 * нет — панель заводит свою (спрятанную от git). Итог — ответ человеку, что
 * сделалось с его проектом; `undefined` — у панели нет каталога данных, и
 * заводить папку негде.
 */
export function onboardE2e(
  appData: string,
  root: string,
  now: string,
): ProjectE2eOnboarding | undefined {
  const folder = e2eFolderView(root, appData);
  if (folder.state === 'missing') {
    if (!appData) return undefined;
    const created = createE2eFolder(appData, root, now);
    return { state: 'created', dir: created.dir ?? 'e2e', excluded: created.excluded };
  }
  const dir = folder.dir ?? '';
  const found = { state: 'found' as const, dir, framework: folder.framework };
  if (!folder.dir || folder.specs === 0) return found;
  const { tests, added, groups } = syncE2eFolder(root, now, { dir: folder.dir, appData });
  return { ...found, sync: { tests, added, groups } };
}

/**
 * Менялась ли папка с момента `sinceMs`: новый или правленый файл тестов — по
 * его времени, удалённый или переименованный — по времени каталога, в котором
 * он лежал (удаление меняет время каталога, а не файла, которого уже нет).
 */
export function e2eChangedSince(root: string, dir: string, sinceMs: number): boolean {
  const cutoff = sinceMs - 1000;
  const newer = (path: string): boolean => {
    try {
      return statSync(path).mtimeMs >= cutoff;
    } catch {
      return false;
    }
  };
  const walk = (path: string, depth: number): boolean => {
    if (depth > 8) return false;
    if (newer(path)) return true;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        !SKIP_DIRS.has(entry.name) &&
        !RUNNER_OUTPUT_DIRS.has(entry.name) &&
        !entry.name.startsWith('.') &&
        walk(join(path, entry.name), depth + 1),
    );
  };
  if (walk(join(root, dir), 0)) return true;
  return specFiles(root, dir).some((file) => newer(join(root, file)));
}

/**
 * Конец хода чата: агент трогал папку e2e — её тесты сразу в кейсы, без просьбы
 * человека и без второго захода агента. Не трогал — ничего не пишется вовсе.
 */
export function syncE2eIfChanged(
  root: string,
  sinceMs: number,
  now: string,
  appData?: string,
): ProjectTestE2eSync | undefined {
  const folder = e2eFolderView(root, appData);
  if (folder.state === 'missing' || !folder.dir) return undefined;
  if (!e2eChangedSince(root, folder.dir, sinceMs)) return undefined;
  return syncE2eFolder(root, now, { dir: folder.dir, appData });
}
