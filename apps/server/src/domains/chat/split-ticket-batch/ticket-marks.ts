import { splitTicketKey, type SplitTicketView } from '@agentdeck/contracts/split-tickets';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { coded } from '../../../lib/server-text/server-text.ts';

/**
 * Отметки находок групп — «заведено в трекере» и «взято в чат» — и замки,
 * которые не дают одной находке стать двумя задачами.
 *
 * Один объект на конвейер: «Завести» одной строки (L277) и «Опубликовать в
 * Jira» всего списка делят одни и те же слоты — иначе строка, заведённая
 * кнопкой, пока шла публикация, уехала бы в трекер второй раз.
 */
export interface TicketMarksStore {
  get(parentChatId: string): SplitPlanRecord | undefined;
  set(record: SplitPlanRecord): void;
}

export interface TicketFiledResult {
  key: string;
  created: boolean;
  /** Находки, которые этот вызов отметил (при `created: false` — пусто). */
  keys: string[];
  /** Этот вызов не завёл задачу, а прокомментировал уже открытую. */
  commented?: true;
}

/**
 * Что сделал трекер: ключ новой задачи — или ключ уже открытой с `commented`,
 * куда находки ушли комментарием (отметка помнит это для строки хаба).
 */
export type TicketFiling = string | { key: string; commented: true };

export class SplitTicketMarks {
  /** Заводы в полёте по находке: `parent|key` → задача трекера, которая её заведёт. */
  private readonly filing = new Map<string, Promise<TicketFiling>>();
  /** Публикации разом по родителю — по одной: вторая ждёт первую и видит её отметки. */
  private readonly batches = new Map<string, Promise<unknown>>();

  private readonly store: TicketMarksStore;
  private readonly now: () => Date;

  constructor(store: TicketMarksStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  /** Находки записи с этими ключами — первая встреча каждого ключа (как в хабе). */
  private ticketsOf(record: SplitPlanRecord, keys: readonly string[]): SplitTicketView[] {
    const found = new Map<string, SplitTicketView>();
    for (const group of record.groups) {
      for (const ticket of group.tickets ?? []) {
        const key = splitTicketKey(ticket);
        if (keys.includes(key) && !found.has(key)) found.set(key, ticket);
      }
    }
    return keys.flatMap((key) => {
      const ticket = found.get(key);
      return ticket ? [ticket] : [];
    });
  }

  /** Отметка ключа в любой группе записи: заведена ли находка где-нибудь. */
  private filedKey(record: SplitPlanRecord | undefined, key: string): string | undefined {
    for (const group of record?.groups ?? []) {
      for (const ticket of group.tickets ?? []) {
        if (ticket.filed && splitTicketKey(ticket) === key) return ticket.filed.key;
      }
    }
    return undefined;
  }

  /**
   * Завести ОДНУ задачу на эти находки. Ключа нет в записи — отказ: модель или
   * тело запроса не подсовывают находок. Находка уже заведена — не заводится
   * снова; заводится сейчас другим вызовом — этот ждёт его и перечитывает
   * запись. Не осталось открытых — ответ с уже заведённым ключом, `created:
   * false`. Отметка — на каждой группе с той же находкой.
   */
  async fileKeys(
    parentChatId: string,
    keys: readonly string[],
    create: (tickets: SplitTicketView[]) => Promise<TicketFiling>,
  ): Promise<TicketFiledResult> {
    const record = this.store.get(parentChatId);
    const unique = [...new Set(keys)];
    if (!record || unique.length === 0 || this.ticketsOf(record, unique).length !== unique.length) {
      throw coded(new Error('Такого предложения тикета в разделении нет'), 'split-ticket-missing');
    }
    // Чужой завод тех же находок — дождаться (его отказ — и наш: второй клик не
    // повторяет запрос, который мог дойти до трекера), потом перечитать запись.
    for (const key of unique) {
      const running = this.filing.get(`${parentChatId}|${key}`);
      if (running) await running;
    }
    const fresh = this.store.get(parentChatId);
    const open = unique.filter((key) => !this.filedKey(fresh, key));
    if (open.length === 0 || !fresh) {
      const known = this.filedKey(fresh, unique[0] ?? '') ?? '';
      return { key: known, created: false, keys: [] };
    }
    const job = create(this.ticketsOf(fresh, open));
    for (const key of open) this.filing.set(`${parentChatId}|${key}`, job);
    // Отказ трекера ждущий получает своим `await` — здесь не «необработанный».
    job.catch(() => undefined);
    try {
      const done = await job;
      const issueKey = typeof done === 'string' ? done : done.key;
      const commented = typeof done !== 'string';
      // Запись перечитывается: пока трекер отвечал, конвейер мог её сменить.
      const latest = this.store.get(parentChatId);
      if (latest) {
        const at = this.now().toISOString();
        for (const group of latest.groups) {
          for (const ticket of group.tickets ?? []) {
            if (!open.includes(splitTicketKey(ticket))) continue;
            ticket.filed = { key: issueKey, at, ...(commented ? { commented: true } : {}) };
          }
        }
        this.store.set(latest);
      }
      return {
        key: issueKey,
        created: true,
        keys: open,
        ...(commented ? { commented: true } : {}),
      };
    } finally {
      for (const key of open) {
        if (this.filing.get(`${parentChatId}|${key}`) === job) {
          this.filing.delete(`${parentChatId}|${key}`);
        }
      }
    }
  }

  /**
   * Публикация разом — по одной на родителя: двойной клик и вторая вкладка
   * становятся в очередь, а не заводят тот же список параллельно.
   */
  async batch<T>(parentChatId: string, run: () => Promise<T>): Promise<T> {
    const before = this.batches.get(parentChatId) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(run);
    this.batches.set(parentChatId, next);
    try {
      return await next;
    } finally {
      if (this.batches.get(parentChatId) === next) this.batches.delete(parentChatId);
    }
  }

  /**
   * «Взято в чат»: отметка на каждой группе с этими находками. Возвращает,
   * сколько находок отмечено; уже заведённые и уже взятые не трогаются.
   */
  markTaken(parentChatId: string, keys: readonly string[], chatId: string): number {
    const record = this.store.get(parentChatId);
    if (!record) return 0;
    const at = this.now().toISOString();
    const marked = new Set<string>();
    for (const group of record.groups) {
      for (const ticket of group.tickets ?? []) {
        const key = splitTicketKey(ticket);
        if (!keys.includes(key) || ticket.filed || ticket.taken) continue;
        ticket.taken = { chatId, at };
        marked.add(key);
      }
    }
    if (marked.size > 0) this.store.set(record);
    return marked.size;
  }
}
