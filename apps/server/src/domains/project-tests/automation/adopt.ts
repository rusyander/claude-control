import { join, posix } from 'node:path';
import type {
  ProjectTestAdoptResult,
  ProjectTestCase,
  ProjectTestGroup,
} from '@agentdeck/contracts';
import { slugify } from '../../../lib/slug.ts';
import { isFile, listDir, readText, relPath } from '../../project-runner/stacks/fs-probe.ts';
import type { ImportedTestResult } from '../import-results/import-results.ts';
import { groupFile, loadForWrite, readGroups, writeGroup } from '../store/store.ts';
import { BUILD_FAILURE } from './native-reports.ts';

/**
 * «Завести кейсы» для тестов прогона без кейса.
 *
 * Бэкенд-проект приходит в раздел без единого кейса, и первый прогон рецепта
 * кладёт все результаты в «без кейса». Кейс заводится с привязкой, по которой
 * следующий прогон его найдёт: `testName` — имя с владельцем (`пакет.Тест`,
 * `класс.метод`) — голое имя совпало бы у одноимённых тестов разных пакетов и
 * отдало бы результат чужому кейсу; `file` — путь теста, по нему прогон группы
 * знает, что гнать. Файл не нашёлся — кейс без файла, а не с выдуманным путём.
 */

const JVM_SOURCES = [
  ['java', 'java'],
  ['kotlin', 'kt'],
  ['groovy', 'groovy'],
  ['scala', 'scala'],
] as const;

/** Имя без хвоста параметров pytest (`test_add[1-2]`): кейс один на все наборы. */
const bareName = (name: string): string => name.replace(/\[[^\]]*\]$/, '');

function goModulePath(base: string): string | undefined {
  return /^module\s+(\S+)/m.exec(readText(join(base, 'go.mod')) ?? '')?.[1];
}

/** Go: владелец — путь импорта пакета, файл — `*_test.go` с `func ИмяТеста(`. */
function goFile(base: string, owner: string, name: string): string | undefined {
  const module = goModulePath(base);
  if (!module || (owner !== module && !owner.startsWith(`${module}/`))) return undefined;
  const dir = join(base, ...owner.slice(module.length).split('/').filter(Boolean));
  const top = name.split('/')[0] ?? name;
  const declares = new RegExp(`^func\\s+${top.replace(/[^\w]/g, '')}\\s*\\(`, 'm');
  return listDir(dir)
    .filter((file) => file.endsWith('_test.go'))
    .map((file) => join(dir, file))
    .find((path) => declares.test(readText(path) ?? ''));
}

/** Cargo: владелец — файл набора (`src/lib.rs`), точнее — файл модуля из имени. */
function cargoFile(base: string, owner: string, name: string): string | undefined {
  if (!owner.endsWith('.rs') || !isFile(join(base, owner))) return undefined;
  const modules = name
    .split('::')
    .slice(0, -1)
    .filter((part) => part !== 'tests');
  if (owner.startsWith('src/') && modules.length > 0) {
    const tail = modules.join('/');
    for (const candidate of [`src/${tail}.rs`, `src/${tail}/mod.rs`]) {
      if (isFile(join(base, candidate))) return join(base, candidate);
    }
  }
  return join(base, owner);
}

/** pytest: владелец — модуль через точку, иногда с классом в конце. */
function pytestFile(base: string, owner: string): string | undefined {
  const parts = owner.split('.');
  for (const take of [parts.length, parts.length - 1]) {
    if (take < 1) continue;
    const path = join(base, ...parts.slice(0, take)) + '.py';
    if (isFile(path)) return path;
  }
  return undefined;
}

/** JVM: владелец — полное имя класса, файл — в `src/test/<язык>/`. */
function jvmFile(base: string, owner: string): string | undefined {
  const parts = (owner.split('$')[0] ?? owner).split('.');
  for (const [dir, ext] of JVM_SOURCES) {
    const path = join(base, 'src', 'test', dir, ...parts) + `.${ext}`;
    if (isFile(path)) return path;
  }
  return undefined;
}

function locate(root: string, bases: string[], owner: string, name: string): string | undefined {
  for (const base of bases) {
    const found =
      goFile(base, owner, name) ??
      cargoFile(base, owner, name) ??
      pytestFile(base, owner) ??
      jvmFile(base, owner);
    if (found) return relPath(root, found);
  }
  return undefined;
}

/** Группа — по файлу теста: `orders_test.go` → `orders`, `OrderTest.java` → `order`. */
function groupOf(file: string | undefined, owner: string): { id: string; title: string } {
  const stem = file
    ? posix
        .basename(file)
        .replace(/\.[^.]+$/, '')
        .replace(/_test$|Tests?$|^test_/, '')
    : (owner.split(/[./]/).pop() ?? '');
  const id = slugify(stem, 40).replace(/^-+/, '');
  return {
    id: /^[a-z0-9]/.test(id) ? id : 'autotests',
    title: file ?? (owner || 'autotests'),
  };
}

function nextId(groupId: string, taken: Set<string>): string {
  let index = 1;
  let id = `${groupId}-${String(index).padStart(3, '0')}`;
  while (taken.has(id)) {
    index += 1;
    id = `${groupId}-${String(index).padStart(3, '0')}`;
  }
  return id;
}

/**
 * Завести кейсы. `bases` — каталоги модулей (рецептов), где искать файлы
 * тестов: владелец у Go и pytest — путь от корня модуля, а не проекта.
 */
export function adoptUnmatched(
  root: string,
  results: ImportedTestResult[],
  bases: string[],
  now: string,
): ProjectTestAdoptResult {
  const groups = readGroups(root);
  const taken = new Set(groups.flatMap((group) => group.cases.map((item) => item.id)));
  const known = new Set(groups.map((group) => group.id));
  const broken = new Set(groups.filter((group) => group.error).map((group) => group.id));
  const knownNames = new Set(
    groups.flatMap((group) => group.cases.map((item) => item.automation?.testName ?? '')),
  );
  const additions = new Map<string, { title: string; cases: ProjectTestCase[] }>();
  let skipped = 0;
  let added = 0;
  const dirs = [...new Set([...bases, root])];

  for (const result of results) {
    const name = bareName(result.name.trim());
    const owner = result.owner?.trim() ?? '';
    const testName = owner ? `${owner}.${name}` : name;
    // Упавшая сборка — не тест: кейс «(build)» висел бы красным и после починки.
    if (!name || name === BUILD_FAILURE || knownNames.has(testName)) {
      skipped += 1;
      continue;
    }
    knownNames.add(testName);
    const file = locate(root, dirs, owner, name);
    const group = groupOf(file, owner);
    if (broken.has(group.id)) {
      skipped += 1;
      continue;
    }
    const id = nextId(group.id, taken);
    taken.add(id);
    const entry = additions.get(group.id) ?? { title: group.title, cases: [] };
    entry.cases.push({
      id,
      type: 'case',
      title: name,
      steps: [],
      readiness: 'ready',
      automation: { status: 'automated', testName, ...(file ? { file } : {}) },
      status: 'unknown',
      source: 'agent',
      updatedAt: now,
    });
    additions.set(group.id, entry);
    added += 1;
  }

  for (const [groupId, entry] of additions) {
    // Перечитываем прямо перед записью: между разбором и записью мог писать агент.
    const current: ProjectTestGroup = known.has(groupId)
      ? loadForWrite(root, groupId)
      : { id: groupId, title: entry.title, file: groupFile(groupId), cases: [] };
    writeGroup(root, { ...current, cases: [...current.cases, ...entry.cases] });
  }
  return { added, groups: [...additions.keys()], skipped };
}
