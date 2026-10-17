import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { readJsonFile } from '../../../lib/safe-io/read.ts';
import { writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { childrenBrief, statusBrief } from '../children-brief/children-brief.ts';

/**
 * Модель лёгкого чата: ответ о ходе групп собирается из готовой сводки, и
 * глубины старшей модели он не требует. Назначенная, она же стоит в шапке
 * чата — следующий вопрос человека уходит на ней, пока он не выберет другую.
 */
export const STATUS_MODEL = 'sonnet';
export const STATUS_EFFORT = 'medium';

/** Сколько лёгких чатов помнить: старейшие уходят первыми. */
const LIMIT = 200;
const TOUCH_MS = 86_400_000;

interface Entry {
  /** Ключ родителя разделения — тот, под которым лежит запись конвейера. */
  parent: string;
  at: string;
}

/**
 * Лёгкие чаты вопросов о ходе групп (5.1 плана экономии): какой чат о каком
 * разделении спрашивает.
 *
 * Вопрос «как там группы?» родителю стоил перезаписи его остывшего кеша
 * (160 тыс. токенов). Лёгкий чат получает ту же сводку групп в начале КАЖДОГО
 * хода — для этого реестру прогонов нужно знать его родителя и после смены
 * ключа (`new-…` → `sessionId`), и после перезапуска панели. Связью дерева
 * (`ChatLink`) это быть не может: связь сделала бы чат ребёнком — строкой хаба
 * и прогоном с допиской группы.
 */
export class StatusChats {
  private entries: Record<string, Entry> | undefined;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Заведён лёгкий чат о разделении `parent`. */
  add(chatId: string, parent: string): void {
    const entries = this.load();
    entries[chatId] = { parent, at: new Date().toISOString() };
    this.save(entries);
  }

  /** CLI выдал разговору настоящий ключ — лёгкий чат узнаётся и под ним. */
  alias(chatId: string, sessionId: string): void {
    const entries = this.load();
    const entry = entries[chatId];
    if (!entry || chatId === sessionId || entries[sessionId]) return;
    entries[sessionId] = entry;
    this.save(entries);
  }

  /** Чат не завёлся — записи о нём не остаётся. */
  remove(chatId: string): void {
    const entries = this.load();
    if (!Object.hasOwn(entries, chatId)) return;
    delete entries[chatId];
    this.save(entries);
  }

  /**
   * Родитель разделения, о котором спрашивает разговор с этими ключами. Ход
   * освежает запись (не чаще раза в сутки): предел вытесняет давно молчащие
   * чаты, а не тот, которым пользуются, — вытесненный продолжился бы полным
   * чатом с MCP и правками (ревью B1-F9).
   */
  parentOf(keys: readonly string[]): string | undefined {
    const entries = this.load();
    for (const key of keys) {
      if (!Object.hasOwn(entries, key)) continue;
      const entry = entries[key]!;
      if (Date.now() - Date.parse(entry.at) > TOUCH_MS) {
        entry.at = new Date().toISOString();
        this.save(entries);
      }
      return entry.parent;
    }
    return undefined;
  }

  /** Модель и глубина, назначенные лёгкому чату, — для шапки и списка чатов. */
  assignedOf(chatId: string): { model: string; effort: string } | undefined {
    return Object.hasOwn(this.load(), chatId)
      ? { model: STATUS_MODEL, effort: STATUS_EFFORT }
      : undefined;
  }

  private load(): Record<string, Entry> {
    this.entries ??= readJsonFile<Record<string, Entry>>(this.file, {});
    return this.entries;
  }

  private save(entries: Record<string, Entry>): void {
    const kept = Object.entries(entries)
      .sort(([, a], [, b]) => b.at.localeCompare(a.at))
      .slice(0, LIMIT);
    this.entries = Object.fromEntries(kept);
    try {
      writeJsonFile(this.file, this.entries);
    } catch {
      // Не записалось — память процесса всё равно знает чат до перезапуска.
    }
  }
}

/**
 * Сводка в начале хода: родителю — его детей (Д6), лёгкому чату — групп того
 * разделения, о котором он спрашивает, свежая на каждом ходе.
 */
export function briefWithStatus(
  view: (keys: readonly string[]) => SplitPlanView | undefined,
  chats: Pick<StatusChats, 'parentOf'>,
  now: () => Date = () => new Date(),
): (keys: readonly string[]) => string | undefined {
  return (keys) => {
    const own = childrenBrief(view(keys));
    if (own) return own;
    const parent = chats.parentOf(keys);
    return parent ? statusBrief(view([parent]), now()) : undefined;
  };
}
