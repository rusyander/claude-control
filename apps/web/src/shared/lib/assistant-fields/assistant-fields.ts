import type {
  AssistantFieldSpec,
  AssistantMiss,
  AssistantOption,
  AssistantReading,
  AssistantSpec,
  AssistantValues,
} from './assistant-fields.types';

/**
 * Помощник формы: задание модели и проверка её ответа по одному описанию полей.
 *
 * Раньше каждая форма давала модели только текстовые поля и принимала только
 * строки — состав группы, проекты, таймаут хука помощнику были недоступны, и он
 * честно отвечал «умею только имя и описание». Теперь поле любого вида
 * описывается один раз: перечислимое несёт допустимые значения (id и подпись),
 * и модель выбирает из того, что есть в панели, а ответ проверяется тем же
 * списком — несуществующее отбрасывается и называется, а не молча теряется.
 */

/** Сколько вариантов перечислять модели: длиннее задание мешает, а не помогает. */
export const MAX_LISTED_OPTIONS = 300;
const MAX_LABEL = 80;

function listOptions(options: readonly AssistantOption[]): string {
  const shown = options.slice(0, MAX_LISTED_OPTIONS).map((option) => {
    const label = option.label?.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
    return label && label !== option.value
      ? `${JSON.stringify(option.value)} (${label})`
      : JSON.stringify(option.value);
  });
  const rest = options.length - shown.length;
  const tail = rest > 0 ? `; …and ${rest} more exist but are not listed here` : '';
  return shown.length > 0 ? `${shown.join('; ')}${tail}` : 'none exist yet';
}

function numberRange(field: AssistantFieldSpec & { type: 'number' }): string {
  const parts = [field.integer ? 'an integer' : 'a number'];
  if (field.min !== undefined) parts.push(`from ${field.min}`);
  if (field.max !== undefined) parts.push(`up to ${field.max}`);
  return parts.join(' ');
}

/** Строка вида значения для модели. */
function describeValue(field: AssistantFieldSpec): string {
  switch (field.type) {
    case 'text':
      return 'Value: a string.';
    case 'choice':
      return `Value: exactly one of the allowed values (a string). Allowed: ${listOptions(field.options)}.`;
    case 'choices':
      return (
        'Value: a JSON array of allowed values, in the order they should go. The array ' +
        'replaces the whole current list — keep the current entries you do not mean to ' +
        `remove. Never invent values. Allowed: ${listOptions(field.options)}.`
      );
    case 'list': {
      const examples = field.suggestions?.length
        ? ` Known values: ${field.suggestions.map((item) => JSON.stringify(item)).join(', ')}.`
        : '';
      return `Value: a JSON array of strings; it replaces the whole current list.${examples}`;
    }
    case 'number':
      return `Value: ${numberRange(field)}${field.nullable ? ', or null to reset to the default' : ''}.`;
    case 'flag':
      return 'Value: true or false.';
  }
}

/**
 * Описание полей для задания модели: назначение + вид значения + допустимые
 * значения. Закрытые поля модели не предлагаются.
 */
export function assistantSchema(spec: AssistantSpec): Record<string, string> {
  const schema: Record<string, string> = {};
  for (const [key, field] of Object.entries(spec)) {
    if (field.off) continue;
    schema[key] = `${field.hint.replace(/\.$/, '')}. ${describeValue(field)}`;
  }
  return schema;
}

/**
 * Найти вариант по ответу модели: точное значение, затем то же без учёта
 * регистра, затем подпись — последние два только когда совпадение одно.
 */
function matchOption(options: readonly AssistantOption[], raw: string): string | undefined {
  const text = raw.trim();
  const exact = options.find((option) => option.value === text);
  if (exact) return exact.value;
  const lower = text.toLowerCase();
  const unique = (hits: readonly AssistantOption[]): string | undefined =>
    hits.length === 1 ? hits[0]?.value : undefined;
  return (
    unique(options.filter((option) => option.value.toLowerCase() === lower)) ??
    unique(options.filter((option) => option.label?.trim().toLowerCase() === lower))
  );
}

type Miss = Omit<AssistantMiss, 'field'>;

