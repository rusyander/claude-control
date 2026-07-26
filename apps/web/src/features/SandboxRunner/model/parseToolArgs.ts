/**
 * Разбор параметров вызова инструмента MCP.
 *
 * Раньше сломанный JSON молча превращался в пустой объект: вызов уходил с `{}`,
 * инструмент отрабатывал на умолчаниях и возвращал зелёный «Инструмент ответил»,
 * не имеющий отношения к тому, что человек набрал. Ошибку разбора нужно
 * показать до отправки — вместе с тем, что именно сказал JSON.parse: без позиции
 * в тексте лишнюю запятую в пяти строках не найти.
 *
 * `t` приходит снаружи: разбор — чистая логика, словарь живёт в компоненте
 * (тот же приём, что и в healthFromError).
 */
export type ToolArgsResult =
  { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export function parseToolArgs(raw: string, t: (key: string) => string): ToolArgsResult {
  // Пустое поле — это «параметров нет», а не ошибка ввода.
  if (!raw.trim()) return { ok: true, args: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${t('sandbox.argumentsInvalid')}: ${reason}` };
  }

  // Массив и число разбираются, но параметры инструмента — всегда объект:
  // отправленный список сервер отбил бы уже своей схемой.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: t('sandbox.argumentsNotObject') };
  }

  return { ok: true, args: parsed as Record<string, unknown> };
}
