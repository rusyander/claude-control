import { describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';
import { liveTaskOptions } from './taskOptions';

/**
 * Вкладка «Правка задачи»: состояние задачи в выборе — словами на языке панели, как в списке
 * задач и на ленте (этап 10, F4); неизвестное ядру панели состояние — как есть.
 */
describe('task tab picker names the task state in words', () => {
  const live = [
    { taskId: 't1', title: 'README.md: typo', state: 'awaiting-launch' },
    { taskId: 't2', title: null, state: 'brand-new-state' },
  ];

  it('ru panel: «ждёт запуска», untitled task by id, unknown state verbatim', async () => {
    await i18n.changeLanguage('ru');
    expect(liveTaskOptions(i18n.t, live)).toEqual([
      { value: 't1', label: 'README.md: typo · ждёт запуска' },
      { value: 't2', label: 't2 · brand-new-state' },
    ]);
  });

  it('en panel: the same state in English, never the raw machine value', async () => {
    await i18n.changeLanguage('en');
    const [first] = liveTaskOptions(i18n.t, live);
    expect(first?.label).toMatch(/^README\.md: typo · /);
    expect(first?.label).not.toContain('awaiting-launch');
    expect(first?.label).toBe(
      `README.md: typo · ${i18n.t('coreTimeline.taskState.awaiting-launch')}`,
    );
  });
});
