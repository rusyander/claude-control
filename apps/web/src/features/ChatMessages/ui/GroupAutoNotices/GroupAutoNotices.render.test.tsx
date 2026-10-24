import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GROUP_PLAN_FREE_ANSWER } from '@agentdeck/contracts/task-split';
import { i18n } from '@shared/config/i18n';
import type { GroupAutoNoticesState } from '../GroupAutoNotices.types';
import { GroupAutoNotices } from './GroupAutoNotices';

/**
 * Отметки группы в хабе (F-47): ответ панели на вопрос группы («по плану») —
 * своей строкой «Ответ дан автоматически», а не «Разрешено автоматически»; ответ
 * свободным текстом — подписью на языке интерфейса, а не английским текстом,
 * который ушёл агенту. Отметки — в форме, которую пишет сервер
 * (`recordGroupAnswerNotice`: подпись до 160 знаков, `kind`, `free`).
 */

const cut = (text: string): string => `${text.slice(0, 159)}…`;

const state = (notices: GroupAutoNoticesState['notices']): GroupAutoNoticesState => ({
  parentChatId: 'parent',
  index: 1,
  notices,
});

const AT = '2026-10-23T10:00:00.000Z';

function render(value: GroupAutoNoticesState): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GroupAutoNotices autoNotices={value} />
    </QueryClientProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '');

afterEach(async () => {
  await i18n.changeLanguage('ru');
});

describe('GroupAutoNotices — разрешения и ответы панели раздельно (F-47)', () => {
  const mixed = state([
    { at: AT, summary: 'pnpm build' },
    { at: AT, summary: 'Б (Recommended)', kind: 'answer' },
    { at: AT, summary: cut(GROUP_PLAN_FREE_ANSWER), kind: 'answer', free: true },
  ]);

  it('ответы — строкой «Ответ дан автоматически», разрешения — своей', () => {
    const text = textOf(render(mixed));

    expect(text).toContain('Разрешено автоматически: pnpm build');
    expect(text).toContain(
      'Ответ дан автоматически: Б (Recommended); свободный ответ — решить самой',
    );
    expect(text).not.toMatch(/Разрешено автоматически:[^О]*Б \(Recommended\)/);
    // Английский текст, ушедший агенту, человеку не показывается.
    expect(text).not.toContain('Autonomous mode');
  });

  it('только ответы — строки «Разрешено» нет', () => {
    const text = textOf(
      render(
        state([{ at: AT, summary: 'apply own recommendations and continue', kind: 'answer' }]),
      ),
    );

    expect(text).toContain('Ответ дан автоматически: apply own recommendations and continue');
    expect(text).not.toContain('Разрешено автоматически');
  });

  it('в английском интерфейсе — английские подписи', async () => {
    await i18n.changeLanguage('en');
    const text = textOf(render(mixed));

    expect(text).toContain('Allowed automatically: pnpm build');
    expect(text).toContain(
      'Answered automatically: Б (Recommended); free answer — decide yourself',
    );
  });
});
