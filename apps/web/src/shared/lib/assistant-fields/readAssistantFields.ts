import type {
  AssistantFieldSpec,
  Checked,
  AssistantSpec,
  AssistantReading,
  AssistantMiss,
  AssistantValues,
} from './assistant-fields.types';
import { WRONG } from './assistant-fields.constants';
import { matchOption } from './matchOption';

export function readChoices(
  field: AssistantFieldSpec & { type: 'choices' },
  raw: unknown,
): Checked {
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

export function readNumber(field: AssistantFieldSpec & { type: 'number' }, raw: unknown): Checked {
  if (raw === null) return field.nullable ? { ok: true, value: null } : WRONG;
  const value =
    typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return WRONG;
  if (field.integer && !Number.isInteger(value)) return WRONG;
  if (field.min !== undefined && value < field.min) return WRONG;
  if (field.max !== undefined && value > field.max) return WRONG;
  return { ok: true, value };
}

export function readField(field: AssistantFieldSpec, raw: unknown): Checked {
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
