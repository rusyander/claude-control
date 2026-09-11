import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ProjectTestImportResult } from '@agentdeck/contracts';
import { ProjectFileError, resolveProjectPath } from '../project-files/paths.ts';
import { ProjectTestsError } from './files.ts';
import {
  CASE_ID,
  applyRows,
  caseFieldOf,
  headerFor,
  parseRows,
  type ParsedCaseRow,
} from './import-cases.ts';

/**
 * Ручные кейсы, написанные прямо в репозитории: `QA/…/ТК-*.md`.
 *
 * Такие файлы пишет человек и правит в том же MR, что и код. Пока панель их не
 * читала, у команды было два несвязанных места правды — markdown в git и кейсы
 * панели, — и второе устаревало первым же изменением требований.
 *
 * ИДЕНТИФИКАТОР БЕРЁТСЯ ИЗ ИМЕНИ ФАЙЛА и сохраняется как есть (`ТК-012`).
 * Именно им кейс называют в разговоре, в дефекте и в MR; выдать ему свой номер
 * значило бы порвать связь ровно там, где она нужнее всего. Поэтому и повторный
 * импорт по нему же обновляет кейс, а не заводит двойника.
 *
 * СЛОВАРЬ ЗАГОЛОВКОВ ОДИН с импортом таблиц (`import-cases.ts`): раздел
 * `## Шаги` и колонка «Шаги» означают одно и то же, и разъехаться они не имеют
 * права. Отсюда же берётся разбор шагов, приоритетов и готовности.
 *
 * Формат не выдуман, а угадывается по написанному:
 *
 *   # ТК-012. Вход по одноразовому коду
 *   **Зона:** авторизация
 *   **Приоритет:** высокий
 *   ## Предусловие
 *   Пользователь зарегистрирован
 *   ## Шаги
 *   1. Открыть форму входа
 *      - Ожидание: форма открыта
 *   ## Ожидаемый результат
 *   Пользователь внутри
 *
 * Раздел, которого нет в словаре, НЕ выбрасывается: его текст уходит в «цель»
 * вместе с собственным заголовком. Человек писал его руками, и молча потерять
 * написанное хуже, чем положить не в то поле.
 */

/** Где по умолчанию лежат ручные кейсы. */
const DEFAULT_DIR = 'QA';

/** Имя файла кейса: `ТК-12.md`, `TK-12.md` — обе раскладки одинаково законны. */
const CASE_FILE = /^(?:ТК|TK)[-_ ].+\.md$/iu;

/** Насколько глубоко ходим по каталогам: дальше это уже не тестовое хозяйство. */
const MAX_DEPTH = 6;

export interface ImportManualCasesInput {
  groupId: string;
  /** Каталог внутри проекта; пусто — `QA`. */
  dir?: string;
  now?: string;
}

/**
 * Строка «ключ: значение» преамбулы. Маркер списка требует пробела после себя —
 * иначе `**Зона:**` разбирался бы как пункт списка со звёздочкой, и в значение
 * уезжали бы сами звёздочки.
 */
const FIELD_LINE = /^\s*(?:[-+]\s+|\*\s+(?!\*))?([^:|]{2,60}?)\s*:\s*(.+?)\s*$/u;

/** Разметка вокруг слова: `**Зона**`, `__Зона__`. Смысла не несёт. */
function unmark(value: string): string {
  return value.replace(/^[*_\s]+/u, '').replace(/[*_\s]+$/u, '');
}

/** Подстрочник шага: `- Ожидание: …`, `- Данные: …`. */
const STEP_DETAIL =
  /^\s{2,}(?:[-*+]\s*)?\*{0,2}\s*(ожидание|данные|expected|data)\*{0,2}\s*:\s*(.+)$/iu;

/** Заголовок раздела: `## Шаги`. */
const SECTION = /^\s{0,3}#{2,6}\s+(.+?)\s*$/u;

/** Заголовок кейса: `# ТК-012. Вход`. */
const TITLE = /^\s{0,3}#\s+(.+?)\s*$/u;

/**
 * Название без ведущего идентификатора: `ТК-012. Вход` → `Вход`.
 *
 * Номер в заголовке дублирует имя файла, и оставленный в названии он попадает в
 * каждый список и каждый отчёт дважды.
 */
function stripId(title: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`^${escaped}\\s*[.)—–:-]?\\s*`, 'iu'), '').trim() || title.trim();
}

