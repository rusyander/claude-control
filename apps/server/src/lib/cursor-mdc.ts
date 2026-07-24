import { parseDocument, isMap, isSeq, isScalar, type Document } from 'yaml';
import { stripBom } from './text-form.ts';

/**
 * Правило Cursor — файл `.mdc`: YAML-frontmatter + markdown-тело.
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО (docs.cursor.com, «Rules») и потому реализовано:
 *  - правила лежат КАТАЛОГОМ: глобальный `~/.cursor/rules/`, проектный
 *    `<проект>/.cursor/rules/`; вложенные подкаталоги поддерживаются
 *    (`.cursor/rules/frontend/react.mdc`);
 *  - файл правила — `.mdc`: блок frontmatter между строками `---`, дальше
 *    markdown-тело;
 *  - во frontmatter три поля: `description` (строка), `globs` (шаблоны файлов и
 *    каталогов, несколько — через запятую), `alwaysApply` (булево: подключать
 *    правило в каждый разговор).
 *
 * ЧЕГО ЗДЕСЬ НЕТ (осознанно): любых других полей панель не ПРИДУМЫВАЕТ, но и не
 * теряет — незнакомые ключи frontmatter сохраняются при записи как есть.
 *
 * ПОЧЕМУ Document API пакета `yaml`, а не `parse` + `stringify`: frontmatter
 * пишут руками, в нём бывают комментарии и ключи, о которых панель не знает.
 * Полная пересборка стёрла бы и то, и другое. Document правит ДЕРЕВО: меняются
 * только три управляемых ключа.
 *
 * ТЕЛО ПРАВИЛА НЕ ТРОГАЕМ ВОВСЕ. Оно вырезается по закрывающему `---` и
 * возвращается в файл байт-в-байт (стиль переводов строк восстанавливает
 * `safe-io` по форме исходного файла — как и во всех прочих разделах панели).
 *
 * FAIL-CLOSED: frontmatter не разбирается как YAML-отображение, поле имеет
 * неожиданный тип (`alwaysApply` не булево, `globs` не строка и не список строк)
 * либо frontmatter отсутствует вовсе → `MdcFormatError`. Такое правило раздел
 * показывает ТОЛЬКО ДЛЯ ЧТЕНИЯ и не переписывает.
 */

/** Три задокументированных поля frontmatter, которыми управляет панель. */
export interface MdcFields {
  description?: string;
  globs?: string;
  alwaysApply?: boolean;
}

/** Разобранное правило: поля frontmatter + тело + чужие ключи frontmatter. */
export interface MdcRule {
  fields: MdcFields;
  /** Markdown-тело: всё после закрывающего `---`, без изменений. */
  body: string;
  /** Ключи frontmatter, которыми панель не управляет (сохраняются при записи). */
  otherKeys: string[];
}

/** Почему правило не разобрано: испорченный frontmatter или его отсутствие. */
export type MdcProblem = 'malformed' | 'no_frontmatter';

/**
 * Frontmatter правила не разобран → правило только для чтения.
 *
 * NB: поля объявлены ЯВНО, а не параметрами конструктора. Сервер запускается
 * `node --experimental-strip-types`, а в strip-only режиме parameter properties
 * не поддерживаются (и запрещены `erasableSyntaxOnly` в tsconfig).
 */
export class MdcFormatError extends Error {
  readonly problem: MdcProblem;

  constructor(problem: MdcProblem, message: string) {
    super(message);
    this.name = 'MdcFormatError';
    this.problem = problem;
  }
}

/** Ключи frontmatter, которыми управляет панель (в задокументированном порядке). */
export const MDC_MANAGED_KEYS = ['description', 'globs', 'alwaysApply'] as const;

/** Расширение файла правила Cursor. Всё прочее в каталоге правил CLI игнорирует. */
export const MDC_EXTENSION = '.mdc';

/** Разделитель нескольких шаблонов в `globs` — по документации это запятая. */
const GLOBS_SEPARATOR = ', ';

