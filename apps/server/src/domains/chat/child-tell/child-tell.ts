import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import type { ChatEvent } from '../ChatRunner/ChatRunner.ts';

/**
 * Канал агента-родителя к ребёнку (Д7).
 *
 * Написать ребёнку мог только человек — руками в его чате или ответом в хабе.
 * Теперь и родитель: блок в его ответе
 *
 *     ```agentdeck:tell 2
 *     текст
 *     ```
 *
 * панель в конце хода доставляет в чат группы 2 (номер — из сводки детей, Д6)
 * продолжением ЕГО сессии. Занят ребёнок — сообщение ждёт конца его хода: второй
 * агент в той же копии — это Д8. Адресат ищется только в разделении самого
 * родителя, поэтому чужое дерево недостижимо.
 *
 * Очередь живёт в памяти: перезапуск панели её теряет, и это сказано родителю
 * заметкой «в очереди», а не обещано молча.
 */

const TELL = /```agentdeck:tell[ \t]+(\d+)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

export interface ChildTell {
  /** Номер группы в сводке, с единицы. */
  to: number;
  text: string;
}

export function parseTells(text: string): ChildTell[] {
  return [...text.matchAll(TELL)]
    .map(([, to = '', body = '']) => ({ to: Number(to), text: body.trim() }))
    .filter((tell) => tell.to > 0 && tell.text);
}

/** Как сообщение выглядит у ребёнка: откуда оно, чтобы не принять его за слово человека. */
export function tellPrompt(text: string): string {
  return `Message from the parent conversation (passed on by the panel):\n\n${text}`;
}

/** Что панель запускает — тот же старт продолжения, что у push и повтора ревью (Д8, Д4). */
export type TellStart = (input: {
  chatId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  stage: 'tell';
  fromAliases: string[];
  title?: string;
  resume: { sessionId: string };
  /** Вводная на случай, когда разговор продолжить нельзя и ход идёт новым. */
  fresh?: string;
  /** Вводная нового разговора вместо остывшего (рычаг экономии групп). */
  cold?: string;
  base?: string;
}) => { started: boolean; busy?: boolean };

export interface ChildTellDeps {
  split: (keys: readonly string[]) => SplitPlanView | undefined;
  /** Все ключи разговора группы: временный `new-…` и настоящий. */
  aliasesOf: (chatId: string) => string[];
  /** Модель и глубина группы — из её связи. */
  settingsOf: (chatId: string) => { model?: string; effort?: string };
  start: TellStart;
  /** Заметка в ленту родителя. */
  notify: (parentKeys: readonly string[], event: ChatEvent) => void;
  log: (message: string, error?: unknown) => void;
  /**
   * Отложить доставку из очереди: конец хода ребёнка приходит ИЗНУТРИ его
   * завершения, и новый старт того же разговора там заменил бы закрывающийся.
   */
  defer?: (run: () => void) => void;
  /**
   * Группу остановил человек (пауза): слово родителя её не будит, а ждёт в очереди
   * и уходит после хода, который заведёт сам человек — «Продолжить» или своё
   * сообщение. Иначе агент-родитель снимал паузу, которую человек только что
   * поставил (R13, 19.10). Слова самой панели (`send`) сюда не смотрят: их
   * конвейер шлёт по статусу группы, а «Продолжить» с паузы идёт как раз этим путём.
   */
  held?: (chatId: string) => boolean;
}

interface Pending {
  chatId: string;
  prompt: string;
  cwd: string;
  title: string;
  fresh?: string;
  cold?: string;
  /** Ветка, от которой отведена копия группы (вводная считает коммиты от неё). */
  base?: string;
}

type Delivery = 'sent' | 'queued' | 'refused';

export class ChildTells {
  private readonly deps: ChildTellDeps;
  private readonly queue: Pending[] = [];

  constructor(deps: ChildTellDeps) {
    this.deps = deps;
  }

  /** Ход родителя кончился: доставить его блоки `agentdeck:tell`. */
  parentFinished(parentKeys: readonly string[], text: string): void {
    const tells = parseTells(text);
    if (tells.length === 0) return;
    const split = this.deps.split(parentKeys);
    if (!split) {
      this.deps.log('child tell: no split for parent', parentKeys.join(','));
      return;
    }

    const by: Record<Delivery, string[]> = { sent: [], queued: [], refused: [] };
    for (const tell of tells) {
      const group = split.groups[tell.to - 1];
      const title = group ? `«${group.title}»` : `#${tell.to}`;
      if (!group?.chatId || !group.path) {
        by.refused.push(title);
        continue;
      }
      const pending = {
        chatId: group.chatId,
        prompt: tellPrompt(tell.text),
        cwd: group.path,
        title,
      };
      if (this.deps.held?.(group.chatId)) {
        this.queue.push(pending);
        by.queued.push(title);
        continue;
      }
      by[this.deliver(pending)].push(title);
    }

    const params = {
      sent: by.sent.join(', ') || '—',
      queued: by.queued.join(', ') || '—',
      refused: by.refused.join(', ') || '—',
    };
    this.deps.notify(parentKeys, {
      kind: 'notice',
      code: 'childTold',
      text: serverText('child-tell-notice', params),
      textCode: 'child-tell-notice',
      textParams: params,
    });
  }

  /** Ход разговора кончился: если ему что-то ждало в очереди — доставить. */
  childFinished(keys: readonly string[]): void {
    const index = this.queue.findIndex((pending) =>
      this.deps.aliasesOf(pending.chatId).some((key) => keys.includes(key)),
    );
    if (index < 0) return;
    // Ход кончился уже на паузе (ход, который «Стоп» снять не смог, F-145): очередь
    // ждёт старта, который заведёт человек.
    if (this.deps.held?.(this.queue[index]?.chatId ?? '')) return;
    const [pending] = this.queue.splice(index, 1);
    if (!pending) return;
    const run = (): void => {
      if (this.deliver(pending) === 'refused') {
        this.deps.log('child tell: queued message refused', pending.chatId);
      }
    };
    (this.deps.defer ?? ((next) => setTimeout(next, 0)))(run);
  }

  /**
   * Сообщение панели группе тем же каналом — продолжением её сессии, занятой
   * группе после хода (напоминание доставки, WP1b). Текст уходит как есть:
   * это слово панели, а не родителя.
   */
  send(message: Pending): Delivery {
    return this.deliver(message);
  }

  private deliver(pending: Pending): Delivery {
    const aliases = this.deps.aliasesOf(pending.chatId);
    // Продолжается НАСТОЯЩАЯ сессия: под временным ключом CLI разговор не хранит.
    const session = aliases.find((key) => !key.startsWith('new-'));
    // Сессии ещё нет — ребёнок в первом ходе, то есть занят.
    if (!session) {
      this.queue.push(pending);
      return 'queued';
    }
    const outcome = this.deps.start({
      chatId: session,
      prompt: pending.prompt,
      cwd: pending.cwd,
      ...this.deps.settingsOf(pending.chatId),
      stage: 'tell',
      fromAliases: aliases,
      resume: { sessionId: session },
      ...(pending.fresh ? { fresh: pending.fresh } : {}),
      ...(pending.cold ? { cold: pending.cold } : {}),
      ...(pending.base ? { base: pending.base } : {}),
    });
    if (outcome.started) return 'sent';
    if (outcome.busy) {
      this.queue.push(pending);
      return 'queued';
    }
    return 'refused';
  }
}
