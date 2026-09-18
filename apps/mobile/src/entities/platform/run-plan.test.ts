import { describe, expect, it } from 'vitest';
import type { PlatformRunPlan } from '@agentdeck/contracts';
import { ru } from '../../shared/config/i18n/ru';
import { runPlanConsumer, runPlanView } from './run-plan';

/**
 * Подписи контура под полем ввода телефона (Т8 MINOR-5). Модель считает
 * НАСТОЯЩИЙ `chooseRunModel` из контрактов — тот же модуль, что у сервера и
 * шапки панели, без подмены: вопрос здесь ровно в том, совпадёт ли имя.
 */
const words = ru.composer;

function plan(overrides: Partial<PlatformRunPlan> = {}): PlatformRunPlan {
  return {
    routed: true,
    title: 'Company',
    rules: {
      model: 'qwen3-32b',
      source: 'default',
      map: { sonnet: 'qwen3-coder' },
      catalog: ['qwen3-32b', 'qwen3-coder', 'Llama-3'],
    },
    effort: true,
    ...overrides,
  };
}

const texts = (view: ReturnType<typeof runPlanView>): string[] =>
  view.lines.map((line) => line.text);

describe('runPlanView', () => {
  it('молчит и не запирает выбор, когда контур прогон не ведёт', () => {
    const view = runPlanView(
      plan({ routed: false, title: '' }),
      { model: 'opus', effort: 'high' },
      words,
    );
    expect(view).toEqual({ lines: [] });
    expect(runPlanView(undefined, { model: '', effort: '' }, words)).toEqual({ lines: [] });
  });

  it('называет подмену незнакомого имени моделью контура', () => {
    const view = runPlanView(plan(), { model: 'opus', effort: '' }, words);
    expect(view.lines[0]).toEqual({
      text: 'Через контур «Company»: имени «opus» там нет, запрос уйдёт с qwen3-32b.',
      warn: true,
    });
    expect(view.locked?.model).toBe('qwen3-32b');
    expect(view.locked?.hint).toContain('«Company»');
  });

  it('переводит имя картой и отдаёт идентификатор каталога в его регистре', () => {
    expect(runPlanView(plan(), { model: 'Sonnet', effort: '' }, words).lines[0]?.text).toBe(
      'Через контур «Company»: имени «Sonnet» там нет, запрос уйдёт с qwen3-coder.',
    );
    const known = runPlanView(plan(), { model: 'llama-3', effort: '' }, words);
    expect(known.lines[0]).toEqual({ text: 'Через контур «Company»: Llama-3.', warn: false });
  });

  it('не объявляет подмену, когда у контура нет модели вовсе', () => {
    const view = runPlanView(
      plan({ rules: { model: '', source: 'none', map: {}, catalog: [] } }),
      { model: 'opus', effort: '' },
      words,
    );
    expect(view.lines[0]?.text).toContain('модель не назначил');
    expect(view.locked?.model).toBe('opus');
    const empty = runPlanView(
      plan({ rules: { model: '', source: 'none', map: {}, catalog: [] } }),
      { model: '', effort: '' },
      words,
    );
    expect(empty.locked?.model).toBe(words.platformModelNone);
  });

  it('говорит, что усилие не отправляется, и запирает глубину этой подписью', () => {
    const view = runPlanView(plan({ effort: false }), { model: '', effort: 'max' }, words);
    expect(texts(view)).toContain(
      'Контур «Company» не принимает глубину продумывания — она не отправляется.',
    );
    expect(view.locked?.effort).toBe('не отправляется');
    expect(runPlanView(plan(), { model: '', effort: 'max' }, words).locked?.effort).toBe('max');
  });

  it('перечисляет снятые слои через точку, полный набор — одной фразой', () => {
    const some = runPlanView(
      plan({ layers: { args: [], systemPrompt: true, dropped: ['settings', 'mcp'] } }),
      { model: '', effort: '' },
      words,
    );
    expect(texts(some)).toContain(
      'Через контур «Company» прогон пойдёт без нашего: Личные правила, хуки и права · MCP-серверы.',
    );
    const all = runPlanView(
      plan({
        layers: {
          args: [],
          systemPrompt: false,
          dropped: ['settings', 'skills', 'mcp', 'systemPrompt'],
        },
      }),
      { model: '', effort: '' },
      words,
    );
    expect(texts(all).some((text) => text.includes('без единого нашего слоя'))).toBe(true);
    const none = runPlanView(
      plan({ layers: { args: [], systemPrompt: true, dropped: [] } }),
      { model: '', effort: '' },
      words,
    );
    expect(texts(none)).toHaveLength(1);
  });

  it('называет уход мимо контура «по возможности» — тем же, что шапка панели', () => {
    const view = runPlanView(
      plan({ routed: false, bypassed: true, reason: 'gateway_down' }),
      { model: '', effort: '' },
      words,
    );
    expect(view.locked).toBeUndefined();
    expect(view.lines).toEqual([
      {
        text:
          'Мимо контура: «Company» включён «по возможности», а шлюз панели не поднят — сообщение ' +
          'уйдёт напрямую в облако вендора, без защиты контура. Нажмите «Поднять шлюз» на ' +
          'карточке контура в панели (раздел «Контур»).',
        warn: true,
      },
    ]);
  });

  it('предупреждает об отказе обязательного контура с причиной и тем, где чинить', () => {
    const view = runPlanView(
      plan({ routed: false, refused: true, reason: 'no_token' }),
      { model: '', effort: '' },
      words,
    );
    expect(view.locked).toBeUndefined();
    expect(view.lines).toEqual([
      {
        text:
          'Контур «Company» обязателен, а ключ контура не сохранён: сообщение будет отклонено — ' +
          'ни в контур, ни в облако вендора оно не уйдёт. Сохраните ключ в панели: «Настроить» ' +
          'на карточке контура → шаг «Ключ».',
        warn: true,
      },
    ]);
  });
});

/**
 * Ревью Т13: потребитель был жёстко `'chat'`, а сервер маршрутизирует ребёнка
 * разделения как «Группы». У контура, включённого только для «Чата», открытый
 * на телефоне ребёнок запирал модель и писал «через контур …» про прогон,
 * уходивший в облако вендора.
 */
describe('потребитель маршрута для этого разговора', () => {
  const chats = [{ id: 'own' }, { id: 'child', parentId: 'own' }];

  it('ребёнок разделения идёт «Группами»', () => {
    expect(runPlanConsumer(chats, 'child')).toBe('groups');
  });

  it('обычный разговор идёт «Чатом»', () => {
    expect(runPlanConsumer(chats, 'own')).toBe('chat');
  });

  it('список ещё не приехал — тот же ответ, что у разговора без связи', () => {
    expect(runPlanConsumer(undefined, 'child')).toBe('chat');
    expect(runPlanConsumer(chats, 'unknown')).toBe('chat');
  });
});