/**
 * Номер в начале длинного имени: `ТК-042-вход-по-коду.md` → `ТК-042`.
 *
 * Файлы редко зовут одним номером: к нему дописывают название, версию или
 * «(копия)». Целиком такое имя идентификатором быть не может (длина, точки,
 * скобки, пробелы), и раньше номер в этих случаях просто пропадал — кейс
 * получал `<группа>-001`, а номер оставался дублироваться внутри заголовка.
 * Буквы и цифры подряд, между ними допустим один разделитель.
 */
const ID_PREFIX = /^(\p{L}{1,10}[-_ ]?\d{1,6})(?=[\s.,;)\]—–-]|$)/u;

/**
 * Идентификатор из имени файла: `ТК-012.md` → `ТК-012`.
 *
 * Сначала пробуем имя целиком — так `ТК-12-B` остаётся собой. Не подошло —
 * берём номер из начала. Не нашлось и его — пусто: придумывать номер за
 * человека не наше дело, кейс получит служебный.
 */
function idFromFile(file: string): string {
  const name = file.replace(/\.md$/i, '').trim();
  if (CASE_ID.test(name)) return name;
  return ID_PREFIX.exec(name)?.[1]?.trim() ?? '';
}

/** Что именно означает колонка таблицы шагов. */
type StepColumn = 'num' | 'action' | 'expected' | 'data' | 'skip';

/**
 * Слова шапки → смысл колонки. Порядок колонок в чужих файлах какой угодно:
 * «Ожидание» слева от «Действия» встречается ничуть не реже, и разбор по месту
 * молча менял бы их местами.
 */
