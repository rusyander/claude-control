/** Короткая суть запроса прав: команда/файл/адрес, иначе — компактный JSON. */
export function summarize(input: unknown): string {
  const object = (input ?? {}) as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
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
