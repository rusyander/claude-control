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
    // Вопрос агента — его первый вопрос: иначе в ленте голое «AskUserQuestion»,
    // и о чём спрашивают, не видно, пока не откроешь «Вопросы».
    const question = firstQuestion(input.questions);
    if (question) return oneLine(question);
    // Описание раньше текста задачи: у субагента это «Scan the repo», а не
    // первая строка длинного промпта.
    for (const key of [
      'file_path',
      'path',
      'command',
      'pattern',
      'description',
      'prompt',
      'query',
      'url',
    ]) {
      const value = input[key];
      if (typeof value === 'string' && value) return oneLine(value);
    }
    return '';
  } catch {
    return oneLine(raw.slice(0, 120));
  }
}

function firstQuestion(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const first = (list[0] as { question?: unknown } | undefined)?.question;
  return typeof first === 'string' && first.trim() ? first : undefined;
}

/** Многострочная команда в одну строку: в свёрнутом виде видна только первая. */
function oneLine(value: string): string {
  const trimmed = value.trim();
  const cut = trimmed.indexOf('\n');
  return cut === -1 ? trimmed : `${trimmed.slice(0, cut)} …`;
}
