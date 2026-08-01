import type { HookDecision } from './HookProbe.types.ts';

interface HookOutput {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
  decision?: string;
  reason?: string;
  continue?: boolean;
  stopReason?: string;
}

/**
 * Решение хука по его ответу. Код 2 останавливает действие сразу, а в JSON
 * решение приходит словом: deny — запрет, ask — нужно подтверждение
 * пользователя, allow — согласие. Молчание означает «не вмешиваюсь».
 *
 * Любой другой ненулевой код — ошибка самого хука (нет интерпретатора, упал,
 * оболочка не нашла команду), и «не вмешиваюсь» из неё не следует: раньше
 * ненайденный python выглядел в панели точно так же, как отработавший и
 * промолчавший страж.
 *
 * Экспортируется ради тестов: это чистая логика, которую хочется проверить
 * без запуска настоящего процесса хука.
 */
export function readDecision(
  exitCode: number,
  parsed: unknown,
): { decision: HookDecision; reason?: string; addedContext?: string } {
  if (exitCode === 2) return { decision: 'block', reason: 'Хук вышел с кодом 2' };

  const output = parsed as HookOutput | undefined;
  const specific = output?.hookSpecificOutput;
  const verdict = specific?.permissionDecision ?? output?.decision;
  const reason = specific?.permissionDecisionReason ?? output?.reason;
  const addedContext = specific?.additionalContext;

  if (verdict === 'deny' || verdict === 'block') return { decision: 'block', reason, addedContext };
  if (verdict === 'ask') return { decision: 'ask', reason, addedContext };
  if (output?.continue === false) {
    return { decision: 'block', reason: output.stopReason ?? reason, addedContext };
  }

  if (exitCode !== 0) {
    return {
      decision: 'error',
      reason: reason ?? `Хук завершился с кодом ${exitCode} и решения не вернул`,
      addedContext,
    };
  }

  return { decision: 'pass', reason, addedContext };
}

function parseJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Достаёт вердикт-JSON из вывода хука, не спотыкаясь о логи вокруг него.
 *
 * Хук волен печатать в stdout что угодно помимо решения: строку лога, баннер,
 * прогресс. Раньше брался слепой срез от первого `{` до последнего `}` — и лог
 * со скобками до/после JSON (`processing {foo}` … `done }`) делал срез невалидным,
 * а вердикт терялся. Теперь по порядку: (1) весь вывод целиком (обычный случай —
 * хук печатает только JSON, в т.ч. с отступами в несколько строк); (2) отдельная
 * строка-JSON среди логов, начиная с ПОСЛЕДНЕЙ — итоговый вердикт хук печатает в
 * конце; (3) как крайний фолбэк — прежний срез от первого `{` до последнего `}`
 * (многострочный JSON, окружённый логами без фигурных скобок). Экспортируется
 * ради тестов.
 */
export function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const whole = parseJson(trimmed);
  if (whole !== undefined) return whole;

  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('{') && line.endsWith('}')) {
      const parsed = parseJson(line);
      if (parsed !== undefined) return parsed;
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return parseJson(trimmed.slice(start, end + 1));

  return undefined;
}
