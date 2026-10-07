import { parseDocument, isMap, isSeq, isScalar, type Document } from 'yaml';
import { MdcFormatError, splitMdc, type MdcFields, type MdcRule } from './cursor-mdc.ts';
import { stripBom } from './text-form.ts';
import { coded } from './server-text.ts';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';

/**
 * Правило Qwen Code — файл `.md` в `~/.qwen/rules/` (MAP 24).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО (`docs/users/features/rules.md` репозитория
 * QwenLM/qwen-code; сверено с самим CLI 0.25.0, `parseRuleFile`):
 *  - каталог обходится рекурсивно, правило — любой `*.md`;
 *  - frontmatter НЕОБЯЗАТЕЛЕН. Нет его (или нет ключа `paths`) — правило
 *    ПОСТОЯННОЕ: входит в системный промпт с первого запроса, как файл контекста;
 *  - `paths:` — шаблоны (строка или список), при правке подходящего файла правило
 *    подключается один раз за сессию; `description:` — строка о назначении;
 *  - HTML-комментарии из тела CLI вырезает сам, пустое тело — не правило.
 *
 * Отличия от `.mdc` Cursor, ради которых формат отдельный: файл без frontmatter
 * здесь полноценное правило (у Cursor — игнорируемый), шаблоны лежат в `paths`, а
 * не в `globs`, и `alwaysApply` нет вовсе — «всегда» означает «без `paths`».
 *
 * Наружу поля отдаются в форме контракта (`MdcFields`): `paths` — строкой
 * `globs` через запятую. Запятая ВНУТРИ фигурных скобок шаблона
 * (`src/**\/*.{ts,tsx}`) разделителем не считается.
 *
 * Запись — тем же Document API, что и у Cursor: меняются только `description` и
 * `paths`, комментарии и чужие ключи frontmatter остаются. Опустевший frontmatter
 * не пишется вовсе: у CLI пустой блок `---\n---` не разбирается и ушёл бы в текст
 * правила. Перед возвратом результат перечитывается (fail-closed).
 */

export const QWEN_RULE_EXTENSION = '.md';

const MANAGED = ['description', 'paths'] as const;
const PATTERNS_SEPARATOR = ', ';

/** Разбить строку шаблонов по запятым вне фигурных скобок. */
export function splitPatterns(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '{') depth += 1;
    if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((item) => item.trim()).filter(Boolean);
}

function malformed(message: string, code: ServerMessageCode): never {
  throw coded(new MdcFormatError('malformed', message), code);
}

function parseFrontmatter(text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) malformed('Frontmatter правила не разбирается как YAML.', 'mdc-yaml');
  if (doc.contents !== null && !isMap(doc.contents)) {
    malformed('Frontmatter правила не является отображением ключей.', 'mdc-not-map');
  }
  return doc;
}

function rejectField(key: string): never {
  throw new MdcFormatError(
    'malformed',
    `Поле «${key}» во frontmatter имеет неожиданный тип — панель такое правило не переписывает.`,
  );
}

function readFields(doc: Document): MdcFields {
  const fields: MdcFields = {};
  const description = doc.get('description', true);
  if (description !== undefined && description !== null) {
    if (!isScalar(description) || typeof description.value !== 'string') rejectField('description');
    fields.description = description.value;
  }
  const paths = doc.get('paths', true);
  if (paths !== undefined && paths !== null) {
    if (isSeq(paths)) {
      const items = paths.items.map((item) => {
        if (!isScalar(item) || typeof item.value !== 'string') rejectField('paths');
        return item.value;
      });
      if (items.length > 0) fields.globs = items.join(PATTERNS_SEPARATOR);
    } else if (isScalar(paths) && typeof paths.value === 'string') {
      if (paths.value) fields.globs = paths.value;
    } else {
      rejectField('paths');
    }
  }
  return fields;
}

function readOtherKeys(doc: Document): string[] {
  if (!isMap(doc.contents)) return [];
  const managed = new Set<string>(MANAGED);
  return doc.contents.items
    .map((pair) => (isScalar(pair.key) ? String(pair.key.value) : undefined))
    .filter((key): key is string => key !== undefined && !managed.has(key));
}

/** Разобрать правило Qwen. Без frontmatter — постоянное правило, тело = весь файл. */
export function readQwenRule(text: string): MdcRule {
  const parts = splitMdc(text);
  if (!parts) return { fields: {}, body: stripBom(text), otherKeys: [] };
  const doc = parseFrontmatter(parts.frontmatter);
  return { fields: readFields(doc), body: parts.body, otherKeys: readOtherKeys(doc) };
}

function otherKeysProjection(doc: Document): string {
  const raw = doc.toJS() as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}';
  const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of MANAGED) delete rest[key];
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Новый текст правила: `description` и `paths` из полей, тело как есть. Пустое
 * поле = ключа быть не должно. `alwaysApply` формат не знает — домен отклоняет
 * его раньше, здесь он не читается.
 */
export function writeQwenRule(original: string, fields: MdcFields, body: string): string {
  const parts = splitMdc(original);
  const base = parts ? parts.frontmatter : '';
  const before = parseFrontmatter(base);
  const doc = parseFrontmatter(base);
  const current = readFields(before);

  const dropKey = (key: string): void => {
    if (isMap(doc.contents)) doc.delete(key);
  };

  const description = fields.description?.trim() ? fields.description : undefined;
  if (description === undefined) dropKey('description');
  else doc.set('description', description);

  const patterns = fields.globs === undefined ? [] : splitPatterns(fields.globs);
  const globs = patterns.length > 0 ? patterns.join(PATTERNS_SEPARATOR) : undefined;
  if (globs === undefined) dropKey('paths');
  // Тот же набор шаблонов — узел не трогаем: строка остаётся строкой, список списком.
  else if (globs !== current.globs) doc.set('paths', doc.createNode(patterns));

  const normalizedBody = body.replace(/\r\n|\r/g, '\n');
  const empty = doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0);
  const next = empty
    ? normalizedBody
    : `---\n${doc.toString({ lineWidth: 0 })}---\n${normalizedBody}`;

  const check = readQwenRule(next);
  const wanted: MdcFields = {
    ...(description === undefined ? {} : { description }),
    ...(globs === undefined ? {} : { globs }),
  };
  const sameFields =
    (check.fields.description ?? '') === (wanted.description ?? '') &&
    (check.fields.globs ?? '') === (wanted.globs ?? '');
  if (!sameFields) {
    malformed('Контрольный разбор правила не совпал с намерением.', 'mdc-roundtrip-intent');
  }
  if (check.body !== normalizedBody) {
    malformed('Контрольный разбор изменил тело правила.', 'mdc-roundtrip-body');
  }
  const after = splitMdc(next);
  if (
    otherKeysProjection(before) !==
    otherKeysProjection(parseFrontmatter(after ? after.frontmatter : ''))
  ) {
    malformed('Контрольный разбор потерял ключи frontmatter.', 'mdc-roundtrip-keys');
  }
  return next;
}
