import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_START_CARRY_REFUSED,
  CHAT_START_ROUTE,
  chatStartBodySchema,
} from '@agentdeck/contracts/core/estimate';
import type { CommandDraft } from '@entities/CoreTask';

/**
 * Старт чата ядра (этап 10, G13): оценка идёт ручкой панели, которая дописывает слой (строку о
 * тестах, набор, флаги наших слоёв), а не ядру напрямую — прежде новый разговор шёл без слоя.
 * Граница сети подменена: клиент API панели и команды ядра записываются.
 */

const posted: Array<{ url: string; body: unknown }> = [];
const sent: CommandDraft[] = [];
let refuse: unknown;
let routes: unknown[] | undefined;

vi.mock('@shared/api/client', () => ({
  apiClient: {
    post: async (url: string, body: unknown) => {
      posted.push({ url, body });
      if (refuse) throw refuse;
      return {
        data: {
          state: 'ready',
          taskId: 'task-1',
          preflight: [],
          ...(routes ? { allowedRoutes: routes } : {}),
        },
      };
    },
  },
}));
vi.mock('@entities/CoreTask', async (importOriginal) => {
  const real = await importOriginal<typeof import('@entities/CoreTask')>();
  return {
    ...real,
    fetchNonce: async () => 'nonce-1',
    sendCoreCommand: async (draft: CommandDraft) => {
      sent.push(draft);
      return { cmdId: 'c', status: 'applied', seq: sent.length };
    },
  };
});

const { ChatStartError, startCoreChat } = await import('./chatApi');

const DRAFT = { project: 'C:/work/p', text: 'скажи ок', cli: 'qwen' };

beforeEach(() => {
  posted.length = 0;
  sent.length = 0;
  refuse = undefined;
  routes = undefined;
});

describe('startCoreChat — оценка ручкой панели, слой собирает сервер', () => {
  it('тело уходит на /api/chat/core-start с CLI и без полей сеанса; затем set-cli и launch', async () => {
    expect(await startCoreChat(DRAFT)).toBe('task-1');
    expect(posted).toHaveLength(1);
    expect(`/api${posted[0]!.url}`).toBe(CHAT_START_ROUTE);
    const body = chatStartBodySchema.parse(posted[0]!.body);
    expect(body.cli).toBe('qwen');
    expect(body.fields.session).toBeUndefined();
    expect(body.proof).toMatchObject({ nonce: 'nonce-1' });
    expect(sent.map((c) => c.kind)).toEqual(['set-cli', 'launch']);
  });

  it('маршрут контура в ответе панели — set-route с ним ДО set-cli, затем launch', async () => {
    const route = {
      adapter: 'qwen',
      route: { kind: 'gateway', id: 'gateway:company-dev' },
      modelPattern: 'corp-large',
    };
    routes = [route];
    expect(await startCoreChat(DRAFT)).toBe('task-1');
    expect(sent.map((c) => c.kind)).toEqual(['set-route', 'set-cli', 'launch']);
    expect(sent[0]!.fields).toEqual({ scope: 'task', scopeId: 'task-1', allowedRoutes: [route] });
  });

  it('отказ переноса слоя — ChatStartError вида carry с причиной панели, ядру команд нет', async () => {
    refuse = new AxiosError('422', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 422,
      statusText: 'Unprocessable',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { code: CHAT_START_CARRY_REFUSED, detail: 'panel flag --mcp-config refused' },
    });
    const error = await startCoreChat(DRAFT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatStartError);
    expect(error).toMatchObject({ kind: 'carry', message: 'panel flag --mcp-config refused' });
    expect(sent).toEqual([]);
  });

  it('отказ оценки ядра (422 estimate-refused) — ChatStartError с причиной и проблемами, а не голым кодом', async () => {
    refuse = new AxiosError(
      'Request failed with status code 422',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 422,
        statusText: 'Unprocessable',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: {
          error: 'Задача не создана',
          code: 'estimate-refused',
          problems: ['C:\\shots\\shim: not a git repository'],
        },
      },
    );
    const error = await startCoreChat(DRAFT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatStartError);
    expect(error).toMatchObject({
      kind: 'core',
      message: 'Задача не создана: C:\\shots\\shim: not a git repository',
    });
    expect(sent).toEqual([]);
  });

  it('ответ без причины — исходная ошибка сети как была', async () => {
    refuse = new AxiosError('Network Error', 'ERR_NETWORK');
    const error = await startCoreChat(DRAFT).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ChatStartError);
    expect(error).toMatchObject({ message: 'Network Error' });
  });
});