/** Разбитый файл: текст frontmatter и тело. `undefined` — блока frontmatter нет. */
export function splitMdc(text: string): { frontmatter: string; body: string } | undefined {
  const raw = stripBom(text);
  // Открывающий разделитель обязан быть ПЕРВОЙ строкой файла.
  const open = /^---[ \t]*\r?\n/.exec(raw);
  if (!open) return undefined;

  const rest = raw.slice(open[0].length);
  // Закрывающий — строка ровно из `---` (возможно, последняя, без перевода).
  const close = /^---[ \t]*(\r?\n|$)/m.exec(rest);
  if (!close) return undefined;

  return {
    frontmatter: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

/** Разобрать frontmatter в Document. Ошибка разбора / корень не отображение → fail-closed. */
function parseFrontmatter(text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new MdcFormatError('malformed', 'Frontmatter правила не разбирается как YAML.');
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new MdcFormatError('malformed', 'Frontmatter правила не является отображением ключей.');
  }
  return doc;
}

/** Неожиданный тип поля — форма не наша, править вслепую нельзя. */
function rejectField(key: string): never {
  throw new MdcFormatError(
    'malformed',
    `Поле «${key}» во frontmatter имеет неожиданный тип — панель такое правило не переписывает.`,
  );
}

/** Прочитать три управляемых поля из разобранного frontmatter. */
function readFields(doc: Document): MdcFields {
  const fields: MdcFields = {};

  const description = doc.get('description', true);
  if (description !== undefined && description !== null) {
    if (!isScalar(description) || typeof description.value !== 'string') rejectField('description');
    fields.description = description.value;
  }

  // `globs` по документации — шаблоны через запятую. В живых файлах встречается
  // и YAML-список: читаем обе формы, наружу отдаём единой строкой.
  const globs = doc.get('globs', true);
  if (globs !== undefined && globs !== null) {
    if (isSeq(globs)) {
      fields.globs = globs.items
        .map((item) => {
          if (!isScalar(item) || typeof item.value !== 'string') rejectField('globs');
          return item.value;
        })
        .join(GLOBS_SEPARATOR);
    } else if (isScalar(globs) && typeof globs.value === 'string') {
      fields.globs = globs.value;
    } else {
      rejectField('globs');
    }
  }

  const alwaysApply = doc.get('alwaysApply', true);
  if (alwaysApply !== undefined && alwaysApply !== null) {
    if (!isScalar(alwaysApply) || typeof alwaysApply.value !== 'boolean')
      rejectField('alwaysApply');
    fields.alwaysApply = alwaysApply.value;
  }

  return fields;
}

/** Ключи frontmatter верхнего уровня, которыми панель не управляет. */
function readOtherKeys(doc: Document): string[] {
  if (!isMap(doc.contents)) return [];
  const managed = new Set<string>(MDC_MANAGED_KEYS);
  return doc.contents.items
    .map((pair) => (isScalar(pair.key) ? String(pair.key.value) : undefined))
    .filter((key): key is string => key !== undefined && !managed.has(key));
}

/**
 * Разобрать файл `.mdc`: три поля frontmatter, тело и чужие ключи frontmatter.
 * Frontmatter отсутствует → `no_frontmatter` (такой файл Cursor как правило не
 * подхватывает, и панель его не переписывает).
 */
export function readMdcRule(text: string): MdcRule {
  const parts = splitMdc(text);
  if (!parts) {
    throw new MdcFormatError(
      'no_frontmatter',
      'В файле нет блока frontmatter между строками «---» — Cursor такое правило не подключает.',
    );
  }
  const doc = parseFrontmatter(parts.frontmatter);
  return { fields: readFields(doc), body: parts.body, otherKeys: readOtherKeys(doc) };
}

/** Стабильная проекция ЧУЖИХ ключей frontmatter — для контроля до записи. */
function otherKeysProjection(doc: Document): string {
  const raw = doc.toJS() as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}';
  const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of MDC_MANAGED_KEYS) delete rest[key];
  // Ключи сортируем: сравниваем СОДЕРЖИМОЕ, а не порядок обхода.
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** Пустое (после удаления всех ключей) отображение печатать как `{}` не надо. */
function serializeFrontmatter(doc: Document): string {
  if (doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0)) return '';
  // lineWidth: 0 — длинный список globs или описание не переносятся на новую строку.
  return doc.toString({ lineWidth: 0 });
}

