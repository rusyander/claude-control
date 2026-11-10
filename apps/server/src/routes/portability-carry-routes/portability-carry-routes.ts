import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CarryApplyAnswer, CarryPlan } from '@agentdeck/contracts/portable-carry';
import { foreignChatKey, parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ServerContext } from '../../context.ts';
import { getActiveProvider, listProviders } from '../../providers/registry.ts';
import { readChatTask, readChats } from '../../domains/chat/ChatHistory/ChatHistory.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import {
  CHAIN_MAX_AGE_MS,
  type HandoffChains,
} from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { appendMessage, listChats, readChat } from '../../domains/provider-chat/store/store.ts';
import {
  carryChats,
  planCarry,
  type CarrySourceChat,
} from '../../domains/portability/carry-context/carry-context.ts';
import {
  cancelCarriedResends,
  type CarryCancelDeps,
} from '../../domains/chat/core-run/carry-cancel.ts';
import {
  coreChatBookPath,
  createCoreChatBook,
} from '../../domains/chat/core-run/core-chat-book.ts';
import { createCoreChatPort } from '../../domains/chat/core-run/core-chat-port.ts';
import { createCoreCaller } from '../../domains/core-ask/core-ask.ts';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';
import { continuationStarter } from '../chat/handoff-routes.ts';
import { projectsDir } from '../chat/paths.ts';

/**
 * Незакрытая работа переезжает вместе со средой (П6.1).
 *
 * Маршрутов два, и они той же формы, что у переноса среды: список, который
 * НИЧЕГО не делает, и применение выбранного человеком. Автоматом при смене
 * провайдера перенос не идёт намеренно — он запускает прогоны у нового CLI и
 * тратит его лимиты, а такое панель без спроса не делает.
 *
 * Откуда берутся кандидаты: разговоры ВСЕХ провайдеров, кроме активного. Именно
 * так выглядит «переключился и хочу продолжить там же»: работа осталась у того,
 * кого только что сменили. Свои разговоры активный CLI продолжает кнопкой
 * перезапуска — для этого перенос не нужен.
 *
 * Чего здесь нет: переписки. Транскрипт Claude в чужом формате не существует, и
 * панель его не выдумывает (уровень `×` в матрице верности). Переезжает то же,
 * чем живёт продолжение в чистой сессии, — файл-опора в общем рабочем каталоге
 * и исходное задание цепочки.
 */

/** Что маршрутам нужно сверх контекста. Всё это переживает запрос. */
export interface PortabilityCarryDeps {
  runs: ChatRunRegistry;
  chains: HandoffChains;
  session: ChatSession;
  /** Книга и ручки чата ядра (R6); нет — книга на диске панели и ядро этого дома. */
  coreChat?: CarryCancelDeps;
}

