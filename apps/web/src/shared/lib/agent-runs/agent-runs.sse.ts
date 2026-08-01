/** Пауза с учётом прерывания — между попытками переподключения. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Разобрать один SSE-фрейм в событие. Пинг-комментарий (нет строки `data:`) и
 * неразборный JSON → `undefined`: битый data-фрейм пропускаем, а не роняем им
 * весь цикл чтения (иначе прогон всплыл бы «ошибкой» и мог уйти в авто-ретрай).
 * Так же терпимо к мусору разбирает строки CLI сервер (см. `ChatRunner`).
 */
export function parseSseFrame(part: string): { kind: string; seq?: number } | undefined {
  const line = part.split('\n').find((piece) => piece.startsWith('data:'));
  if (!line) return undefined; // пинг-комментарий
  try {
    return JSON.parse(line.slice(5)) as { kind: string; seq?: number };
  } catch {
    return undefined; // неразборный фрейм — пропускаем, поток не роняем
  }
}
