import { describe, it, expect } from 'vitest';
import { defaultOurRules } from '@agentdeck/contracts';
import type { Platform, PlatformAgentAnswer } from '@agentdeck/contracts';
import {
  askBlocker,
  outcomeTone,
  sessionLine,
  showsAgents,
  warnsCut,
  warnsSessionGap,
} from './agentsView';
import { defaultPlatformTransport } from '@agentdeck/contracts';

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [{ id: 'a1', title: 'Аналитик' }],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: {
    platform: {
      platformTools: [],
      toolMode: 'loop' as const,
      generationPreset: '',
      enableThinking: 'default',
    },
    ours: defaultOurRules(),
  },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const answer = (patch: Partial<PlatformAgentAnswer> = {}): PlatformAgentAnswer => ({
  outcome: 'ok',
  detail: 'Агент ответил.',
  text: 'Готово.',
  agentId: 'a1',
  checkedAt: '2026-09-10T10:00:00.000Z',
  ...patch,
});

describe('askBlocker: почему спросить нельзя', () => {
  it('всё на месте — препятствий нет', () => {
    expect(askBlocker(PLATFORM, true, 'a1', 'вопрос')).toBe('');
  });

  it('каждая причина называется своим именем, а не общей серой кнопкой', () => {
    expect(askBlocker({ ...PLATFORM, enabled: false }, true, 'a1', 'вопрос')).toBe('disabled');
    expect(askBlocker(PLATFORM, false, 'a1', 'вопрос')).toBe('no-token');
    expect(askBlocker(PLATFORM, true, '', 'вопрос')).toBe('no-agent');
    expect(askBlocker(PLATFORM, true, 'a1', '   ')).toBe('no-question');
  });
});

describe('outcomeTone', () => {
  it('отсутствующая возможность — предупреждение, а не ошибка', () => {
    // Агентов нет в лицензии компании: чинить в панели нечего, и красный цвет
    // отправил бы человека искать поломку там, где её нет.
    expect(outcomeTone('unavailable')).toBe('warning');
    expect(outcomeTone('agent-error')).toBe('warning');
    expect(outcomeTone('not-ready')).toBe('warning');
  });

  it('отклонённый ключ и запрос — красное: это чинится', () => {
    expect(outcomeTone('unauthorized')).toBe('danger');
    expect(outcomeTone('rejected')).toBe('danger');
    expect(outcomeTone('failed')).toBe('danger');
  });

  it('удача зелёная', () => {
    expect(outcomeTone('ok')).toBe('success');
  });
});

describe('warnsSessionGap', () => {
  it('контур сказал прямо: ответ есть, сессия не пополнилась', () => {
    expect(warnsSessionGap(answer({ sessionRecorded: false }))).toBe(true);
  });

  it('без признака молчим — за чужое хранилище панель не додумывает', () => {
    expect(warnsSessionGap(answer())).toBe(false);
    expect(warnsSessionGap(undefined)).toBe(false);
  });

  it('у неудачного исхода дыры в сессии нет — есть неудача', () => {
    expect(warnsSessionGap(answer({ outcome: 'rejected', sessionRecorded: false }))).toBe(false);
  });
});

describe('warnsCut: агент не договорил', () => {
  it('всё, кроме stop, — это оборванный ответ', () => {
    // Зелёный «Ответил» над текстом, обрывающимся на полуслове, а через
    // переходник такой обрывок уходит локальной модели как законченный.
    expect(warnsCut(answer({ finishReason: 'length' }))).toBe(true);
    expect(warnsCut(answer({ finishReason: 'content_filter' }))).toBe(true);
  });

  it('stop и молчание контура предупреждением не считаются', () => {
    expect(warnsCut(answer({ finishReason: 'stop' }))).toBe(false);
    expect(warnsCut(answer())).toBe(false);
    expect(warnsCut(undefined)).toBe(false);
  });

  it('у неудачного исхода обрыва нет — есть неудача', () => {
    expect(warnsCut(answer({ outcome: 'not-ready', finishReason: 'length' }))).toBe(false);
  });
});

describe('sessionLine: что писать про переписку', () => {
  const session = (patch = {}) => ({
    sessionId: 'ses-1',
    agentIds: ['a1'],
    messages: [],
    total: 0,
    empty: true,
    ...patch,
  });

  it('«контур ничего не помнит» — только после удачного чтения', () => {
    // Это утверждение о ЧУЖОМ хранилище: сказать его, не прочитав, значит
    // выдать своё незнание за факт.
    expect(sessionLine({ isSuccess: false, isError: false })).toBe('unknown');
    expect(sessionLine({ isSuccess: true, isError: false, data: session() })).toBe('empty');
  });

  it('отказ чтения назван отказом, а не пустотой', () => {
    expect(sessionLine({ isSuccess: false, isError: true })).toBe('failed');
  });

  it('непустая сессия — «помнит»', () => {
    expect(
      sessionLine({ isSuccess: true, isError: false, data: session({ total: 3, empty: false }) }),
    ).toBe('kept');
  });
});

describe('showsAgents', () => {
  it('выключенный контур возвращает раздел к прежнему виду', () => {
    expect(showsAgents({ platform: { ...PLATFORM, enabled: false }, agents: true })).toBe(false);
  });

  it('подтверждения пробой не ждём: про агентов она честно молчит', () => {
    expect(showsAgents({ platform: { ...PLATFORM, capabilities: [] }, agents: true })).toBe(true);
  });

  it('тип контура без агентов карточки не получает', () => {
    expect(showsAgents({ platform: PLATFORM, agents: false })).toBe(false);
  });
});
