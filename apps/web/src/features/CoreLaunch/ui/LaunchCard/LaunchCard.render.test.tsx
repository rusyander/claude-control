import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import type { GroupLaunchRow } from '../../model/groupLaunch';
import { LaunchCard } from './LaunchCard';

/**
 * Кнопка запуска группы настоящей разметкой (этап 11, W3-18): кнопка называет число задач группы;
 * частичный запуск называет сколько пошло и каждую незапущенную задачу с причиной, кнопка
 * предлагает запустить незапущенные; полностью запущенная группа — строка «запущены все».
 */

// Ссылка на задачи ядра требует роутера; карточке под проверкой нужен только её текст.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const card = (props: Partial<Parameters<typeof LaunchCard>[0]>) =>
  renderToStaticMarkup(
    <LaunchCard
      blockers={[]}
      canLaunch
      launching={false}
      launched={false}
      onLaunch={() => {}}
      {...props}
    />,
  );

describe('group launch card (W3-18)', () => {
  it('the button names the group size; a single task keeps its own label', () => {
    expect(card({ groupSize: 3 })).toContain('Запустить группу: задач 3');
    const single = card({});
    expect(single).toContain('Запустить');
    expect(single).not.toContain('Запустить группу');
  });

  it('a partial launch names every task not started with its reason and offers a retry', () => {
    const rows: GroupLaunchRow[] = [
      { taskId: 't0', status: 'started' },
      { taskId: 't1', status: 'refused', why: null, reason: 'state-conflict: task is running' },
      { taskId: 't2', status: 'refused', why: 'awaiting-split', reason: '' },
    ];
    const html = card({ groupSize: 3, groupRows: rows });
    expect(html).toContain('data-launch-group="1/3"');
    expect(html).toContain('Запущено задач: 1 из 3.');
    expect(html).toContain('data-launch-group-refused="t1"');
    expect(html).toContain('Задача t1 не запущена: state-conflict: task is running');
    expect(html).toContain('Задача t2 не запущена: деление ещё не готово');
    expect(html).not.toContain('data-launch-group-refused="t0"');
    expect(html).toContain('Запустить незапущенные задачи группы');
  });

  it('a fully started group says so, with no refusal lines', () => {
    const rows: GroupLaunchRow[] = ['t0', 't1', 't2'].map((taskId) => ({
      taskId,
      status: 'started',
    }));
    const html = card({ groupSize: 3, groupRows: rows, launched: true });
    expect(html).toContain('Запущены все задачи группы: 3');
    expect(html).not.toContain('data-launch-group-refused');
  });
});
