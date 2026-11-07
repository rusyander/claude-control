import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import type { GroupIntakeRow } from '../../model/groupIntake';
import { LaunchCard } from './LaunchCard';

/**
 * Кнопка карточек группы настоящей разметкой карточки запуска (этап 11, W3-18): кнопка называет
 * число ждущих карточек; частичный исход называет каждую неподтверждённую задачу с причиной и
 * предлагает подтвердить оставшиеся; одиночной задаче и запущенной группе кнопки нет.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const intake = (pending: number, rows: GroupIntakeRow[] | null = null) => ({
  pending,
  rows,
  busy: false,
  onConfirm: () => {},
});

const card = (props: Partial<Parameters<typeof LaunchCard>[0]>) =>
  renderToStaticMarkup(
    <LaunchCard
      blockers={['awaiting-split']}
      canLaunch={false}
      launching={false}
      launched={false}
      onLaunch={() => {}}
      {...props}
    />,
  );

describe('group intake confirm on the launch card (W3-18)', () => {
  it('the button names how many cards wait; none waiting and never pressed — no block', () => {
    const html = card({ groupSize: 3, intake: intake(3) });
    expect(html).toContain('Подтвердить карточки группы: 3');
    expect(html).toContain('data-launch-intake-pending="3"');
    expect(card({ groupSize: 3, intake: intake(0) })).not.toContain('data-launch-intake');
  });

  it('a partial confirm names each task not confirmed with its reason and offers the rest', () => {
    const rows: GroupIntakeRow[] = [
      { taskId: 't0', status: 'confirmed' },
      { taskId: 't1', status: 'refused', why: null, reason: 'Ядро не отвечает.' },
      { taskId: 't2', status: 'refused', why: 'ended', reason: '' },
    ];
    const html = card({ groupSize: 3, intake: intake(1, rows) });
    expect(html).toContain('Подтверждено карточек: 1 из 3.');
    expect(html).toContain('data-launch-intake-refused="t1"');
    expect(html).toContain('Задача t1 не подтверждена: Ядро не отвечает.');
    expect(html).toContain('Задача t2 не подтверждена: задача уже кончилась');
    expect(html).not.toContain('data-launch-intake-refused="t0"');
    expect(html).toContain('Подтвердить неподтверждённые карточки группы: 1');
  });

  it('all confirmed: the count stays, the button goes; a single task or a launched group has no block', () => {
    const rows: GroupIntakeRow[] = ['t0', 't1', 't2'].map((taskId) => ({
      taskId,
      status: 'confirmed',
    }));
    const html = card({ groupSize: 3, intake: intake(0, rows) });
    expect(html).toContain('Подтверждено карточек: 3 из 3.');
    expect(html).not.toContain('data-launch-intake-button');
    expect(card({ intake: intake(2) })).not.toContain('data-launch-intake');
    expect(card({ groupSize: 3, launched: true, intake: intake(2) })).not.toContain(
      'data-launch-intake',
    );
  });

  it('only class questions open: no confirm button, a warning line names how many tasks wait and links each feed', () => {
    const classWaiting = [
      { taskId: 'a-1', n: 1 },
      { taskId: 'c-3', n: 3 },
    ];
    const html = card({ groupSize: 3, intake: { ...intake(0), classWaiting } });
    expect(html).toContain('data-launch-class-wait="2"');
    expect(html).toContain(
      'Ждут вашего ответа о классе задачи — задач: 2. Класс выбирается в ленте задачи, кнопки для него здесь нет.',
    );
    expect(html).toContain('href="/core?id=a-1"');
    expect(html).toContain('Задача 1: a-1');
    expect(html).toContain('href="/core?id=c-3"');
    expect(html).toContain('Задача 3: c-3');
    expect(html).not.toContain('data-launch-intake-button');
    // Нет ждущих класса — строки нет; запущенной группе — тоже.
    expect(card({ groupSize: 3, intake: intake(2) })).not.toContain('data-launch-class-wait');
    expect(
      card({ groupSize: 3, launched: true, intake: { ...intake(0), classWaiting } }),
    ).not.toContain('data-launch-class-wait');
  });
});