/**
 * Собрать НОВЫЙ текст правила: три управляемых поля frontmatter + тело как есть.
 *
 * `original` — прежний текст файла (пустая строка = создаём новый). Комментарии
 * frontmatter, порядок ключей и все НЕуправляемые ключи сохраняются: меняются
 * только `description` / `globs` / `alwaysApply`. Пустое значение поля означает
 * «ключа быть не должно» — значений по умолчанию панель молча не пишет.
 *
 * Тело подставляется без правок; переводы строк приводятся к LF, а форму
 * исходного файла (BOM/CRLF) вернёт `safe-io` при записи.
 *
 * Перед возвратом результат ПЕРЕПРОВЕРЯЕТСЯ: он обязан разбираться, давать ровно
 * заданные поля, то же тело и ту же проекцию чужих ключей. Не сошлось →
 * `MdcFormatError`, файл не трогаем.
 */
export function writeMdcRule(original: string, fields: MdcFields, body: string): string {
  const parts = splitMdc(original);
  // Fail-closed на ВХОДЕ: существующий frontmatter обязан читаться нашей моделью.
  // Файл БЕЗ frontmatter сюда не попадает — домен отклоняет его раньше.
  const base = parts ? parts.frontmatter : '';
  const before = parseFrontmatter(base);
  const doc = parseFrontmatter(base);
  const current = readFields(before);

  // `doc.delete` на пустом документе (contents === null) бросает — у него ещё нет
  // коллекции. Удалять там нечего, поэтому вызов пропускаем.
  const dropKey = (key: string): void => {
    if (isMap(doc.contents)) doc.delete(key);
  };

  const description = fields.description?.trim() ? fields.description : undefined;
  if (description === undefined) dropKey('description');
  else doc.set('description', description);

  const globs = fields.globs?.trim() ? fields.globs : undefined;
  if (globs === undefined) dropKey('globs');
  // Значение не изменилось — узел не трогаем вовсе: так переживает правку и
  // форма записи (YAML-список остаётся списком, а не схлопывается в строку).
  else if (globs !== current.globs) doc.set('globs', globs);

  if (fields.alwaysApply === undefined) dropKey('alwaysApply');
  else doc.set('alwaysApply', fields.alwaysApply);

  const normalizedBody = body.replace(/\r\n|\r/g, '\n');
  const next = `---\n${serializeFrontmatter(doc)}---\n${normalizedBody}`;

  // Контроль ДО записи: результат разбирается, поля совпали с намерением, тело
  // не изменилось, чужие ключи frontmatter на месте.
  const check = readMdcRule(next);
  const wanted: MdcFields = {
    ...(description === undefined ? {} : { description }),
    ...(globs === undefined ? {} : { globs }),
    ...(fields.alwaysApply === undefined ? {} : { alwaysApply: fields.alwaysApply }),
  };
  if (JSON.stringify(sortFields(check.fields)) !== JSON.stringify(sortFields(wanted))) {
    throw new MdcFormatError('malformed', 'Контрольный разбор правила не совпал с намерением.');
  }
  if (check.body !== normalizedBody) {
    throw new MdcFormatError('malformed', 'Контрольный разбор изменил тело правила.');
  }
  if (
    otherKeysProjection(before) !==
    otherKeysProjection(parseFrontmatter(splitMdc(next)!.frontmatter))
  ) {
    throw new MdcFormatError('malformed', 'Контрольный разбор потерял ключи frontmatter.');
  }

  return next;
}

/** Поля в фиксированном порядке — чтобы сравнивать содержимое, а не порядок ключей. */
function sortFields(fields: MdcFields): Array<[string, unknown]> {
  return MDC_MANAGED_KEYS.filter((key) => fields[key] !== undefined).map((key) => [
    key,
    fields[key],
  ]);
}
