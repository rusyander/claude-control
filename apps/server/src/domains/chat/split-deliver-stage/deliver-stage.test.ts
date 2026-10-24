import { describe, expect, it } from 'vitest';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { stageOf, stagesAhead } from '../ChatCascadeStages/ChatCascadeStages.ts';
import { createDeliverStageSession, deliverStageChoice } from './deliver-stage.ts';

/**
 * Новый разговор доставки по слову конвейера (решение владельца 23.10): живая
 * группа сидела в сессии ревью, где MR не открыть, и напоминания туда были
 * впустую. Здесь — что новая связь получает стадию доставки (её профиль
 * решает `stageOf`/`stagesAhead`: пуш не закрыт, MCP не только на чтение) и
 * какую модель берёт разбор.
 */

const REVIEW_LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '2026-10-23T00:12:34.687Z',
  branch: 'feature/users',
  stage: 'review',
  groupIndex: 0,
  model: 'opus',
  effort: 'high',
  workModel: 'sonnet',
  workEffort: 'medium',
  title: 'Пользователи',
  groupTask: 'списки и сброс пароля',
};

const RECORD = {
  parentChatId: 'родитель',
  proposal: { shared: '', groups: [{ title: 'Пользователи', branch: 'feature/users', tasks: [] }] },
} as unknown as SplitPlanRecord;

const GROUP = {
  index: 0,
  title: 'Пользователи',
  branch: 'feature/users',
  chatId: '670c98f4-review',
  path: 'C:/copies/users',
} as SplitPlanGroupRecord;

function harness(
  options: {
    running?: boolean | ((chatId: string) => boolean);
    started?: boolean;
    busy?: boolean;
    realKey?: string;
    links?: Record<string, ChatLink>;
  } = {},
) {
  const links: Record<string, ChatLink> = options.links ?? { '670c98f4-review': REVIEW_LINK };
  const starts: Parameters<Parameters<typeof createDeliverStageSession>[0]['start']>[0][] = [];
  const removed: string[] = [];
  const resumed: { chatId: string; link: ChatLink }[] = [];
  const running = options.running;
  const session = createDeliverStageSession({
    links: () => links,
    setLink: (chatId, link) => void (links[chatId] = link),
    removeLink: (chatId) => {
      removed.push(chatId);
      delete links[chatId];
    },
    running: (chatId) => (typeof running === 'function' ? running(chatId) : (running ?? false)),
    start: (input) => {
      starts.push(input);
      return {
        started: options.started ?? true,
        ...(options.busy ? { busy: true } : {}),
        ...(options.realKey ? { chatId: options.realKey } : {}),
      };
    },
    resumed: (chatId, link) => void resumed.push({ chatId, link }),
    ceiling: () => ({ model: 'claude-opus-5', effort: 'xhigh' }),
    now: () => 1_792_733_610_958,
    log: () => undefined,
  });
  return { session, links, starts, removed, resumed };
}

