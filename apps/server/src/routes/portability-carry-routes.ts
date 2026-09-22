import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CarryApplyAnswer, CarryPlan } from '@agentdeck/contracts/portable-carry';
import { foreignChatKey, parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ServerContext } from '../context.ts';
import { getActiveProvider, listProviders } from '../providers/registry.ts';
import { readChatTask, readChats } from '../domains/chat/ChatHistory.ts';
import type { ChatRunRegistry } from '../domains/chat/ChatRunRegistry.ts';
import type { ChatSession } from '../domains/chat/ChatSession.ts';
import { CHAIN_MAX_AGE_MS, type HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { initiativePrompt } from '../domains/chat/initiative.ts';
import { appendMessage, createChat, listChats, readChat } from '../domains/provider-chat/store.ts';
import type { ProviderChatService } from '../domains/provider-chat.ts';
import {
  carryChats,
  planCarry,
  type CarrySourceChat,
} from '../domains/portability/carry-context.ts';
import { continuationStarter } from './chat/handoff-routes.ts';
import { projectsDir } from './chat/paths.ts';
import { activateGroupsQuietly } from '../domains/group-activation.ts';

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
  providerChats: ProviderChatService;
}

export function registerPortabilityCarryRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: PortabilityCarryDeps,
): void {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;
  const appData = (): string => ctx.location.paths.appData;

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
    (request, reply): CarryApplyAnswer | FastifyReply => {
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
      const outcomes = carryChats(sourcesFor(target.id), keys, {
        chains: deps.chains,
        targetName: target.name,
        /**
         * Заводит разговор у НОВОГО CLI. Две ветки, потому что разговоры
         * устроены по-разному: у Claude прогон в реестре под временным ключом,
         * у чужого — запись в собственном хранилище панели. Ветка Claude —
         * общий с продолжением стартер: своя копия наследования прав, модели и
         * набора проекта разошлась бы с ним на первой же правке.
         */
        open: (input) => {
          if (target.id === 'claude') {
            const key = `new-${Date.now()}`;
            const started = continuationStarter(app, ctx, deps, selfBaseUrl, {
              fromAliases: [],
              allowEdits: false,
            })({ chatId: key, prompt: input.prompt, cwd: input.cwd, title: input.title });
            return started
              ? { ok: true, key, chatId: key }
              : { ok: false, failure: 'run_not_started' };
          }

          // Набор проекта — до запуска и здесь тоже: без него у нового CLI
          // молча не действуют правила и скиллы, привязанные к каталогу.
          activateGroupsQuietly(
            { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
            input.cwd,
            (error) => app.log.warn({ err: error }, 'group activation failed'),
          );
          const created = createChat(appData(), target.id, {
            title: input.title,
            workdir: input.cwd,
          });
          if (!created) return { ok: false, failure: 'chat_not_created' };
          const prefix = initiativePrompt(ctx.store.getSettings(), { foreign: true });
          const outcome = deps.providerChats.send(
            appData(),
            target.id,
            created.id,
            { text: input.prompt },
            {
              provider: target,
              models: ctx.models.current(target.modelVendors ?? []).models,
              ...(prefix ? { systemPrefix: prefix } : {}),
            },
          );
          // Разговор уже заведён, а задание в него не ушло: это ТРЕТИЙ отказ, и
          // человеку он говорит другое — чинить надо CLI, а пустой разговор у
          // цели уже лежит.
          return outcome.ok
            ? { ok: true, key: foreignChatKey(target.id, created.id), chatId: created.id }
            : { ok: false, failure: 'send_failed' };
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

      return { target: target.id, outcomes };
    },
  );
}
