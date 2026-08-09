/**
 * Самое говорящее поле входа инструмента: путь, команда, шаблон — что нашлось
 * первым. Живёт отдельным модулем, потому что нужно двум лентам сразу: и
 * потоковой, и транскрипту, — а на телефоне без этой строки вызов выглядит как
 * пустая коробка со словом `Bash`, и десяток таких подряд занимает весь экран,
 * ничего не сообщая.
 */
export function summarizeToolInput(raw: string): string {
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['file_path', 'path', 'command', 'pattern', 'prompt', 'query', 'url']) {
      const value = input[key];
      if (typeof value === 'string' && value) return oneLine(value);
    }
    return '';
  } catch {
    return oneLine(raw.slice(0, 120));
  }
}

/** Многострочная команда в одну строку: в свёрнутом виде видна только первая. */
function oneLine(value: string): string {
  const trimmed = value.trim();
  const cut = trimmed.indexOf('\n');
  return cut === -1 ? trimmed : `${trimmed.slice(0, cut)} …`;
}
