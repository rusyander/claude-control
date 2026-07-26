/** Событие прогона песочницы — то же, что шлёт чат, но своим маршрутом. */
export interface SandboxEvent {
  kind: string;
  text?: string;
  name?: string;
  message?: string;
  sessionId?: string;
  costUsd?: number;
}

/**
 * Разобрать один кадр SSE песочницы.
 *
 * Кадр без строки `data:` (пинг-комментарий) и неразборный JSON дают
 * `undefined`: битый кадр пропускаем, а не роняем им весь цикл чтения. Раньше
 * `JSON.parse` стоял голым — исключение вылетало из цикла во внешний catch, и
 * на месте ответа агента человек видел «Unexpected end of JSON input», а
 * прогон обрывался на середине. В чате этот случай обработан давно
 * (`parseSseFrame` в agentRunsStore), песочница же осталась без защиты.
 */
export function parseSandboxFrame(chunk: string): SandboxEvent | undefined {
  const line = chunk.split('\n').find((part) => part.startsWith('data:'));
  if (!line) return undefined;

  try {
    const parsed: unknown = JSON.parse(line.slice(5));
    // Сервер шлёт объекты; строка или число в кадре — тоже мусор.
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed as SandboxEvent;
  } catch {
    return undefined;
  }
}
