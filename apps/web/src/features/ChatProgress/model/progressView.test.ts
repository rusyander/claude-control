import { describe, it, expect } from 'vitest';
import { summarizeProgress } from './progressView';

/**
 * Свёрнутая полоса прогресса отвечает на единственный вопрос: «сколько сделано и
 * что делается сейчас». Ошибка в счёте здесь дороже всего — ради него панель и
 * открывают.
 */
describe('summarizeProgress', () => {
  it('без плана панель не показывается вовсе', () => {
    expect(summarizeProgress(undefined).hasAnything).toBe(false);
    expect(summarizeProgress({ tasks: [], agents: [] }).hasAnything).toBe(false);
  });

  it('считает выполненные и называет текущий шаг', () => {
    const summary = summarizeProgress({
      tasks: [
        { text: 'разобрать', status: 'completed' },
        { text: 'починить', status: 'in_progress' },
        { text: 'проверить', status: 'pending' },
      ],
      agents: [],
    });

    expect(summary).toMatchObject({ total: 3, done: 1, current: 'починить', hasAnything: true });
  });

  it('субагенты считаются отдельно: работающие и всего', () => {
    const summary = summarizeProgress({
      tasks: [],
      agents: [
        { id: '1', kind: 'Explore', description: 'поиск', status: 'running' },
        { id: '2', kind: 'general-purpose', description: 'аудит', status: 'done' },
      ],
    });

    expect(summary).toMatchObject({ agentsRunning: 1, agentsTotal: 2, hasAnything: true });
  });

  it('плана нет, но субагенты есть — панель всё равно нужна', () => {
    const summary = summarizeProgress({
      tasks: [],
      agents: [{ id: '1', kind: 'Explore', description: 'поиск', status: 'running' }],
    });
    expect(summary.hasAnything).toBe(true);
    expect(summary.current).toBeUndefined();
  });
});
