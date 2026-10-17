/**
 * Хук PreToolUse: список задач трекера — заголовками, без описаний (5.2 плана
 * экономии, 17.10.2026).
 *
 * Поиск, доска и спринт трекера по умолчанию отдают каждую задачу с описанием:
 * разбор доски перед разделением вытянул 214 тыс. знаков (замер 16.10, три
 * выборки доски и четыре поиска), и каждый следующий вызов модели перечитывал
 * их. Чтобы выбрать задачи, хватает ключа, заголовка и статуса; описание нужно
 * только отобранным. Хук подставляет короткий набор полей, когда вызов полей
 * не назвал, и говорит модели, как прочитать описание. Вызов, назвавший поля
 * сам, не трогается: явная просьба сильнее экономии.
 *
 * Всё, что хук не узнал — другой инструмент, битый вход, — проходит как есть:
 * тишина на stdout и код 0. Хук никогда не ломает инструмент.
 *
 * Ставит его панель чатам с инициативой разделения и группам (`group-profile.ts`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Матчер настройки хука: выборки задач списком. Повторён в `group-profile.ts`. */
export const BOARD_LIST_MATCHER = 'mcp__.*__jira_(search|get_board_issues|get_sprint_issues)';
const LIST = new RegExp(`^${BOARD_LIST_MATCHER}$`);

/** Поля списка: чтобы выбрать задачу, а не чтобы её делать. */
export const LIST_FIELDS = 'summary,status,priority,issuetype,assignee,labels,updated';

const NOTE =
  `Issue lists here come without descriptions (fields=${LIST_FIELDS}): pick by key, title and ` +
  'status first, then read the description of the issues you actually take with jira_get_issue. ' +
  'Pass "fields" yourself when a list really needs other fields.';

/**
 * Поля, названные моделью: строкой или списком (MCP трекера принимают оба). Список
 * прежде подменялся нашими полями — явная просьба проигрывала (ревью B2-F18).
 */
function explicitFields(fields) {
  if (typeof fields === 'string') return fields.trim() !== '';
  return Array.isArray(fields) && fields.some((name) => typeof name === 'string' && name.trim());
}

/** Выход хука для вызова или `null` — вызов идёт как был. */
export function narrowListInput(toolName, toolInput) {
  if (typeof toolName !== 'string' || !LIST.test(toolName)) return null;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  if (explicitFields(toolInput.fields)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...toolInput, fields: LIST_FIELDS },
      additionalContext: NOTE,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const output = narrowListInput(input.tool_name, input.tool_input);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Битый вход — вызов идёт как был.
  }
  // Не process.exit: на Windows запись в трубу асинхронна и оборвалась бы.
  process.exitCode = 0;
}
