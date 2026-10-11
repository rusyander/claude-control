import { describe, it, expect } from 'vitest';
import { DELIVERED_KEEP_MS, HOOK_SILENT_MS, OutsideRelay, RELAY_MAX_MS } from './outside-relay.ts';

/**
 * Запрос сессии вне панели живёт между хуком (ждёт) и телефоном (решает), а
 * сообщение — между телефоном и хуком следующего шага. Ошибка здесь — либо
 * запрос, навсегда застрявший на телефоне, либо решение, ушедшее не тому
 * вызову, либо сообщение, отданное агенту дважды.
 */

const relay = (over: { enabled?: boolean; own?: string[]; now?: () => number } = {}) =>
  new OutsideRelay({
    enabled: () => over.enabled ?? true,
    ownSession: (id) => (over.own ?? []).includes(id),
    ...(over.now ? { now: over.now } : {}),
  });

const ask = { toolUseId: 't1', sessionId: 's1', cwd: 'C:/work/shop', toolName: 'AskUserQuestion' };
const bash = { toolUseId: 'b1', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' } };
const answered = (answers: { [question: string]: string }) =>
  ({ state: 'answered', answers }) as const;

describe('OutsideRelay: вопросы и права', () => {
  it('выключенная пересылка и свой прогон панели запрос не берут', () => {
    expect(relay({ enabled: false }).register(ask)).toBe(false);
    expect(relay({ own: ['s1'] }).register(ask)).toBe(false);
  });

  it('ответ с телефона приходит ждущему хуку и отдаётся один раз', async () => {
    const r = relay();
    expect(r.register(ask)).toBe(true);
    expect(r.isPending('t1')).toBe(true);
    const waiting = r.wait('t1', 5_000);
    expect(r.decide('t1', answered({ 'Какой?': 'Синий' }))).toBe(true);
    await expect(waiting).resolves.toEqual(answered({ 'Какой?': 'Синий' }));
    expect(r.isPending('t1')).toBe(false);
    await expect(r.wait('t1')).resolves.toEqual({ state: 'unknown' });
  });

  it('права решаются «разрешить / запретить», вопрос — только вариантами', async () => {
    const r = relay();
    r.register(bash);
    r.register(ask);
    // Решение не того рода — отказ: хук прав не умеет отдать варианты ответа.
    expect(r.decide('b1', answered({ q: 'a' }))).toBe(false);
    expect(r.decide('t1', { state: 'decided', behavior: 'allow' })).toBe(false);
    expect(r.decide('b1', { state: 'decided', behavior: 'deny' })).toBe(true);
    await expect(r.wait('b1')).resolves.toEqual({ state: 'decided', behavior: 'deny' });
  });

  it('ждущие запросы видны сводке со своим инструментом и вводом', () => {
    let now = 5_000;
    const r = relay({ now: () => now });
    r.register(bash);
    now += 10;
    r.register(ask);
    expect(r.pending()).toEqual([
      { ...bash, askedAt: 5_000 },
      { ...ask, askedAt: 5_010 },
    ]);
    r.release('b1');
    expect(r.pending().map((item) => item.toolUseId)).toEqual(['t1']);
  });

  it('решение, данное между запросами ожидания, не теряется', async () => {
    const r = relay();
    r.register(ask);
    r.decide('t1', answered({ q: 'a' }));
    await expect(r.wait('t1')).resolves.toMatchObject({ state: 'answered' });
  });

  it('ожидание без решения кончается «pending», запрос остаётся', async () => {
    const r = relay();
    r.register(ask);
    await expect(r.wait('t1', 10)).resolves.toEqual({ state: 'pending' });
    expect(r.isPending('t1')).toBe(true);
  });

  it('отпущенный запрос (ответили в окне) телефону больше не отвечается', async () => {
    const r = relay();
    r.register(ask);
    expect(r.release('t1')).toBe(true);
    expect(r.decide('t1', answered({ q: 'a' }))).toBe(false);
    await expect(r.wait('t1')).resolves.toEqual({ state: 'released' });
  });

  it('решение для неизвестного вызова — отказ, чужой запрос не задет', () => {
    const r = relay();
    r.register(ask);
    expect(r.decide('t2', answered({ q: 'a' }))).toBe(false);
    expect(r.isPending('t1')).toBe(true);
  });

  it('хук замолчал (CLI вышел и убил его) — запрос уходит с телефона', async () => {
    let now = 1_000_000;
    const r = relay({ now: () => now });
    r.register(ask);
    await r.wait('t1', 5);
    now += HOOK_SILENT_MS - 1;
    expect(r.isPending('t1')).toBe(true);
    now += 2;
    expect(r.isPending('t1')).toBe(false);
    expect(r.decide('t1', answered({ q: 'a' }))).toBe(false);
  });

  it('пока хук ждёт ответа, молчанием это не считается', () => {
    let now = 1_000_000;
    const r = relay({ now: () => now });
    r.register(ask);
    void r.wait('t1', 60_000);
    now += HOOK_SILENT_MS * 3;
    expect(r.isPending('t1')).toBe(true);
    r.release('t1');
  });

  it('запрос старше предела забывается', () => {
    let now = 1_000_000;
    const r = relay({ now: () => now });
    r.register(ask);
    now += RELAY_MAX_MS + 1;
    expect(r.isPending('t1')).toBe(false);
    expect(r.decide('t1', answered({ q: 'a' }))).toBe(false);
  });
});

describe('OutsideRelay: сообщения посреди хода', () => {
  it('хук шага забирает сообщение один раз, телефон видит «доставлено»', () => {
    let now = 1_000;
    const r = relay({ now: () => now });
    r.queue('s1', 'проверь ещё мобильную вёрстку');
    expect(r.listMessages('s1')).toMatchObject({
      hooked: false,
      messages: [{ text: 'проверь ещё мобильную вёрстку', queuedAt: 1_000 }],
    });
    now = 2_000;
    expect(r.takeMessages('s1')).toEqual(['проверь ещё мобильную вёрстку']);
    // Второй шаг того же хода — уже нечего отдавать: агент не прочтёт его дважды.
    expect(r.takeMessages('s1')).toEqual([]);
    expect(r.listMessages('s1')).toMatchObject({
      hooked: true,
      messages: [{ deliveredAt: 2_000 }],
    });
  });

  it('сообщения разных сессий не смешиваются', () => {
    const r = relay();
    r.queue('s1', 'первой');
    r.queue('s2', 'второй');
    expect(r.takeMessages('s2')).toEqual(['второй']);
    expect(r.takeMessages('s1')).toEqual(['первой']);
  });

  it('хук отозвался — сессия помечена, даже если сообщений не было', () => {
    const r = relay();
    expect(r.listMessages('s9').hooked).toBe(false);
    r.takeMessages('s9');
    expect(r.listMessages('s9').hooked).toBe(true);
  });

  it('доставленное держится полчаса и уходит из ленты', () => {
    let now = 0;
    const r = relay({ now: () => now });
    r.queue('s1', 'текст');
    r.takeMessages('s1');
    now += DELIVERED_KEEP_MS + 1;
    expect(r.listMessages('s1').messages).toEqual([]);
  });
});
