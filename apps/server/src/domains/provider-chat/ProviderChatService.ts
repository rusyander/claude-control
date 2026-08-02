import type {
  ProviderChatEvent,
  ProviderChatMessage,
  ProviderChatStatus,
  ProviderChatTransport,
} from '@claude-control/contracts';
import {
  ProviderChatRun,
  type ProviderChatRunLike,
  type ProviderChatRunOptions,
} from './ProviderChatRun.ts';
import { appendMessage, readChat } from './store.ts';
import { composeUserMessage } from './prompt.ts';

/**
 * Живые ответы чужих провайдеров: прогон принадлежит серверу, а не запросу.
 *
 * Та же причина, по которой у Claude есть реестр прогонов: закрытая вкладка,
 * обрыв связи или переход на другую страницу не должны убивать ответ на
 * полуслове. Здесь это ещё важнее — у одноразового CLI нет никакого «продолжить
 * с того места», второй попытки просто не будет.
 *
 * Накопленный текст живёт в `partial`, поэтому вернувшаяся вкладка догоняет
 * пропущенное одним запросом состояния, без хитрой нумерации событий: ответ —
 * это один растущий кусок текста, а не поток разнородных шагов.
 */

export interface ProviderChatSubscriber {
  send: (event: ProviderChatEvent) => void;
  close: () => void;
}

/** Сколько держать завершённый прогон — окно на переподключение вкладки. */
const GRACE_MS = 60_000;

interface LiveRun {
  providerId: string;
  appDataDir: string;
  run: ProviderChatRunLike;
  partial: string;
  transport?: ProviderChatTransport;
  subscribers: Set<ProviderChatSubscriber>;
  isRunning: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** Что нужно прогону сверх самого разговора (подменяется в тестах). */
export type ProviderChatRunDeps = Omit<
  ProviderChatRunOptions,
  'history' | 'chatId' | 'appDataDir' | 'workdir'
>;

export interface SendOutcome {
  ok: boolean;
  /** Записанная реплика пользователя (для мгновенного показа). */
  message?: ProviderChatMessage;
  /** Машинная причина отказа: разговора нет либо ответ уже идёт. */
  reason?: 'not_found' | 'already_running';
}

export class ProviderChatService {
  private runs = new Map<string, LiveRun>();
  private readonly createRun: () => ProviderChatRunLike;

  /**
   * Фабрика прогона присваивается вручную: сервер исполняет TypeScript без
   * сборки, а `parameter properties` в этом режиме не поддерживаются.
   */
  constructor(createRun: () => ProviderChatRunLike = () => new ProviderChatRun()) {
    this.createRun = createRun;
  }

  /** Задать вопрос: реплика пользователя пишется сразу, ответ идёт потоком. */
  send(
    appDataDir: string,
    providerId: string,
    chatId: string,
    input: { text: string; attachments?: string[] },
    deps: ProviderChatRunDeps,
  ): SendOutcome {
    const existing = this.runs.get(chatId);
    if (existing?.isRunning) return { ok: false, reason: 'already_running' };

    const chat = readChat(appDataDir, providerId, chatId);
    if (!chat) return { ok: false, reason: 'not_found' };

    const content = composeUserMessage(input.text, input.attachments);
    const message = appendMessage(appDataDir, providerId, chatId, { role: 'user', content });
    if (!message) return { ok: false, reason: 'not_found' };

    const live: LiveRun = {
      providerId,
      appDataDir,
      run: this.createRun(),
      partial: '',
      subscribers: existing?.subscribers ?? new Set(),
      isRunning: true,
    };
    if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
    this.runs.set(chatId, live);

    const history = [...chat.messages, message];

    void live.run
      .start(
        {
          ...deps,
          history,
          chatId,
          appDataDir,
          ...(chat.workdir ? { workdir: chat.workdir } : {}),
        },
        (event) => {
          if (event.type === 'delta') {
            live.partial += event.text;
            this.broadcast(live, { type: 'delta', text: event.text });
            return;
          }

          if (event.type === 'done') {
            live.transport = event.transport;
            const stored = appendMessage(appDataDir, providerId, chatId, {
              role: 'assistant',
              content: event.reply,
              transport: event.transport,
            });
            this.finish(chatId, live, {
              type: 'done',
              ...(stored ? { message: stored } : {}),
            });
            return;
          }

          appendMessage(appDataDir, providerId, chatId, {
            role: 'assistant',
            content: event.error,
            failed: true,
          });
          this.finish(chatId, live, { type: 'error', error: event.error, reason: event.reason });
        },
      )
      .catch((error: unknown) => {
        // Прогон упал мимо собственной обработки ошибок. След в переписке нужен
        // тот же самый: иначе вопрос остался бы без ответа и без объяснения.
        const text = error instanceof Error ? error.message : String(error);
        appendMessage(appDataDir, providerId, chatId, {
          role: 'assistant',
          content: text,
          failed: true,
        });
        this.finish(chatId, live, { type: 'error', error: text, reason: 'cli_error' });
      });

    return { ok: true, message };
  }

  /**
   * Подключиться к идущему ответу. Возвращает отписку.
   *
   * Подключение к тому, что уже кончилось, закрывается сразу: держать открытым
   * пустой поток значит показывать «ответ идёт» там, где ответ давно записан, —
   * а вкладка ждала бы его до перезагрузки страницы.
   */
  subscribe(chatId: string, subscriber: ProviderChatSubscriber): () => void {
    const live = this.runs.get(chatId);
    if (!live?.isRunning) {
      subscriber.close();
      return () => {};
    }

    live.subscribers.add(subscriber);
    return () => live.subscribers.delete(subscriber);
  }

  /** Состояние разговора: идёт ли ответ и что уже напечатано. */
  status(chatId: string): ProviderChatStatus {
    const live = this.runs.get(chatId);
    return {
      chatId,
      isRunning: Boolean(live?.isRunning),
      partial: live?.partial ?? '',
      ...(live?.transport ? { transport: live.transport } : {}),
    };
  }

  /**
   * Остановить ответ. Сказанное до остановки остаётся ответом и попадает в
   * переписку: молча выбрасывать уже полученный текст было бы враньём про то,
   * что модель сделала.
   */
  stop(chatId: string): boolean {
    const live = this.runs.get(chatId);
    if (!live?.isRunning) return false;

    live.run.stop();
    this.broadcast(live, { type: 'stopped' });
    return true;
  }

  /** Погасить всё разом — при выходе сервера. */
  stopAll(): void {
    for (const [chatId] of this.runs) this.stop(chatId);
  }

  private broadcast(live: LiveRun, event: ProviderChatEvent): void {
    for (const subscriber of live.subscribers) subscriber.send(event);
  }

  private finish(chatId: string, live: LiveRun, event: ProviderChatEvent): void {
    if (!live.isRunning) return;
    live.isRunning = false;
    this.broadcast(live, event);
    for (const subscriber of live.subscribers) subscriber.close();
    live.subscribers.clear();

    live.cleanupTimer = setTimeout(() => {
      if (this.runs.get(chatId) === live) this.runs.delete(chatId);
    }, GRACE_MS);
    live.cleanupTimer.unref?.();
  }
}
