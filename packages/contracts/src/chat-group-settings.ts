import { blockLang } from './brand.ts';
import type { GroupKey } from './group-sources.ts';

/**
 * Группа и автономность — настройки ЧАТА, а не проекта: в одном проекте может
 * идти ревью по одной лестнице и правка по другой.
 *
 * `auto` — разбор сам выбирает группу по её `when` среди доступных в каталоге
 * чата (с учётом выбора пары глобальная/проектная). Дети разделения наследуют
 * значения родителя. Правки из панели больше нет (развилки групп — у ядра):
 * сохранённые значения прежних чатов только читаются.
 */
export type ChatGroupChoice = 'auto' | GroupKey;

/** Что хранится у чата. Поля нет — значение по умолчанию (или от родителя). */
export type StoredChatGroupSettings = {
  groupChoice?: ChatGroupChoice;
  autonomous?: boolean;
};

/** Автономность по умолчанию ВКЛЮЧЕНА (владелец, 26.09.2026). */
const CHAT_AUTONOMOUS_DEFAULT = true;

/** Действующие значения и откуда они: своё или унаследованное от родителя. */
export interface ChatGroupSettingsView {
  groupChoice: ChatGroupChoice;
  groupChoiceInherited: boolean;
  autonomous: boolean;
  autonomousInherited: boolean;
  /** Родитель, от которого пришли унаследованные значения, — для «из родителя: X». */
  parentChatId?: string;
}

/**
 * Метка «вывод тяжёлых команд — коротко» (2.2 плана экономии): панель ставит её
 * ребёнку разделения, `tools/tests-cli.mjs run` по ней уводит вывод раннера в
 * журнал и печатает итог, первые строки падений и путь. Имя повторено в
 * tests-cli строкой — он не импортирует контракты.
 */
export const BRIEF_OUTPUT_ENV = 'AGENTDECK_BRIEF_OUTPUT';

/**
 * Каталог проекта блока «Тесты» для группы Claude (X1 плана экономии): строка о
 * тестах в системном промпте группы идёт без путей, чтобы копии одной группы
 * делили кэш начала запроса, а `tools/tests-cli.mjs` без `--project` берёт
 * проект отсюда — из любого подкаталога копии.
 */
export const TESTS_PROJECT_ENV = 'AGENTDECK_TESTS_PROJECT';

/**
 * Путь к `tools/tests-cli.mjs` панели для ребёнка разделения (26.10): глобальный
 * `gate-run` с `{junit}` в гейте импортирует по нему отчёт в блок «Тесты». Без
 * пути в копии чужого проекта CLI не находился, отчёт пропадал, и тот же гейт
 * гоняли второй раз через `tests-cli run`. Имя повторено в gate-run строкой.
 */
export const TESTS_CLI_ENV = 'AGENTDECK_TESTS_CLI';

/** Действующие значения из своего и родительского — чистая функция для сервера и тестов. */
export function resolveChatGroupSettings(
  own: StoredChatGroupSettings | undefined,
  parent: ChatGroupSettingsView | undefined,
  parentChatId?: string,
): ChatGroupSettingsView {
  const groupOwn = own?.groupChoice;
  const autoOwn = own?.autonomous;
  return {
    groupChoice: groupOwn ?? parent?.groupChoice ?? 'auto',
    groupChoiceInherited: groupOwn === undefined && parent !== undefined,
    autonomous: autoOwn ?? parent?.autonomous ?? CHAT_AUTONOMOUS_DEFAULT,
    autonomousInherited: autoOwn === undefined && parent !== undefined,
    ...(parent && parentChatId ? { parentChatId } : {}),
  };
}

/** Метка в тексте отказа брокера: по ней лента узнаёт автовыбор и рисует его строкой. */
// Метка — через `blockLang`, как у соседей (F-330).
export const AUTONOMOUS_PICK_MARKER = blockLang('autonomous-pick');

export interface RecommendedPick {
  question: string;
  label: string;
  critical: boolean;
}

/**
 * Отказ брокера под автономией: модель получает его результатом вызова и идёт
 * дальше с выбранным. По-английски — это текст модели, не человека.
 */
export function autonomousPickMessage(picks: readonly RecommendedPick[]): string {
  // Вопрос и вариант — строками JSON: перевод строки, кавычка или стрелка внутри
  // вопроса иначе ломали обратный разбор, и выбор терялся (F-132). Модели такая
  // строка читается так же.
  const lines = picks.map(
    (pick) => `- ${JSON.stringify(pick.question)} → ${JSON.stringify(pick.label)}`,
  );
  return [
    `${AUTONOMOUS_PICK_MARKER}: this chat runs autonomously — the owner pre-approved the ` +
      'recommended options. Do not ask again; take these answers, state the pick in one line ' +
      'and continue:',
    ...lines,
  ].join('\n');
}

// --- Лента автовыбора (26.09.2026) ---

/** Один автовыбор, как его рисует лента: вопрос и взятый вариант. */
export interface AutonomousPickLine {
  question: string;
  label: string;
}

/**
 * Разбор отказа брокера обратно в выбор — для ленты из транскрипта: результат
 * вызова лежит там текстом, и по метке лента узнаёт, что вопрос закрыла
 * автономия, а не человек. Нет метки — `null`: это обычный отказ.
 */
export function parseAutonomousPickMessage(text: string): AutonomousPickLine[] | null {
  if (!text.includes(AUTONOMOUS_PICK_MARKER)) return null;
  const picks: AutonomousPickLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const pick = jsonPickLine(line.trim()) ?? legacyPickLine(line.trim());
    if (pick) picks.push(pick);
  }
  return picks;
}

const ARROW = ' → ';

/** Строка нынешнего вида: `- "<JSON>" → "<JSON>"`. */
function jsonPickLine(line: string): AutonomousPickLine | null {
  if (!line.startsWith('- "')) return null;
  const question = jsonStringAt(line, 2);
  if (!question || !line.startsWith(ARROW, question.end)) return null;
  const rest = line.slice(question.end + ARROW.length);
  const label = jsonStringAt(rest, 0);
  if (!label || label.end !== rest.length) return null;
  return { question: question.value, label: label.value };
}

/** Строка JSON с позиции `start`: значение и где она кончилась; не строка — `null`. */
function jsonStringAt(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] !== '"') continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, index + 1));
      return typeof value === 'string' ? { value, end: index + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Строка прежнего вида `- "вопрос" → вариант` — лежит в транскриптах, и её же
 * пишет глобальный хук, чьё правило вне этого репозитория.
 */
function legacyPickLine(line: string): AutonomousPickLine | null {
  const match = /^- "(.*)" → (.+)$/.exec(line);
  return match ? { question: match[1] ?? '', label: (match[2] ?? '').trim() } : null;
}
