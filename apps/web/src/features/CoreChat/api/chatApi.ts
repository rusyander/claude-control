import axios from 'axios';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import {
  CHAT_START_CARRY_REFUSED,
  CHAT_START_ROUTE,
  type ChatStartBody,
  type ChatStartReply,
} from '@agentdeck/contracts/core/estimate';
import { fetchNonce, newUuidv7, pageLoadId, sendCoreCommand } from '@entities/CoreTask';
import { apiClient } from '@shared/api/client';
import { chatFields, chatLaunchCommands } from '../model/chatStart';
import type { ChatStartDraft } from '../model/coreChat.types';

/**
 * Начало чата ядра: оценка (задача `chat@1` на месте, грант на корень), выбранный CLI, запуск.
 * Отказ любого звена — исключение с причиной ядра дословно: чат без CLI или без запуска хуже
 * честной ошибки на экране.
 */

export class ChatStartError extends Error {
  constructor(
    message: string,
    readonly taskId: string | null,
    /** `carry` — панель не перенесла свой слой в сеанс ядра (причина — в `message`). */
    readonly kind: 'core' | 'carry' = 'core',
  ) {
    super(message);
    this.name = 'ChatStartError';
  }
}

/**
 * Оценка чата идёт ручкой панели, а не ядру напрямую (этап 10, G13): панель дописывает к ней свой
 * слой — строку о тестах, набор, флаги наших слоёв — и пересылает ядру с этим же доказательством
 * страницы. Сам веб слоя не собирает.
 */
async function estimateChat(body: ChatStartBody): Promise<ChatStartReply> {
  try {
    const { data } = await apiClient.post<ChatStartReply>(
      CHAT_START_ROUTE.replace(/^\/api/, ''),
      body,
    );
    return data;
  } catch (error) {
    const data: unknown = axios.isAxiosError(error) ? error.response?.data : undefined;
    const refusal = data as
      { code?: unknown; detail?: unknown; error?: unknown; problems?: unknown } | undefined;
    if (refusal?.code === CHAT_START_CARRY_REFUSED && typeof refusal.detail === 'string') {
      throw new ChatStartError(refusal.detail, null, 'carry');
    }
    // Отказ оценки ядра несёт причину словами (`error` + `problems`): без неё экран писал голое
    // «Request failed with status code 422», и папка не под git оставалась загадкой.
    if (typeof refusal?.error === 'string') {
      const problems = Array.isArray(refusal.problems)
        ? refusal.problems.filter((item): item is string => typeof item === 'string')
        : [];
      throw new ChatStartError(
        problems.length ? `${refusal.error}: ${problems.join('; ')}` : refusal.error,
        null,
      );
    }
    throw error;
  }
}

export async function startCoreChat(draft: ChatStartDraft): Promise<string> {
  const got = chatFields(draft);
  if (!got.ok) throw new ChatStartError(got.problem, null);
  const page = pageLoadId();
  const nonce = await fetchNonce(page);
  const reply = await estimateChat({
    cmdId: newUuidv7(),
    cli: draft.cli,
    fields: got.fields,
    proof: { nonce, page },
  });
  if (reply.state === 'refused') {
    const why = reply.preflight
      .filter((p) => p.status === 'failed')
      .map((p) => `${p.road}: ${p.detail}`);
    throw new ChatStartError(why.join('; ') || 'refused', reply.taskId);
  }
  // Маршрут контура решает панель (`allowedRoutes` ответа старта) — веб только шлёт его `set-route`.
  for (const command of chatLaunchCommands(reply.taskId, draft.cli, reply.allowedRoutes)) {
    const outcome = await sendCoreCommand(command);
    if (outcome.status !== 'applied') {
      throw new ChatStartError(
        `${command.kind}: ${outcome.code ?? ''} ${outcome.reason ?? ''}`.trim(),
        reply.taskId,
      );
    }
  }
  return reply.taskId;
}

/** Ход человека — сообщение шагу чата; ядро доставит его на границе хода. */
export function sendChatTurn(
  taskId: string,
  stepId: string,
  text: string,
): Promise<CommandOutcome> {
  return sendCoreCommand({ kind: 'message-to-step', taskId, fields: { stepId, text } });
}

/** Закрыть чат: шаг сдан человеком, задача кончается. */
export function endCoreChat(taskId: string, stepId: string): Promise<CommandOutcome> {
  return sendCoreCommand({ kind: 'end-chat', taskId, fields: { stepId } });
}
