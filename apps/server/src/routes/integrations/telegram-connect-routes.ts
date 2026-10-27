import type { FastifyInstance } from 'fastify';
import type { TelegramConnectView } from '@agentdeck/contracts/telegram-answers';
import type { ServerContext } from '../../context.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { readIntegrations, writeSettings } from '../../domains/integrations/store/store.ts';
import { sendMessage } from '../../domains/notify/telegram-answers/bot-api.ts';
import { connectedText } from '../../domains/notify/telegram-answers/commands.ts';
import type { ConnectWindow } from '../../domains/notify/telegram-answers/connect.ts';
import type { TelegramAnswersService } from '../../domains/notify/telegram-answers/service.ts';
import type { SentLog } from '../../domains/notify/telegram-answers/sent-log.ts';
import type { AnswersStore } from '../../domains/notify/telegram-answers/store.ts';

/**
 * Подключение бота командой /start: открыть окно, прочитать его состояние,
 * закрыть, подтвердить кандидата.
 *
 * Все четыре маршрута — только для человека (`human:secret` журнала
 * возможностей, ворота `ledger-gate.ts`): подтверждение пишет, чей чат получает
 * уведомления и чьи нажатия решают права, а процесс модели не вправе назначить
 * владельцем себя.
 */

/** «Агент ждёт тебя» — события, которые подключение включает само. */
const WAITING_EVENTS = ['permission', 'question'] as const;

export interface TelegramConnectRouteDeps {
  connect: ConnectWindow;
  service: TelegramAnswersService;
  answers: AnswersStore;
  notifyToken: () => string | undefined;
  /** Приветствие — тоже сообщение бота: /clear его уберёт. */
  sentLog?: SentLog;
}

export function registerTelegramConnectRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: TelegramConnectRouteDeps,
): void {
  app.get('/api/integrations/telegram/connect', (): TelegramConnectView => deps.connect.status());

  app.post('/api/integrations/telegram/connect', () => deps.connect.open());

  app.post('/api/integrations/telegram/connect/cancel', () => deps.connect.cancel());

  /**
   * «Это я»: чат уведомлений и владелец ответов — id кандидата, уведомления и
   * ответы включаются, бот здоровается в этом чате на языке панели.
   */
  app.post('/api/integrations/telegram/connect/confirm', async (_request, reply) => {
    const candidate = deps.connect.take();
    if (!candidate) {
      return reply.code(409).send({
        code: 'telegram_connect_no_candidate',
        message: serverText('telegram-connect-no-candidate'),
        messageCode: 'telegram-connect-no-candidate',
      });
    }
    const telegram = readIntegrations(ctx.store).telegram;
    // Подключаются, чтобы звали, когда агент ждёт: вопрос и разрешение — в подписке,
    // иначе включённые ниже ответы с кнопками висели бы под снятой галочкой карточки.
    const events = [...new Set([...telegram.events, ...WAITING_EVENTS])];
    writeSettings(ctx.store, 'telegram', {
      ...telegram,
      enabled: true,
      chatId: candidate.id,
      events,
    });
    const current = deps.answers.settings;
    deps.answers.setSettings({
      ...current,
      enabled: true,
      ownerId: candidate.id,
      ownerName: `${candidate.firstName || candidate.id}${candidate.username ? ` (@${candidate.username})` : ''}`,
    });
    const view = deps.connect.confirmed(candidate);
    await deps.service.restart();
    const token = deps.notifyToken();
    if (token) {
      const language = ctx.store.getSettings().language === 'en' ? 'en' : 'ru';
      const sent = await sendMessage(token, candidate.id, connectedText(language));
      if (sent.ok) {
        deps.sentLog?.record({
          chatId: candidate.id,
          messageId: sent.result.message_id,
          at: Date.now(),
          kind: 'bot',
        });
      } else {
        app.log.warn(`telegram connect: greeting failed (${sent.status})`);
      }
    }
    return view;
  });
}
