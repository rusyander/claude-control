import type { FastifyInstance } from 'fastify';
import {
  chatGroupSettingsSchema,
  type ChatEscalationsView,
  type ChatGroupChoice,
  type ChatGroupSettingsView,
} from '@agentdeck/contracts/chat-group-settings';
import type { ServerContext } from '../../context.ts';
import { chatGroupSettingsView, storeTreeReader } from '../../domains/chat/chat-autonomy.ts';
import { isSandboxPath } from '../../domains/chat/ChatArtifacts.ts';
import { findSessionCwd } from '../../domains/chat/ChatHistory.ts';
import { inactivePairPin } from '../../domains/chat/group-auto-pick.ts';
import { readChoice } from '../../domains/groups/choice.ts';
import { layoutForCwd } from '../../domains/project-git/copy-readiness.ts';
import { parseBody } from '../../lib/request-body.ts';
import { projectsDir } from './paths.ts';

/**
 * Группа и автономность ЧАТА и заметки главному чату дерева.
 *
 * Ключ разговора — любое его написание: вкладка до первого хода знает чат по
 * временному `new-…`, после — по `sessionId`; хранилище сводит оба к одной
 * записи. `PUT` заменяет СВОЁ у чата целиком: поля нет — «брать от родителя»
 * (у корня — умолчание), так ручная правка у ребёнка снимается тем же запросом.
 */
export function registerChatGroupSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const keysOf = (chatId: string, sessionId?: string): string[] =>
    sessionId && sessionId !== chatId ? [chatId, sessionId] : [chatId];

  /**
   * Проект чата — основная копия: из транскрипта (ребёнок разделения работает в
   * git-копии, и её группы — группы основной), у черновика без транскрипта — из
   * подсказки вкладки. Своё знание сервера сильнее подсказки: вкладка могла
   * открыть чат не из того проекта, в котором он шёл.
   */
  const projectOf = (keys: readonly string[], hint: string | undefined): string | undefined => {
    const lookup = [...keys, ctx.store.canonicalChatKey(keys[0] ?? '')];
    const cwd =
      lookup
        .filter((key) => /^[A-Za-z0-9-]+$/.test(key))
        .map((key) => findSessionCwd(projectsDir(ctx), key))
        .find(Boolean) ?? hint;
    if (!cwd || isSandboxPath(cwd)) return undefined;
    return layoutForCwd(cwd).mainDir ?? cwd;
  };

  app.get<{ Params: { chatId: string }; Querystring: { sessionId?: string } }>(
    '/api/chat/:chatId/group-settings',
    (request): ChatGroupSettingsView =>
      chatGroupSettingsView(
        storeTreeReader(ctx.store),
        keysOf(request.params.chatId, request.query.sessionId),
      ),
  );

  app.put<{
    Params: { chatId: string };
    Querystring: { sessionId?: string; projectPath?: string };
    Body: unknown;
  }>('/api/chat/:chatId/group-settings', (request, reply) => {
    const body = parseBody(chatGroupSettingsSchema, request.body, reply);
    if (!body) return reply;
    const keys = keysOf(request.params.chatId, request.query.sessionId);
    // Настоящий ключ — последний: `sessionId`, когда он уже есть.
    const target = keys.at(-1) ?? request.params.chatId;
    // Неактивную сторону пары закрепить нельзя (F-107). Закреплённую РАНЬШЕ —
    // не трогаем: запись заменяет своё целиком, и отказ на неизменную группу
    // запер бы у такого чата галочку автономии.
    const choice = body.groupChoice;
    const project =
      choice !== undefined && choice !== ctx.store.getChatGroupSettings(target)?.groupChoice
        ? projectOf(keys, request.query.projectPath)
        : undefined;
    const hidden =
      project && choice
        ? inactivePairPin(
            ctx.store.getGroups(),
            project,
            readChoice(ctx.location.paths.appData, project),
            choice,
          )
        : undefined;
    if (hidden) {
      return reply.code(409).send({
        code: 'group_pair_inactive_side',
        message: `Группа «${hidden.name}» — неактивная сторона пары в этом проекте: действует другая. Выберите её или смените сторону пары на странице групп.`,
        messageCode: 'chat-group-pair-inactive-side',
        params: { group: hidden.name },
      });
    }
    ctx.store.setChatGroupSettings(target, {
      ...(body.groupChoice !== undefined
        ? { groupChoice: body.groupChoice as ChatGroupChoice }
        : {}),
      ...(body.autonomous !== undefined ? { autonomous: body.autonomous } : {}),
    });
    return chatGroupSettingsView(storeTreeReader(ctx.store), keys);
  });

  app.get('/api/chat/escalations', (): ChatEscalationsView => ({
    chats: ctx.store.getChatEscalations(),
  }));

  /** Человек открыл главный чат: его заметки прочитаны, точка в списке гаснет. */
  app.post<{ Params: { chatId: string }; Querystring: { sessionId?: string } }>(
    '/api/chat/:chatId/escalations/read',
    (request) => {
      let changed = false;
      for (const key of keysOf(request.params.chatId, request.query.sessionId)) {
        changed = ctx.store.markChatEscalationsRead(key) || changed;
      }
      return { ok: true, changed };
    },
  );
}
