import type { AssistantFieldSpec, AssistantOption, AssistantSpec } from './assistant-fields.types';

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
