import { parseDocument, isMap, isScalar, type Document } from 'yaml';
import { stripBom } from './text-form.ts';

/**
 * Скилл OpenCode — файл `SKILL.md` внутри папки скилла (OPENCODE-5).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *  - скиллы лежат КАТАЛОГОМ: глобальный `~/.config/opencode/skills/`, проектный
 *    `<проект>/.opencode/skills/`; один скилл = одна папка с `SKILL.md`;
 *  - `SKILL.md` начинается с YAML-frontmatter между строками `---`, дальше
 *    markdown-тело;
 *  - распознаются РОВНО пять полей шапки: `name` (обязательное), `description`
 *    (обязательное), `license`, `compatibility`, `metadata` (карта строка→строка);
 *  - `name` обязано совпадать с именем папки и подчиняться грамматике
 *    `^[a-z0-9]+(-[a-z0-9]+)*$` длиной 1–64; `description` — 1–1024 символа.
 *
 * ЧТО ПАНЕЛЬ РЕДАКТИРУЕТ: два обязательных поля и тело. `license`,
 * `compatibility`, `metadata` и любые чужие ключи шапки она НЕ трогает — они
 * сохраняются при записи как есть и показываются только для чтения. Незнакомые
 * поля OpenCode игнорирует, но терять их панель не имеет права.
 *
 * ПОЧЕМУ Document API пакета `yaml`, а не `parse` + `stringify` (та же причина,
 * что у `lib/cursor-mdc.ts`): шапку пишут руками, в ней бывают комментарии и
 * ключи, о которых панель не знает. Полная пересборка стёрла бы и то, и другое.
 * Document правит ДЕРЕВО: меняются ровно два управляемых ключа.
 *
 * ТЕЛО СКИЛЛА НЕ ТРОГАЕМ ВОВСЕ. Оно вырезается по закрывающему `---` и
 * возвращается в файл байт-в-байт (форму файла — BOM/CRLF — восстановит
 * `safe-io` при записи, как во всех прочих разделах панели).
 *
 * FAIL-CLOSED: шапки нет, она не разбирается как отображение, поле имеет
 * неожиданный тип или обязательное поле пустое → `SkillFormatError`. Такой скилл
 * раздел показывает ТОЛЬКО ДЛЯ ЧТЕНИЯ и не переписывает.
 */

/** Имя файла скилла — задокументировано и регистр значим. */
export const SKILL_FILE_NAME = 'SKILL.md';

/** Ключи шапки, которыми управляет панель (в задокументированном порядке). */
export const SKILL_MANAGED_KEYS = ['name', 'description'] as const;

/** Грамматика имени скилла: строчные буквы/цифры, одиночные дефисы-разделители. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Границы длин полей шапки (по документации OpenCode). */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

/** Два поля шапки, которыми управляет панель. */
export interface SkillFields {
  name: string;
  description: string;
}

/** Разобранный скилл: поля шапки + тело + чужие ключи шапки. */
export interface OpencodeSkill {
  fields: SkillFields;
  /** Markdown-тело: всё после закрывающего `---`, без изменений. */
  body: string;
  /** Ключи шапки, которыми панель не управляет (сохраняются при записи). */
  otherKeys: string[];
}

/** Почему скилл не разобран. */
export type SkillProblem = 'no_frontmatter' | 'malformed' | 'missing_name' | 'missing_description';

/**
 * Шапка скилла не разобрана → скилл только для чтения.
 *
 * NB: поля объявлены ЯВНО, а не параметрами конструктора. Сервер запускается
 * `node --experimental-strip-types`, а в strip-only режиме parameter properties
 * не поддерживаются (и запрещены `erasableSyntaxOnly` в tsconfig).
 */
export class SkillFormatError extends Error {
  readonly problem: SkillProblem;

  constructor(problem: SkillProblem, message: string) {
    super(message);
    this.name = 'SkillFormatError';
    this.problem = problem;
  }
}

/** Разбитый файл: текст шапки и тело. `undefined` — блока frontmatter нет. */
export function splitSkillFile(text: string): { frontmatter: string; body: string } | undefined {
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

/** Разобрать шапку в Document. Ошибка разбора / корень не отображение → fail-closed. */
function parseFrontmatter(text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new SkillFormatError('malformed', 'Шапка скилла не разбирается как YAML.');
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new SkillFormatError('malformed', 'Шапка скилла не является отображением ключей.');
  }
  return doc;
}

/** Прочитать одно обязательное строковое поле шапки. */
function readRequired(doc: Document, key: 'name' | 'description'): string {
  const missing: SkillProblem = key === 'name' ? 'missing_name' : 'missing_description';
  const node = doc.get(key, true);
  if (node === undefined || node === null) {
    throw new SkillFormatError(missing, `В шапке скилла нет обязательного поля «${key}».`);
  }
  if (!isScalar(node) || typeof node.value !== 'string') {
    throw new SkillFormatError('malformed', `Поле «${key}» в шапке скилла — не строка.`);
  }
  if (!node.value.trim()) {
    throw new SkillFormatError(missing, `Обязательное поле «${key}» в шапке скилла пустое.`);
  }
  return node.value;
}

