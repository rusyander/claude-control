import { routesSectionSchema, userRouteSchema } from '@agentdeck/contracts/core/config';
import { placementSchema } from '@agentdeck/contracts/core/estimate';
import { HOP_TRANSLATIONS, HOP_USER_GATEWAY_PORT } from '@agentdeck/contracts/core/hops';
import { relayNoticeSchema } from '@agentdeck/contracts/core/relay';
import { coreSupervisorStateSchema } from '@agentdeck/contracts/core/supervisor';
import { describe, expect, it } from 'vitest';

/**
 * Контракты этапа 10 (волна 0) без потребителя в этой волне: место работы, сервер моделей
 * человека, надзор ядра, пересылка вопросов, порт шлюза. Строгость и границы проверяются здесь,
 * чтобы зоны, которые их подключат, получили схему, уже умеющую отказать.
 */

const ID = '01920000-0000-7000-8000-00000000a010';

describe('stage-10 contracts', () => {
  it('placement: copy is bare; in-place needs a grant with a project and at least one op', () => {
    expect(placementSchema.safeParse({ kind: 'copy' }).success).toBe(true);
    const inPlace = { kind: 'in-place', grant: { project: 'C:/work/p', ops: ['edit'] } };
    expect(placementSchema.safeParse(inPlace).success).toBe(true);
    expect(placementSchema.safeParse({ kind: 'in-place' }).success).toBe(false);
    expect(
      placementSchema.safeParse({ ...inPlace, grant: { ...inPlace.grant, ops: [] } }).success,
    ).toBe(false);
    expect(
      placementSchema.safeParse({ ...inPlace, grant: { ...inPlace.grant, ops: ['push'] } }).success,
    ).toBe(false);
    // Копия без лишних полей: грант при копии — ошибка вызывающего, а не тихо отброшенное поле.
    expect(placementSchema.safeParse({ kind: 'copy', grant: inPlace.grant }).success).toBe(false);
  });

  it('a user model server is an http address with a key NAME, never a key value', () => {
    const route = { id: 'llama', baseUrl: 'http://127.0.0.1:8080', dialect: 'openai-chat' };
    expect(userRouteSchema.safeParse(route).success).toBe(true);
    expect(userRouteSchema.safeParse({ ...route, keyVar: 'LLAMA_KEY' }).success).toBe(true);
    expect(userRouteSchema.safeParse({ ...route, baseUrl: 'llama-server' }).success).toBe(false);
    expect(userRouteSchema.safeParse({ ...route, dialect: 'google-genai' }).success).toBe(false);
    expect(userRouteSchema.safeParse({ ...route, key: 'sk-1' }).success).toBe(false);
    expect(routesSectionSchema.safeParse({ localUser: [route] }).success).toBe(true);
    expect(routesSectionSchema.safeParse({ localUser: [{ ...route, key: 'sk' }] }).success).toBe(
      false,
    );
  });

  it('supervisor state: four states, a bounded log tail, strict', () => {
    const up = {
      state: 'up',
      pid: 42,
      restarts: 0,
      lastExit: null,
      nextRetryAt: null,
      logTail: [],
      autostart: 'off',
    };
    expect(coreSupervisorStateSchema.safeParse(up).success).toBe(true);
    expect(coreSupervisorStateSchema.safeParse({ ...up, state: 'down' }).success).toBe(false);
    expect(
      coreSupervisorStateSchema.safeParse({ ...up, logTail: Array(41).fill('x') }).success,
    ).toBe(false);
    expect(
      coreSupervisorStateSchema.safeParse({ ...up, logTail: Array(40).fill('x') }).success,
    ).toBe(true);
    expect(coreSupervisorStateSchema.safeParse({ ...up, restarts: -1 }).success).toBe(false);
    expect(coreSupervisorStateSchema.safeParse({ ...up, extra: 1 }).success).toBe(false);
  });

  it('relay notice: a question only (report-final removed, s12 m3), with a panel link; no answer field', () => {
    const ask = { taskId: ID, askId: ID, kind: 'ask', title: 'дальше?', deepLink: '/core/tasks/x' };
    expect(relayNoticeSchema.safeParse(ask).success).toBe(true);
    // Итог задачи телефону не сообщается: пуш — только о том, что ждёт человека.
    expect(relayNoticeSchema.safeParse({ ...ask, askId: null, kind: 'report-final' }).success).toBe(
      false,
    );
    expect(relayNoticeSchema.safeParse({ ...ask, kind: 'report-final' }).success).toBe(false);
    expect(relayNoticeSchema.safeParse({ ...ask, askId: null }).success).toBe(false);
    expect(relayNoticeSchema.safeParse({ ...ask, answer: 'да' }).success).toBe(false);
    expect(relayNoticeSchema.safeParse({ ...ask, taskId: 'task-1' }).success).toBe(false);
  });

  it('the bridged pairs (Responses, Gemini → OpenAI chat) are in the live list beside Anthropic; the user gateway port is the one 5170–5180 exception', () => {
    expect(HOP_TRANSLATIONS.map((p) => `${p.from}->${p.to}`)).toEqual([
      'anthropic-messages->openai-chat',
      'openai-responses->openai-chat',
      'google-genai->openai-chat',
    ]);
    expect(HOP_USER_GATEWAY_PORT).toBe(5179);
  });
});
