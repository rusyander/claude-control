import { describe, it, expect } from 'vitest';
import { shellView, summarizeProgress } from './progressView';

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

  /**
   * Фон живёт с процессом CLI разговора, а не с ходом. «running» при мёртвом
   * процессе — умершая команда: показывать её живой значит обещать результат,
   * которого не будет. Живой процесс между ходами — команда честно идёт.
   */
  const shell = { id: 's', command: 'pnpm test', status: 'running' as const };

  it('между ходами фон идёт, пока жив процесс, и оборван, когда процесса нет', () => {
    expect(shellView(shell, false, true)).toBe('running');
    expect(shellView(shell, false, false)).toBe('lost');
    expect(shellView(shell, true, false)).toBe('running');

    const idle = summarizeProgress(
      { tasks: [], agents: [], shells: [shell], processAlive: true },
      false,
    );
    expect([idle.shellsRunning, idle.shellsLost]).toEqual([1, 0]);
  });

  it('сервер без признака процесса — судим по прогону, как прежде', () => {
    expect(shellView(shell, true)).toBe('running');
    expect(shellView(shell, false)).toBe('lost');

    const live = summarizeProgress({ tasks: [], agents: [], shells: [shell] }, true);
    const over = summarizeProgress({ tasks: [], agents: [], shells: [shell] }, false);
    expect([live.shellsRunning, live.shellsLost]).toEqual([1, 0]);
    expect([over.shellsRunning, over.shellsLost]).toEqual([0, 1]);
  });

  it('текущий вызов показывается только у живого прогона — и сам по себе зажигает панель', () => {
    const progress = {
      tasks: [],
      agents: [],
      activeTool: { name: 'Bash', summary: 'pnpm install' },
    };

    expect(summarizeProgress(progress, true)).toMatchObject({
      activeTool: { name: 'Bash' },
      hasAnything: true,
    });
    expect(summarizeProgress(progress, false).hasAnything).toBe(false);
  });
});
