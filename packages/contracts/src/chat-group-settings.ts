import { object, string, boolean, union, literal, enum as zodEnum, type infer as Infer } from 'zod';
import { blockLang } from './brand.ts';
import { parseGroupKey, type GroupKey } from './group-sources.ts';

/**
 * Группа и автономность — настройки ЧАТА, а не проекта: в одном проекте может
 * идти ревью по одной лестнице и правка по другой.
 *
 * `auto` — разбор сам выбирает группу по её `when` среди доступных в каталоге
 * чата (с учётом выбора пары глобальная/проектная). Дети разделения наследуют
 * значения родителя; ручная правка у ребёнка меняет только его.
 */
export const chatGroupChoiceSchema = union([
  literal('auto'),
  string().refine((key) => parseGroupKey(key) !== null, {
    message: 'group choice must be auto or a group key',
  }),
]);
export type ChatGroupChoice = 'auto' | GroupKey;

/** Что хранится у чата. Поля нет — значение по умолчанию (или от родителя). */
export const chatGroupSettingsSchema = object({
  groupChoice: chatGroupChoiceSchema.optional(),
  autonomous: boolean().optional(),
});
export type StoredChatGroupSettings = {
  groupChoice?: ChatGroupChoice;
  autonomous?: boolean;
};

/** Автономность по умолчанию ВКЛЮЧЕНА (владелец, 26.09.2026). */
export const CHAT_AUTONOMOUS_DEFAULT = true;

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
 * Метка автономного прогона в окружении CLI. Под ней хуки не задают вопросов
 * с рекомендованным вариантом — берут рекомендованный и пишут выбор строкой.
 * Интерактивный чат с выключенной автономностью её не получает.
 */
export const AUTONOMOUS_ENV = 'AGENTDECK_AUTONOMOUS';

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

/**
 * Критическое замечание ребёнка: блок в его ответе. Панель кладёт карточку в
 * ГЛАВНЫЙ чат дерева (корень), со ссылкой на ребёнка и текстом; всё
 * некритическое остаётся в самом ребёнке.
 */
export const ESCALATE_BLOCK_LANG = blockLang('escalate');

export const escalationSchema = object({
  severity: zodEnum(['critical']),
  text: string().min(1).max(2_000),
});
export type Escalation = Infer<typeof escalationSchema>;

/** Заметка в ленте главного чата: что сказал ребёнок и где его искать. */
export interface EscalationNotice {
  childChatId: string;
  /** Имя группы разделения или заголовок ребёнка. */
  childTitle: string;
  text: string;
  /** `block` — ребёнок сказал сам; `auto-pick` — автономия взяла вопрос с меткой critical. */
  source: 'block' | 'auto-pick';
  at: string;
}

/**
 * Автовыбор под автономией: строка в ленте ЭТОГО чата, приглушённая. Человек
 * видит, что вопрос был и что за него выбрали.
 */
export interface AutonomousPick {
  question: string;
  picked: string;
  at: string;
}

/** Метка в тексте отказа брокера: по ней лента узнаёт автовыбор и рисует его строкой. */
// Метка — через `blockLang`, как у соседей (F-330).
export const AUTONOMOUS_PICK_MARKER = blockLang('autonomous-pick');

const RECOMMENDED = /\(recommended\)/i;
const CRITICAL = /^\s*\[?critical\]?\s*$/i;

interface QuestionOption {
  label?: unknown;
}
interface QuestionItem {
  question?: unknown;
  header?: unknown;
  options?: unknown;
}

export interface RecommendedPick {
  question: string;
  label: string;
  critical: boolean;
}

/**
 * Рекомендованный ответ на каждый вопрос вызова `AskUserQuestion`. Вариант с
 * «(Recommended)» в подписи — единственный признак: первый вариант списка
 * рекомендацией не считается, иначе автономия отвечала бы за человека там, где
 * агент ничего не советовал. Хоть у одного вопроса рекомендации нет — `null`:
 * такой вызов идёт человеку как сегодня, целиком.
 *
 * `critical` — вопрос помечен заголовком `critical`: выбор всё равно делается,
 * но о нём сообщается в главный чат дерева.
 */
export function pickRecommended(input: unknown): RecommendedPick[] | null {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const picks: RecommendedPick[] = [];
  for (const raw of questions as QuestionItem[]) {
    const options = Array.isArray(raw?.options) ? (raw.options as QuestionOption[]) : [];
    const recommended = options.find(
      (option) => typeof option?.label === 'string' && RECOMMENDED.test(option.label),
    );
    if (!recommended || typeof raw.question !== 'string') return null;
    picks.push({
      question: raw.question,
      label: String(recommended.label),
      critical: typeof raw.header === 'string' && CRITICAL.test(raw.header),
    });
  }
  return picks;
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

// --- Дополнения полосы чата (26.09.2026): хранение заметок и лента автовыбора ---

/** Заметка главного чата, как её отдаёт панель: с ключом и отметкой прочтения. */
export interface ChatEscalationEntry extends EscalationNotice {
  /** Ключ заметки: ребёнок + текст — один и тот же блок дважды не записывается. */
  id: string;
  read: boolean;
}

/** `GET /api/chat/escalations`: заметки по главным чатам деревьев. */
export interface ChatEscalationsView {
  chats: Record<string, ChatEscalationEntry[]>;
}

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
