/**
 * Короткая суть запроса прав: команда/файл/адрес, иначе — компактный JSON. `question` — текст
 * вопроса права задачи ядра: JSON показал бы его с удвоенными обратными косыми путей Windows.
 */
export function summarize(input: unknown): string {
  const object = (input ?? {}) as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'question']) {
    const value = object[key];
    if (typeof value === 'string' && value) return value;
  }
  try {
    const json = JSON.stringify(object);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return '';
  }
}