const COLUMN_WORDS: [RegExp, StepColumn][] = [
  [/^(?:№|#|n|номер)$/iu, 'num'],
  [/^(?:шаг|действие|описание|что делаем|step|action|description)$/iu, 'action'],
  [/^(?:ожидание|ожидаемый результат|результат|expected(?: result)?|result)$/iu, 'expected'],
  [/^(?:данные|тестовые данные|data|test data)$/iu, 'data'],
];

function columnOf(cell: string): StepColumn | undefined {
  for (const [pattern, column] of COLUMN_WORDS) if (pattern.test(cell.trim())) return column;
  return undefined;
}

type TableLine = { kind: 'separator' } | { kind: 'row'; cells: string[] };

/**
 * Строка таблицы шагов, разобранная ПО МЕСТАМ.
 *
 * Раньше разбор требовал труб с обеих сторон (`slice(1, -1)`) и выбрасывал
 * пустые ячейки (`filter(Boolean)`). Оба допущения ломали настоящие файлы:
 * markdown по GitHub внешних труб не требует вовсе, а строка, у которой автор
 * забыл закрывающую трубу, опознавалась как РАЗМЕТКА — и уносила с собой
 * предыдущий шаг. Пустая же ячейка сдвигала колонки, и тестовые данные
 * оказывались ожидаемым результатом.
 *
 * `inTable` нужен, чтобы одиночная труба в тексте шага («Файл | Открыть») не
 * превращала его в таблицу: вне таблицы строка обязана либо начинаться с трубы,
 * либо иметь хотя бы две.
 */
function tableLine(line: string, inTable: boolean): TableLine | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return undefined;
  const bordered = trimmed.startsWith('|');
  if (!bordered && !inTable && trimmed.split('|').length - 1 < 2) return undefined;

  let inner = trimmed;
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  const cells = inner.split('|').map((cell) => cell.trim());
  if (cells.length < 2) return undefined;
  if (cells.every((cell) => /^:?-+:?$/.test(cell))) return { kind: 'separator' };
  return { kind: 'row', cells };
}

/** Шапка ли это: две и больше колонки названы известными словами. */
function isHeaderRow(cells: string[]): boolean {
  return cells.filter((cell) => columnOf(cell) !== undefined).length >= 2;
}

/** Смысл каждой колонки по шапке. Неузнанные пропускаются, а не угадываются. */
function columnsOf(cells: string[]): StepColumn[] {
  return cells.map((cell) => columnOf(cell) ?? 'skip');
}

/**
 * Шаг из ячеек строки. Колонки известны по шапке — иначе по местам, где первая
 * чисто числовая колонка считается нумерацией, а не действием.
 */
function stepFromCells(cells: string[], columns?: StepColumn[]): string {
  let action = '';
  let expected = '';
  let data = '';

  if (columns) {
    cells.forEach((cell, index) => {
      const column = columns[index];
      if (column === 'action' && !action) action = cell;
      if (column === 'expected' && !expected) expected = cell;
      if (column === 'data' && !data) data = cell;
    });
  } else {
    const body = /^\d+$/.test(cells[0] ?? '') ? cells.slice(1) : cells;
    [action = '', expected = '', data = ''] = body;
  }

  if (!action) return '';
  return [action, expected ? `ожидание: ${expected}` : '', data ? `данные: ${data}` : '']
    .filter(Boolean)
    .join(' · ');
}

/** Вложенный пункт под шагом: `   - ввести логин`. Продолжение, а не новый шаг. */
const NESTED_BULLET = /^\s{2,}[-*+]\s+(.+?)\s*$/u;

/**
 * Один markdown-файл → строка кейса. Разбирается через тот же `parseRows`, что
 * и таблица: собранные поля выкладываются «шапкой и строкой» и уходят в общий
 * разбор — так markdown получает и словарь приоритетов, и разбор шагов, и
 * ничего из этого не приходится повторять.
 */
export function parseManualCase(text: string, id: string): ParsedCaseRow | undefined {
  const values = new Map<keyof ParsedCaseRow, string[]>();
  const extra: string[] = [];
  let title = '';
  let current: keyof ParsedCaseRow | undefined;
  let unknownSection: string | undefined;
  /** Идём ли сейчас по таблице шагов. */
  let inTable = false;
  /** Смысл колонок текущей таблицы, если её шапка узнана. */
  let columns: StepColumn[] | undefined;
  /**
   * Ячейки первой строки таблицы, если она уже уехала шагом. На разделителе
   * шаг забирается обратно, а эти ячейки становятся шапкой — иначе смысл
   * колонок пришлось бы восстанавливать из уже собранной строки, чего сделать
   * нельзя.
   */
  let pendingHeader: string[] | undefined;

  const put = (field: keyof ParsedCaseRow, value: string): void => {
    const lines = values.get(field) ?? [];
    lines.push(value);
    values.set(field, lines);
  };

  for (const raw of text.split(/\r?\n/)) {
    const heading = SECTION.exec(raw);
    if (heading) {
      const name = heading[1] ?? '';
      current = caseFieldOf(name);
      unknownSection = current ? undefined : name;
      if (unknownSection) extra.push(`${unknownSection}:`);
      continue;
    }

    const head = TITLE.exec(raw);
    if (head && !title) {
      title = stripId(head[1] ?? '', id);
      current = undefined;
      continue;
    }

    if (current === 'steps') {
      const detail = STEP_DETAIL.exec(raw);
      const previous = values.get('steps');
      if (detail && previous && previous.length > 0) {
        const word = /данн|data/i.test(detail[1] ?? '') ? 'данные' : 'ожидание';
        previous[previous.length - 1] = `${previous[previous.length - 1]} · ${word}: ${detail[2]}`;
        continue;
      }
      // Вложенный пункт — продолжение шага, а не новый шаг. Иначе «- ввести
      // логин» становилось шагом и забирало себе ожидание предыдущего.
      const nested = NESTED_BULLET.exec(raw);
      if (nested && !inTable && previous && previous.length > 0) {
        previous[previous.length - 1] = `${previous[previous.length - 1]} · ${nested[1]}`;
        continue;
      }

      const row = tableLine(raw, inTable);
      if (row?.kind === 'separator') {
        // Разделитель шапки: строка НАД ним была заголовком колонок, а не шагом.
        if (pendingHeader) {
          if (previous) previous.pop();
          columns = columnsOf(pendingHeader);
          pendingHeader = undefined;
        }
        inTable = true;
        continue;
      }
      if (row) {
        if (!inTable) {
          inTable = true;
          // Шапку узнаём по словам, а не только по разделителю под ней: его
          // может не быть вовсе, и тогда «№ | Действие | Ожидание» уезжало
          // шагом с действием «№».
          if (isHeaderRow(row.cells)) {
            columns = columnsOf(row.cells);
            continue;
          }
          // Слова не узнаны — строку берём шагом, но помним её ячейки: если
          // следом идёт разделитель, она всё-таки была шапкой.
          pendingHeader = row.cells;
        } else {
          pendingHeader = undefined;
        }
        const step = stepFromCells(row.cells, columns);
        if (step) put('steps', step);
        continue;
      }
      inTable = false;
      columns = undefined;
      pendingHeader = undefined;
      if (raw.trim()) put('steps', raw.trim());
      continue;
    }

    if (current) {
      if (raw.trim()) put(current, raw.trim());
      continue;
    }

    if (unknownSection) {
      if (raw.trim()) extra.push(raw.trim());
      continue;
    }

    // Преамбула: только здесь строка «ключ: значение» считается полем. Внутри
    // разделов так выглядит обычный текст шага, и поле из него было бы враньём.
    const field = FIELD_LINE.exec(raw);
    const named = field ? caseFieldOf(unmark(field[1] ?? '')) : undefined;
    const value = unmark(field?.[2] ?? '');
    if (named && value) {
      put(named, value);
      continue;
    }
    if (raw.trim() && title) extra.push(raw.trim());
  }

  if (!title) return undefined;
  if (extra.length > 0) put('purpose', extra.join('\n'));

  const headers: string[] = [];
  const cells: string[] = [];
  for (const [field, lines] of values) {
    headers.push(headerFor(field));
    cells.push(lines.join('\n'));
  }
  // Название и номер приписываются ПОСЛЕДНИМИ и потому сильнее: заголовок файла
  // и его имя — это то, чем кейс зовут снаружи, а строка «Название:» в преамбуле
  // чаще всего осталась от шаблона.
  headers.push('название', 'идентификатор');
  cells.push(title, id);
  return parseRows([headers, cells])[0];
}

/** Файлы кейсов внутри каталога, вместе с их путём от корня проекта. */
function collect(dir: string, depth: number): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      found.push(...collect(path, depth + 1));
      continue;
    }
    if (entry.isFile() && CASE_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Импорт ручных кейсов проекта в одну группу.
 *
 * Раздел файла (`section`) выводится из каталога: `QA/auth/ТК-1.md` → `auth`.
 * Так дерево папок, по которому люди эти кейсы и раскладывали, переезжает в
 * панель само, а не назначается заново руками.
 */
export function importManualCases(
  root: string,
  input: ImportManualCasesInput,
): ProjectTestImportResult {
  const now = input.now ?? new Date().toISOString();
  const relativeDir = input.dir?.trim() || DEFAULT_DIR;

  let base: string;
  try {
    base = resolveProjectPath(root, relativeDir);
  } catch (error) {
    throw new ProjectTestsError(
      error instanceof ProjectFileError ? error.message : 'Каталог кейсов вне проекта.',
    );
  }
  if (!isDirectory(base)) {
    throw new ProjectTestsError(
      `Каталога «${relativeDir}» в проекте нет — укажите тот, где лежат файлы ТК-*.md.`,
    );
  }

  const files = collect(base, 0);
  if (files.length === 0) {
    throw new ProjectTestsError(
      `В «${relativeDir}» не нашлось ни одного файла вида ТК-*.md (искали и во вложенных папках).`,
    );
  }

  const rows: ParsedCaseRow[] = [];
  const unmatched: string[] = [];
  for (const file of files) {
    const id = idFromFile(file.slice(file.lastIndexOf(sep) + 1));
    const row = parseManualCase(readFileSync(file, 'utf8'), id);
    if (!row) {
      // Файл без заголовка первого уровня: названия у кейса нет, а придумывать
      // его по имени файла — это молча завести кейс «ТК-12» без смысла.
      unmatched.push(relative(root, file).split(sep).join('/'));
      continue;
    }
    const folder = relative(base, file).split(sep).slice(0, -1).join('/');
    rows.push({ ...row, section: row.section ?? (folder || undefined) });
  }

  if (rows.length === 0) {
    throw new ProjectTestsError(
      'Файлы нашлись, но ни в одном нет заголовка «# Название» — читать нечего.',
    );
  }

  const { matched, created, conflicts } = applyRows(root, input.groupId, rows, now);
  // Два файла с одним номером в разных папках — обычная ошибка раскладки, и
  // человек обязан узнать о ней здесь, а не потерей кейса через импорт.
  return {
    format: 'markdown',
    read: rows.length,
    matched,
    created,
    unmatched: [...unmatched, ...conflicts],
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
