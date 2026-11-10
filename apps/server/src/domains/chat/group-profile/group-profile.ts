import type { SessionHooks } from '@agentdeck/contracts/core/session-carry';
import type { GroupRunProfile } from './group-profile.types.ts';

export type * from './group-profile.types.ts';

/**
 * Профиль запуска чата панели. Лёгкий профиль группы разделения (`groupRunProfile`:
 * отбор MCP, навыки по звену, запреты доставки, очередь тяжёлых шагов, хук трекера)
 * ушёл вместе с прогоном групп панелью (этап 10, G14): задачу ведёт ядро, и набор
 * серверов, навыков и запретов звена решает оно. Здесь осталось то, что читает живой
 * путь: хук списка задач обычного чата, снятие MCP под маршрутом и строка привычек.
 */

/**
 * Привычки, которые удешевляют каждый следующий вызов (замер 20.10): окно
 * перечитывается целиком на каждом шаге, поэтому цепочка одиночных чтений и
 * чужой код, прочитанный ради поиска, оплачиваются десятки раз. Без имён
 * инструментов Claude: строка едет звеньям чужих CLI (`foreignChildExtra`).
 */
export const WORK_HABITS_SHARED_NOTE =
  'Economy (the human enabled it in the panel; every call re-sends this whole conversation): ' +
  'put independent reads and commands into one step — parallel tool calls or one `a; b; c` ' +
  'command — instead of a chain of single calls; read only what you will edit or judge. Keep ' +
  'output narrow: grep, line ranges, `git diff --stat` before a full diff.';

/**
 * Профиль обычного чата при инициативе разделения (5.2): прогон и серверы как
 * были, сверху только хук списка задач без описаний — разбор доски перед
 * разделением идёт заголовками, описание читается у отобранных задач.
 */
export function chatRunProfile(input: { boardHook: string }): GroupRunProfile {
  return { args: [], env: {}, note: '', settings: { hooks: boardHooks(input.boardHook) } };
}

/**
 * Профиль под маршрутом, который сам решает MCP (контур, локальная модель):
 * серверы, флаг, переменная подключений claude.ai и строка о серверах — его;
 * настройки (хуки) и прочие переменные остаются.
 */
export function withoutMcp(profile: GroupRunProfile): GroupRunProfile {
  const env = Object.fromEntries(
    Object.entries(profile.env).filter(([name]) => name !== 'ENABLE_CLAUDEAI_MCP_SERVERS'),
  );
  return { args: [], env, note: '', settings: profile.settings };
}

/** Матчер хука списка задач: поиск, доска, спринт. Повторён в `tools/board-fields-hook.mjs`. */
const BOARD_LIST_MATCHER = 'mcp__.*__jira_(search|get_board_issues|get_sprint_issues)';

/**
 * Хук списка задач (5.2): без названных полей трекер отдаёт каждую задачу с
 * описанием, и разбор доски вытягивал сотни тысяч знаков. До вызова хук
 * подставляет короткий набор полей; вызов, назвавший поля, не трогает. В сеанс ядра хук едет
 * полем `session.hooks` (`core-run/session-carry.ts`, s12): ход через ядро терял его молча.
 */
function boardHooks(command: string): SessionHooks {
  return {
    PreToolUse: [
      { matcher: BOARD_LIST_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] },
    ],
  };
}
