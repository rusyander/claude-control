import { createHash } from 'node:crypto';
import {
  HUMAN_CHANNEL_HEADER,
  TELEGRAM_CHANNEL,
  TELEGRAM_OWNER_HEADER,
  telegramOwnerInput,
} from '@agentdeck/contracts/core/telegram-channel';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../../lib/listen-identity/listen-identity.ts';
import { createCoreCaller } from '../../core-ask/core-ask.ts';
import { locateCore, verifyCore, type CoreLocation } from '../../core-proxy/core-proxy.ts';
import type {
  TelegramCommandPort,
  TelegramCoreOutcome,
  TelegramOrigin,
} from './command-port.types.ts';

/**
 * Порт команд Telegram к ядру (этап 12, D29, P187, P190). Нажатие кнопки и ответ владельца в боте
 * становятся командой ядра от пира `telegram`: ядро признаёт его только при соединении от звена
 * панели, заголовке канала `telegram` и отпечатке владельца, равном действующему `telegram.owner`.
 *
 * Отправитель СВОЙ, а не `forwardToCore`: прокладка запросов браузера не знает этих заголовков и
 * не должна узнать (P190) — иначе любой запрос к `/api/core/*` мог бы назваться ботом. Отпечаток
 * считается из обновления, которое несёт команда (`apiBase|botId|chatId|fromId`), а не из
 * настройки панели: чужой чат или бот даёт чужой отпечаток, и ядро откажет. Число страницы —
 * то же, что у вопросов панели (`CoreCaller.proof`).
 */

export interface TelegramCommandPortDeps {
  /** Дом ядра (`coreHomeOf`): где `procs.json` и токен. */
  home: () => string;
  identity?: (port: number) => CoreIdentityDeps;
}

/** sha256 входа отпечатка владельца — значение заголовка `x-agentdeck-telegram-owner`. */
export function telegramOwnerFingerprint(origin: TelegramOrigin): string {
  return createHash('sha256').update(telegramOwnerInput(origin)).digest('hex');
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createTelegramCommandPort(deps: TelegramCommandPortDeps): TelegramCommandPort {
  const identity = deps.identity ?? createCoreIdentityDeps();
  const caller = createCoreCaller(deps.home, identity);

  const located = async (): Promise<CoreLocation> => {
    const core = locateCore(deps.home());
    if ('missing' in core) throw new Error(`core is not running: ${core.missing}`);
    const proven = await verifyCore(core, identity(core.entry.port));
    if (!('value' in proven)) {
      throw new Error(
        `core entry not verified: ${'unknown' in proven ? proven.unknown : 'absent'}`,
      );
    }
    return core;
  };

  /** Единственная отправка с заголовками канала: строка ядра сверена, тело — JSON. */
  const send = async (
    origin: TelegramOrigin,
    path: string,
    body: Record<string, unknown>,
  ): Promise<TelegramCoreOutcome> => {
    let res: Response;
    try {
      const core = await located();
      const proof = await caller.proof();
      res = await fetch(`${core.url}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${core.token}`,
          'content-type': 'application/json',
          [HUMAN_CHANNEL_HEADER]: TELEGRAM_CHANNEL,
          [TELEGRAM_OWNER_HEADER]: telegramOwnerFingerprint(origin),
        },
        body: JSON.stringify({ ...body, proof }),
      });
    } catch (error) {
      return { ok: false, status: 0, code: 'core-unreachable', message: reasonOf(error) };
    }
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, status: res.status, body: parsed };
    const problems = Array.isArray(parsed.problems) ? parsed.problems.map(String) : [];
    return {
      ok: false,
      status: res.status,
      code: typeof parsed.code === 'string' ? parsed.code : `http-${res.status}`,
      message: [typeof parsed.error === 'string' ? parsed.error : '', ...problems]
        .filter(Boolean)
        .join(': '),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    };
  };

  return {
    command: (origin, command) =>
      send(origin, '/v1/commands', {
        cmdId: command.cmdId,
        kind: command.kind,
        target: { taskId: command.taskId },
        ...(command.expectSeq !== undefined ? { expectSeq: command.expectSeq } : {}),
        fields: command.fields,
      }),
    inboxCreate: (origin, input) =>
      send(origin, '/v1/inbox', {
        cmdId: input.cmdId,
        create: { source: 'telegram', text: input.text, key: input.key },
      }),
    boardWork: (origin, input) =>
      send(origin, '/v1/board/move', {
        cmdId: input.cmdId,
        to: 'work',
        ...(input.entryId ? { entryId: input.entryId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
      }),
  };
}