export function registerPortabilityCarryRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: PortabilityCarryDeps,
): void {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;
  const appData = (): string => ctx.location.paths.appData;
  let coreChat = deps.coreChat;
  const coreChatDeps = (): CarryCancelDeps =>
    (coreChat ??= {
      book: createCoreChatBook(coreChatBookPath(appData())),
      port: createCoreChatPort(createCoreCaller(() => coreHomeOf())),
    });

  /**
   * Разговоры, которые панель вправе предложить к переносу.
   *
   * Отбор по возрасту здесь тоже есть, и это не вторая правда, а цена чтения:
   * у чужого CLI исходное задание лежит первой репликой переписки, и читать
   * файл каждого разговора за все времена ради списка незачем. Решение о
   * пригодности принимает `planCarry` — он видит те же поля и считает сам.
   */
  const sourcesFor = (targetId: string): CarrySourceChat[] => {
    const sources: CarrySourceChat[] = [];
    const fresh = (iso: string): boolean => Date.now() - Date.parse(iso) <= CHAIN_MAX_AGE_MS;

    for (const provider of listProviders()) {
      if (provider.id === targetId) continue;

      if (provider.id === 'claude') {
        const projects = projectsDir(ctx);
        for (const chat of readChats(projects)) {
          if (!chat.projectPath || !fresh(chat.updatedAt)) continue;
          sources.push({
            key: chat.id,
            providerId: provider.id,
            providerName: provider.name,
            chatId: chat.id,
            title: chat.title,
            cwd: chat.projectPath,
            updatedAt: Date.parse(chat.updatedAt),
            // Исходное задание берётся из НАЧАЛА транскрипта — там оно и
            // лежит, и размер файла эту цену не меняет (`readChatTask`).
            // Без него переезжала бы одна опора, а П6.1 обещает корневую
            // задачу: продолжение начиналось бы с «посмотри PROGRESS.md», не
            // зная, ради чего работа шла.
            task: readChatTask(projects, chat.id),
          });
        }
        continue;
      }

      for (const chat of listChats(appData(), provider.id)) {
        if (!chat.workdir || chat.messageCount === 0 || !fresh(chat.updatedAt)) continue;
        const detail = readChat(appData(), provider.id, chat.id);
        sources.push({
          key: foreignChatKey(provider.id, chat.id),
          providerId: provider.id,
          providerName: provider.name,
          chatId: chat.id,
          title: chat.title,
          cwd: chat.workdir,
          updatedAt: Date.parse(chat.updatedAt),
          task: detail?.messages.find((message) => message.role === 'user')?.content ?? '',
        });
      }
    }

    return sources;
  };

  /** Список: ничего не заводит, ничего не запускает. */
  app.get('/api/portability/carry', (): CarryPlan => {
    const target = getActiveProvider(ctx.store);
    return { target: target.id, candidates: planCarry(sourcesFor(target.id), deps) };
  });

  app.post<{ Body: { keys?: unknown } }>(
    '/api/portability/carry/apply',
    async (request, reply): Promise<CarryApplyAnswer | FastifyReply> => {
      const keys = Array.isArray(request.body?.keys)
        ? request.body.keys.filter((key): key is string => typeof key === 'string' && key !== '')
        : [];
      if (keys.length === 0) {
        return reply.code(400).send({
          message: 'Не выбрано ни одного разговора: переносить нечего.',
          messageCode: 'portability-carry-nothing-chosen',
        });
      }

      const target = getActiveProvider(ctx.store);
      const outcomes = await carryChats(sourcesFor(target.id), keys, {
        chains: deps.chains,
        targetName: target.name,
        /**
         * Заводит разговор у НОВОГО CLI — общим с продолжением стартером, каким бы CLI он ни был:
         * прогон реестра под временным ключом, прогон ядра называет разговор id сеанса, книга
         * чата ядра его помнит — и разговор в списке, открывается заново, его лента читается.
         * Прежде чужой CLI получал задачу ядра мимо реестра: ключом был id задачи, записи в
         * книге не было, и перенесённый разговор в список не попадал (этап 11, волна 3). Своя
         * копия наследования прав, модели и набора проекта разошлась бы со стартером на первой
         * же правке.
         */
        open: async (input) => {
          const key = `new-${Date.now()}`;
          const started = continuationStarter(app, ctx, deps, selfBaseUrl, {
            fromAliases: [],
            allowEdits: false,
          })({ chatId: key, prompt: input.prompt, cwd: input.cwd });
          return started
            ? { ok: true, key, chatId: key }
            : { ok: false, failure: 'run_not_started' };
        },
        /**
         * Слово в ленту разговора, каким бы провайдером он ни был. У чужого CLI
         * лента — его переписка в хранилище панели, и заметка ложится в неё
         * навсегда. У Claude лента — транскрипт самого Claude Code, панель в
         * него не пишет: сказать она может только в ИДУЩИЙ прогон, и разговор
         * без прогона заметки не получит. Ответ `false` едет в исход и
         * показывается человеку — умолчания здесь нет.
         */
        notice: (key, text) => {
          const foreign = parseForeignChatKey(key);
          if (!foreign) {
            return deps.runs.emitExternal(key, { kind: 'notice', code: 'contextCarried', text });
          }
          return Boolean(
            appendMessage(appData(), foreign.providerId, foreign.chatId, {
              role: 'notice',
              content: text,
            }),
          );
        },
      });

      // Перенос — выбор человека, где разговор продолжится: задача прежнего разговора, ждущая
      // сброса окна, отменяется, чтобы после сброса не слать то же слово прежнему CLI (R6).
      const carried = outcomes.filter((o) => o.carried).map((o) => o.key);
      if (carried.length > 0) {
        await cancelCarriedResends(carried, target.id, coreChatDeps());
      }

      return { target: target.id, outcomes };
    },
  );
}