describe('новый разговор доставки', () => {
  it('из сессии ревью — связь стадии доставки: пуш не закрыт, MR открыть можно', () => {
    const h = harness();
    expect(h.session(RECORD, GROUP, 'нет MR — откройте', 'deliver')).toBe('sent');

    const key = 'new-1792733610958-deliver0';
    const link = h.links[key];
    expect(link).toMatchObject({
      stage: 'deliver',
      parentChatId: 'родитель',
      branch: 'feature/users',
    });
    expect(stageOf(link as ChatLink)).toBe('deliver');
    // Звена доставки впереди больше нет — пуш и открытие MR этой стадии не закрыты.
    expect(stagesAhead(link as ChatLink, true).deliver).toBe(false);
    // Прежняя связь ревью на месте: её разговор остаётся звеном пути.
    expect(h.links['670c98f4-review']?.stage).toBe('review');

    expect(h.starts).toHaveLength(1);
    const start = h.starts[0];
    expect(start).toMatchObject({
      chatId: key,
      cwd: 'C:/copies/users',
      model: 'sonnet',
      effort: 'medium',
    });
    expect(start?.prompt).toContain('NEW delivery conversation');
    expect(start?.prompt).toContain('нет MR — откройте');
    expect(start?.fromAliases).toContain('670c98f4-review');
  });

  it('разбор — сильнейшая модель группы и потолка, глубина на ступень выше', () => {
    const h = harness();
    expect(h.session(RECORD, GROUP, 'разбор', 'escalate')).toBe('sent');
    expect(h.starts[0]).toMatchObject({ model: 'claude-opus-5', effort: 'xhigh' });
    expect(h.links['new-1792733610958-deliver0']).toMatchObject({
      stage: 'deliver',
      model: 'claude-opus-5',
      effort: 'xhigh',
    });
  });

  it('разговор группы занят — busy, а не refused: старта нет, связь без разговора не висит', () => {
    const busy = harness({ running: true });
    expect(busy.session(RECORD, GROUP, 'x', 'deliver')).toBe('busy');
    expect(busy.starts).toEqual([]);
    expect(Object.keys(busy.links)).toEqual(['670c98f4-review']);

    // Старт сам ответил «занято» (тот же разговор идёт) — тоже busy, связь снята.
    const startBusy = harness({ started: false, busy: true });
    expect(startBusy.session(RECORD, GROUP, 'x', 'deliver')).toBe('busy');
    expect(startBusy.removed).toEqual(['new-1792733610958-deliver0']);

    const refused = harness({ started: false });
    expect(refused.session(RECORD, GROUP, 'x', 'deliver')).toBe('refused');
    expect(refused.removed).toEqual(['new-1792733610958-deliver0']);
    expect(refused.links['new-1792733610958-deliver0']).toBeUndefined();
  });

  it('разговор без настоящей сессии — refused', () => {
    const unborn = harness({ links: { 'new-1': { ...REVIEW_LINK } } });
    expect(unborn.session(RECORD, { ...GROUP, chatId: 'new-1' }, 'x', 'deliver')).toBe('refused');
    expect(unborn.starts).toEqual([]);
  });

  it('чужой CLI — новый разговор его хранилищем: связь на настоящем ключе, слушатель хода позван', () => {
    const foreign = harness({
      links: { 'codex:abc': { ...REVIEW_LINK } },
      realKey: 'codex:fresh-1',
      running: (chatId) => chatId === 'codex:fresh-1',
    });
    expect(foreign.session(RECORD, { ...GROUP, chatId: 'codex:abc' }, 'x', 'deliver')).toBe('sent');
    expect(foreign.starts[0]?.fromAliases).toContain('codex:abc');
    expect(foreign.starts[0]?.stage).toBe('push');
    // Временный ключ не висит строкой хаба без разговора.
    expect(foreign.links['new-1792733610958-deliver0']).toBeUndefined();
    expect(foreign.links['codex:fresh-1']).toMatchObject({
      stage: 'deliver',
      conversation: 'codex:fresh-1',
      groupIndex: 0,
    });
    expect(foreign.resumed).toEqual([
      { chatId: 'codex:fresh-1', link: foreign.links['codex:fresh-1'] },
    ]);
  });

  it('чужой разговор отложен паузой дерева — связь переехала, слушатель не зовётся', () => {
    const paused = harness({
      links: { 'codex:abc': { ...REVIEW_LINK } },
      realKey: 'codex:fresh-1',
      running: () => false,
    });
    expect(paused.session(RECORD, { ...GROUP, chatId: 'codex:abc' }, 'x', 'deliver')).toBe('sent');
    expect(paused.links['codex:fresh-1']?.stage).toBe('deliver');
    expect(paused.resumed).toEqual([]);
  });

  // RC-D-03: потолок панели — модель Claude; чужой CLI с ней не стартует. Разбор
  // у него — настройкой CLI без флагов, вопрос человеку — строкой ответа.
  it('чужой CLI: разбор без модели Claude, задание без инструмента вопросов', () => {
    const foreignLink: ChatLink = {
      ...REVIEW_LINK,
      model: 'gpt-5.3-codex',
      workModel: 'gpt-5.3-codex-spark',
    };
    const foreign = harness({ links: { 'codex:abc': foreignLink }, realKey: 'codex:fresh-1' });
    const group = { ...GROUP, chatId: 'codex:abc' };
    expect(foreign.session(RECORD, group, 'разбор', 'escalate')).toBe('sent');
    expect(foreign.starts[0]?.model).toBeUndefined();
    expect(foreign.starts[0]?.effort).toBeUndefined();
    expect(foreign.starts[0]?.prompt).not.toContain('AskUserQuestion');
    expect(foreign.starts[0]?.prompt).toContain('as the last line of the answer');

    expect(foreign.session(RECORD, group, 'нет MR', 'deliver')).toBe('sent');
    expect(foreign.starts[1]).toMatchObject({ model: 'gpt-5.3-codex-spark', effort: 'medium' });
    expect(foreign.starts[1]?.prompt).not.toContain('AskUserQuestion');

    // Claude — как раньше: потолок панели и инструмент вопросов.
    const own = harness();
    expect(own.session(RECORD, GROUP, 'разбор', 'escalate')).toBe('sent');
    expect(own.starts[0]?.model).toBe('claude-opus-5');
    expect(own.starts[0]?.prompt).toContain('AskUserQuestion');
  });

  it('новое звено не наследует окно и отметки прошлого (F-110)', () => {
    const h = harness({
      links: {
        '670c98f4-review': {
          ...REVIEW_LINK,
          stageSince: '2026-10-23T00:00:00.000Z',
          reviewVerdict: ['src/a.ts:1 — забыт await'],
          reviewedAt: '2026-10-23T00:10:00.000Z',
          plannedAt: '2026-10-23T00:11:00.000Z',
          deliveredAt: '2026-10-23T00:12:00.000Z',
        },
      },
    });
    expect(h.session(RECORD, GROUP, 'x', 'deliver')).toBe('sent');
    const link = h.links['new-1792733610958-deliver0'];
    expect(link?.stage).toBe('deliver');
    for (const field of [
      'stageSince',
      'reviewVerdict',
      'reviewedAt',
      'plannedAt',
      'deliveredAt',
    ] as const) {
      expect(link?.[field], field).toBeUndefined();
    }
    // Родитель, ветка и задание группы переезжают.
    expect(link).toMatchObject({ parentChatId: 'родитель', branch: 'feature/users' });
    expect(link?.groupTask).toBe('списки и сброс пароля');
  });
});