/** Итог проверки одного поля; принятое может нести и частичный отказ (часть id). */
type Checked = { ok: true; value: unknown; miss?: Miss } | { ok: false; miss: Miss };

const WRONG: Checked = { ok: false, miss: { reason: 'wrong-type' } };

function readNumber(field: AssistantFieldSpec & { type: 'number' }, raw: unknown): Checked {
  if (raw === null) return field.nullable ? { ok: true, value: null } : WRONG;
  const value =
    typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return WRONG;
  if (field.integer && !Number.isInteger(value)) return WRONG;
  if (field.min !== undefined && value < field.min) return WRONG;
  if (field.max !== undefined && value > field.max) return WRONG;
  return { ok: true, value };
}

function readChoices(field: AssistantFieldSpec & { type: 'choices' }, raw: unknown): Checked {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return WRONG;
  const known: string[] = [];
  const unknown: string[] = [];
  for (const item of raw as string[]) {
    const value = matchOption(field.options, item);
    if (value === undefined) unknown.push(item);
    else if (!known.includes(value)) known.push(value);
  }
  // Всё присланное — выдумка: пустой список стёр бы состав, которого никто не просил трогать.
  if (known.length === 0 && unknown.length > 0) {
    return { ok: false, miss: { reason: 'unknown-value', values: unknown } };
  }
  return unknown.length > 0
    ? { ok: true, value: known, miss: { reason: 'unknown-value', values: unknown } }
    : { ok: true, value: known };
}

function readField(field: AssistantFieldSpec, raw: unknown): Checked {
  switch (field.type) {
    case 'text':
      if (typeof raw === 'string') return { ok: true, value: raw };
      if ((typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'boolean') {
        return { ok: true, value: String(raw) };
      }
      return WRONG;
    case 'choice': {
      if (typeof raw !== 'string') return WRONG;
      const value = matchOption(field.options, raw);
      return value === undefined
        ? { ok: false, miss: { reason: 'unknown-value', values: [raw] } }
        : { ok: true, value };
    }
    case 'choices':
      return readChoices(field, raw);
    case 'list':
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return WRONG;
      return {
        ok: true,
        value: [...new Set((raw as string[]).map((item) => item.trim()).filter(Boolean))],
      };
    case 'number':
      return readNumber(field, raw);
    case 'flag':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : WRONG;
  }
}

/**
 * Проверить ответ модели по описанию полей. Применяется только проверенное;
 * всё прочее — в `missed` с причиной, чтобы лента помощника его назвала.
 */
export function readAssistantFields<S extends AssistantSpec>(
  spec: S,
  raw: Record<string, unknown>,
): AssistantReading<S> {
  const values: Record<string, unknown> = {};
  const applied: string[] = [];
  const missed: AssistantMiss[] = [];

  for (const [key, value] of Object.entries(raw ?? {})) {
    const field = Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (!field) {
      missed.push({ field: key, reason: 'unknown-field' });
      continue;
    }
    if (field.off) {
      missed.push({ field: key, reason: 'locked' });
      continue;
    }
    const checked = readField(field, value);
    if (checked.ok) {
      values[key] = checked.value;
      applied.push(key);
      if (checked.miss) missed.push({ field: key, ...checked.miss });
    } else {
      missed.push({ field: key, ...checked.miss });
    }
  }

  return {
    values: values as AssistantValues<S>,
    applied: applied as AssistantReading<S>['applied'],
    missed,
  };
}

/** Непринятое по причинам — для строк под ответом помощника. */
export function groupMisses(missed: readonly AssistantMiss[]): {
  values: string[];
  types: string[];
  fields: string[];
  secrets: string[];
} {
  return {
    values: missed
      .filter((miss) => miss.reason === 'unknown-value')
      .map((miss) => `${miss.field}: ${(miss.values ?? []).join(', ')}`),
    types: missed.filter((miss) => miss.reason === 'wrong-type').map((miss) => miss.field),
    fields: missed
      .filter((miss) => miss.reason === 'unknown-field' || miss.reason === 'locked')
      .map((miss) => miss.field),
    secrets: missed.filter((miss) => miss.reason === 'secret').map((miss) => miss.field),
  };
}
