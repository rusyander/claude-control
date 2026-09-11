import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { CompromiseId, CompromisesResponse } from '@agentdeck/contracts';
import { COMPROMISES, COMPROMISE_IDS } from '@agentdeck/contracts/compromises';
import type { ServerContext } from '../../context.ts';
import { registerCompromiseRoutes } from '../../routes/compromise-routes.ts';
import { compromiseViews, compromisesOf } from './compromises.ts';

describe('реестр подписанных компромиссов', () => {
  it('отдаёт все заведённые подписи в порядке реестра', () => {
    expect(compromiseViews().map((view) => view.id)).toEqual([...COMPROMISE_IDS]);
  });

  it('без якорей в коде подпись помечена как заведённая заранее', () => {
    const planned = compromiseViews().filter((view) => view.planned);
    const withoutAnchors = COMPROMISES.filter((entry) => entry.codeAnchors.length === 0);
    expect(planned.map((view) => view.id)).toEqual(withoutAnchors.map((entry) => entry.id));
  });

  it('обходы без своего места на экране названы явно', () => {
    const hidden = compromiseViews()
      .filter((view) => view.uiHidden)
      .map((view) => view.id);
    expect(hidden).toEqual(COMPROMISES.filter((entry) => entry.uiHidden).map((entry) => entry.id));
  });

  /**
   * Тексты живут в словаре и типизированы `en.ts` против `ru.ts`. Утечь сюда
   * они могут только вместе с потерей этой гарантии, поэтому набор полей
   * зафиксирован тестом, а не соглашением.
   */
  it('в ответе нет ни одного человеческого текста', () => {
    for (const view of compromiseViews()) {
      expect(Object.keys(view).sort()).toEqual(['id', 'planned', 'severity', 'since', 'uiHidden']);
    }
  });

  it('уровень и дата подписи заданы у каждой', () => {
    for (const view of compromiseViews()) {
      expect(['limitation', 'workaround', 'risk']).toContain(view.severity);
      expect(view.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('подпись, которой нет в реестре, в ответ не попадает', () => {
    const ids = ['no-client-tools', 'typo-here'] as unknown as CompromiseId[];
    expect(compromisesOf(ids)).toEqual(['no-client-tools']);
  });

  it('маршрут раздела отдаёт тот же список', async () => {
    const app = Fastify();
    registerCompromiseRoutes(app, {} as unknown as ServerContext);
    const response = await app.inject({ method: 'GET', url: '/api/compromises' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as CompromisesResponse).items).toEqual(compromiseViews());
    await app.close();
  });
});