describe('модель разбора', () => {
  it('глубина не выше потолка и никогда не max', () => {
    expect(deliverStageChoice({ effort: 'xhigh' }, 'escalate', { effort: 'max' }).effort).toBe(
      'xhigh',
    );
    expect(deliverStageChoice({ effort: 'high' }, 'escalate', { effort: 'high' }).effort).toBe(
      'high',
    );
    expect(deliverStageChoice({ effort: 'low' }, 'escalate', {}).effort).toBe('high');
  });

  it('доставка — модель работы; разбор не опускается ниже модели группы', () => {
    expect(deliverStageChoice(REVIEW_LINK, 'deliver', {})).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
    expect(deliverStageChoice(REVIEW_LINK, 'escalate', { model: 'sonnet' }).model).toBe('opus');
  });
});

// F-42: потолок разбора брался из настроек чата панели (sonnet/medium по
// умолчанию) — «разбор на усиленной модели» опускал группу, шедшую на opus/xhigh.
describe('модель разбора: потолок звена и не ниже своей', () => {
  it('группа шла на opus/xhigh, у панели sonnet/medium — разбор не ниже opus/xhigh', () => {
    expect(
      deliverStageChoice(
        { model: 'opus', effort: 'xhigh', workModel: 'opus', workEffort: 'xhigh' },
        'escalate',
        { model: 'sonnet', effort: 'medium' },
      ),
    ).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it('потолок звена задан — он верх, а не потолок панели', () => {
    expect(
      deliverStageChoice(
        { model: 'sonnet', effort: 'medium', ceilingModel: 'opus', ceilingEffort: 'xhigh' },
        'escalate',
        { model: 'sonnet', effort: 'medium' },
      ),
    ).toEqual({ model: 'opus', effort: 'high' });
    expect(
      deliverStageChoice(
        { model: 'sonnet', effort: 'medium', ceilingModel: 'sonnet', ceilingEffort: 'medium' },
        'escalate',
        { model: 'opus', effort: 'xhigh' },
      ),
    ).toEqual({ model: 'sonnet', effort: 'medium' });
  });
});
