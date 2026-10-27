import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ChatWatchSignalsResponse, GroupSignal } from '@agentdeck/contracts/group-watch';
import type { ServerContext } from '../../context.ts';
import {
  registerChatWatchSignalsRoutes,
  registerGroupWatchCoverageRoutes,
} from './watch-signals-routes.ts';

/**
 * Маршруты сторожа для строк списка и настроек: сигналы одиночных чатов и групп
 * разделения по ключу строки (F7, телефон) и охват сторожа. Хранилище — подмена с
 * тем же видом блоков, что пишет сторож; разбор ответа — настоящий.
 */

const signal = (over: Partial<GroupSignal>): GroupSignal => ({
  id: 's',
  rule: 'R4',
  severity: 'warn',
  groupIndex: 0,
  chatId: 'new-123',
  at: '2026-10-27T10:00:00.000Z',
  numbers: { runs: 3 },
  textKey: 'groupWatch.rule.R4',
  ...over,
});

function app(store: Record<string, unknown>) {
  const instance = Fastify();
  registerChatWatchSignalsRoutes(instance, { store } as unknown as ServerContext);
  return instance;
}

describe('GET /api/chat/watch-signals', () => {
  it('сигналы группы — под настоящим ключом её чата и под родителем; закрытые не идут', async () => {
    const live = signal({ id: 'a', rule: 'R1', severity: 'alert', groupIndex: 1 });
    const cleared = signal({ id: 'b', clearedAt: '2026-10-27T10:05:00.000Z', groupIndex: 1 });
    const canon: Record<string, string> = { 'new-123': 'sess-1', parent: 'parent-sess' };
    const server = app({
      getAllChatWatchSignals: () => ({ solo: { signals: [signal({ id: 'c' })] } }),
      getAllGroupWatchSignals: () => ({ parent: { '1': { signals: [live, cleared] }, '2': {} } }),
      getSplitPlan: () => ({ groups: [{ index: 1, chatId: 'new-123' }] }),
      canonicalChatKey: (key: string) => canon[key] ?? key,
    });
    const response = await server.inject({ method: 'GET', url: '/api/chat/watch-signals' });
    expect(response.statusCode).toBe(200);
    const body = response.json<ChatWatchSignalsResponse>();
    expect(Object.keys(body.signals)).toEqual(['solo']);
    expect(body.groups).toEqual({ 'sess-1': [live], 'parent-sess': [live] });
  });

  it('групп без сигналов нет — поля groups нет; группа без чата — только под родителем', async () => {
    const empty = app({
      getAllChatWatchSignals: () => ({}),
      getAllGroupWatchSignals: () => ({}),
      getSplitPlan: () => undefined,
      canonicalChatKey: (key: string) => key,
    });
    const none = await empty.inject({ method: 'GET', url: '/api/chat/watch-signals' });
    expect(none.json()).toEqual({ signals: {} });
    const orphan = app({
      getAllChatWatchSignals: () => ({}),
      getAllGroupWatchSignals: () => ({ parent: { '0': { signals: [signal({})] } } }),
      getSplitPlan: () => ({ groups: [{ index: 0 }] }),
      canonicalChatKey: (key: string) => key,
    });
    const body = (
      await orphan.inject({ method: 'GET', url: '/api/chat/watch-signals' })
    ).json<ChatWatchSignalsResponse>();
    expect(Object.keys(body.groups ?? {})).toEqual(['parent']);
  });
});

describe('GET /api/group-watch/coverage', () => {
  it('отдаёт сводку сторожа как есть', async () => {
    const instance = Fastify();
    const summary = {
      groups: { stream: 1, transcript: 0, 'text-only': 0, blind: 0 },
      gaps: ['devWatch' as const],
    };
    registerGroupWatchCoverageRoutes(instance, () => summary);
    const response = await instance.inject({ method: 'GET', url: '/api/group-watch/coverage' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(summary);
  });
});