/** Ключи шапки верхнего уровня, которыми панель не управляет. */
function readOtherKeys(doc: Document): string[] {
  if (!isMap(doc.contents)) return [];
  const managed = new Set<string>(SKILL_MANAGED_KEYS);
  return doc.contents.items
    .map((pair) => (isScalar(pair.key) ? String(pair.key.value) : undefined))
    .filter((key): key is string => key !== undefined && !managed.has(key));
}

/**
 * Разобрать `SKILL.md`: два управляемых поля шапки, тело и чужие ключи шапки.
 * Шапки нет → `no_frontmatter` (такой файл OpenCode скиллом не считает, и панель
 * его не переписывает).
 */
export function readOpencodeSkill(text: string): OpencodeSkill {
  const parts = splitSkillFile(text);
  if (!parts) {
    throw new SkillFormatError(
      'no_frontmatter',
      'В файле нет блока frontmatter между строками «---» — OpenCode такой скилл не подключает.',
    );
  }
  const doc = parseFrontmatter(parts.frontmatter);
  return {
    fields: { name: readRequired(doc, 'name'), description: readRequired(doc, 'description') },
    body: parts.body,
    otherKeys: readOtherKeys(doc),
  };
}

/**
 * Почему имя скилла не годится, или `undefined`, если годится. Проверяется ДО
 * любой записи: имя становится именем ПАПКИ, а его грамматику OpenCode задаёт
 * жёстко.
 */
export type SkillNameProblem =
  'empty' | 'too_long' | 'leading_hyphen' | 'trailing_hyphen' | 'double_hyphen' | 'pattern';

export function checkSkillName(value: string): SkillNameProblem | undefined {
  if (!value) return 'empty';
  if (value.length > SKILL_NAME_MAX) return 'too_long';
  // Отдельные коды, чтобы интерфейс объяснял ИМЕННО нарушенное правило, а не
  // отсылал к регулярному выражению. Само выражение всё равно проверяется ниже.
  if (value.startsWith('-')) return 'leading_hyphen';
  if (value.endsWith('-')) return 'trailing_hyphen';
  if (value.includes('--')) return 'double_hyphen';
  if (!SKILL_NAME_PATTERN.test(value)) return 'pattern';
  return undefined;
}

/**
 * Годится ли описание: обязательное, не длиннее предела ЭТОГО CLI. Предел
 * приходит из каталога: у OpenCode и Qwen он не назван (берём 1024), у Kimi
 * документация говорит «однострочная сводка до 240 символов».
 */
export function checkSkillDescription(
  value: string,
  max: number = SKILL_DESCRIPTION_MAX,
): 'empty' | 'too_long' | undefined {
  if (!value.trim()) return 'empty';
  if (value.length > max) return 'too_long';
  return undefined;
}

/** Стабильная проекция ЧУЖИХ ключей шапки — для контроля до записи. */
function otherKeysProjection(doc: Document): string {
  const raw = doc.toJS() as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}';
  const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of SKILL_MANAGED_KEYS) delete rest[key];
  // Ключи сортируем: сравниваем СОДЕРЖИМОЕ, а не порядок обхода.
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Собрать НОВЫЙ текст `SKILL.md`: два управляемых поля шапки + тело как есть.
 *
 * `original` — прежний текст файла (пустая строка = создаём новый). Комментарии
 * шапки, порядок ключей и все НЕуправляемые ключи (`license`, `compatibility`,
 * `metadata`, любые чужие) сохраняются: меняются только `name` и `description`.
 *
 * Тело подставляется без правок; переводы строк приводятся к LF, а форму
 * исходного файла (BOM/CRLF) вернёт `safe-io` при записи.
 *
 * Перед возвратом результат ПЕРЕПРОВЕРЯЕТСЯ: он обязан разбираться, давать ровно
 * заданные поля, то же тело и ту же проекцию чужих ключей. Не сошлось →
 * `SkillFormatError`, файл не трогаем.
 */
export function writeOpencodeSkill(original: string, fields: SkillFields, body: string): string {
  const parts = splitSkillFile(original);
  // Fail-closed на ВХОДЕ: существующая шапка обязана читаться нашей моделью.
  // Файл БЕЗ шапки сюда не попадает — домен отклоняет его раньше.
  const base = parts ? parts.frontmatter : '';
  const before = parseFrontmatter(base);
  const doc = parseFrontmatter(base);

  doc.set('name', fields.name);
  doc.set('description', fields.description);

  const normalizedBody = body.replace(/\r\n|\r/g, '\n');
  // lineWidth: 0 — длинное описание не переносится на новую строку.
  const next = `---\n${doc.toString({ lineWidth: 0 })}---\n${normalizedBody}`;

  // Контроль ДО записи: результат разбирается, поля совпали с намерением, тело
  // не изменилось, чужие ключи шапки на месте.
  const check = readOpencodeSkill(next);
  if (check.fields.name !== fields.name || check.fields.description !== fields.description) {
    throw new SkillFormatError('malformed', 'Контрольный разбор скилла не совпал с намерением.');
  }
  if (check.body !== normalizedBody) {
    throw new SkillFormatError('malformed', 'Контрольный разбор изменил тело скилла.');
  }
  if (
    otherKeysProjection(before) !==
    otherKeysProjection(parseFrontmatter(splitSkillFile(next)!.frontmatter))
  ) {
    throw new SkillFormatError('malformed', 'Контрольный разбор потерял ключи шапки скилла.');
  }

  return next;
}
