/**
 * Хук PostToolUse группы разделения: свёртка ответов записи в трекер (2.3 плана
 * экономии, 17.10.2026).
 *
 * Смена статуса и назначение отвечают задачей целиком — описание, комментарии,
 * автор: 4–9 тыс. знаков, ~14 раз на чат (замер 16.10). Каждый следующий вызов
 * модели перечитывал этот ответ. Комментарий отвечал эхом своего же текста.
 * Хук заменяет ответ (`updatedToolOutput`, CLI 2.1.286 — для любого инструмента,
 * MCP тоже) короткой строкой: ключ, сообщение сервера, новый статус, исполнитель
 * и команда, которой задача читается целиком. Чтение задачи не трогается: там
 * содержимое и есть то, что агент просил.
 *
 * Всё, что хук не узнал — другой инструмент, ошибка, ответ без задачи, битый
 * вход, — проходит как есть: тишина на stdout и код 0. Хук никогда не ломает
 * инструмент, потеря строки дешевле потерянного ответа.
 *
 * Ставит его панель группе в её файле `--settings` (`group-profile.ts`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Матчер настройки хука: только запись в трекер. Повторён в `group-profile.ts`.
 * `update_issue` — тоже: им назначают и правят поля, и он отвечает той же
 * задачей целиком (ревью A2-F17).
 */
export const TRACKER_WRITE_MATCHER =
  'mcp__.*__jira_(transition_issue|assign_issue|update_issue|add_comment|edit_comment)';
const WRITE = new RegExp(`^${TRACKER_WRITE_MATCHER}$`);

/** Текст ответа инструмента: строка, части MCP или объект с ними. */
function textOf(response) {
  if (typeof response === 'string') return response;
  const parts = Array.isArray(response) ? response : response?.content;
  if (Array.isArray(parts)) {
    return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return response && typeof response === 'object' ? JSON.stringify(response) : '';
}

/** Полезная нагрузка: JSON, у сервера трекера обёрнутый в `{"result": "<JSON>"}`. */
function payloadOf(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data?.result === 'string') {
    try {
      data = JSON.parse(data.result);
    } catch {
      return null;
    }
  } else if (data?.result && typeof data.result === 'object') {
    data = data.result;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/** Короткая строка вместо ответа или `null` — ответ остаётся как был. */
export function briefTrackerOutput(toolName, toolInput, toolResponse) {
  if (typeof toolName !== 'string' || !WRITE.test(toolName)) return null;
  const data = payloadOf(textOf(toolResponse));
  if (!data) return null;
  const action = toolName.replace(/^.*__jira_/, '');
  if (action.endsWith('_issue')) {
    const issue = data.issue;
    if (typeof issue?.key !== 'string') return null;
    const parts = [
      typeof data.message === 'string' ? data.message : `${issue.key} updated`,
      typeof issue.status?.name === 'string' ? `status: ${issue.status.name}` : '',
      typeof issue.assignee?.display_name === 'string'
        ? `assignee: ${issue.assignee.display_name}`
        : '',
    ].filter(Boolean);
    return `${parts.join('; ')}. Full issue: jira_get_issue ${issue.key}.`;
  }
  if (typeof data.id !== 'string' && typeof data.id !== 'number') return null;
  const key = typeof toolInput?.issue_key === 'string' ? toolInput.issue_key : '';
  const body = typeof data.body === 'string' ? data.body : '';
  return (
    `Comment ${data.id} saved${key ? ` on ${key}` : ''} (${body.length} chars, the body as sent).` +
    (key ? ` Full issue with comments: jira_get_issue ${key}.` : '')
  );
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const brief = briefTrackerOutput(input?.tool_name, input?.tool_input, input?.tool_response);
  if (!brief) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: brief },
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // Хук не ломает инструмент: любой сбой — ответ как был.
  }
  process.exitCode = 0;
}
