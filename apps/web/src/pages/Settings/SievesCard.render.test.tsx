import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BUILTIN_SIEVES, type SievesView } from '@agentdeck/contracts/sieves';
import { i18n } from '@shared/config/i18n';
import { SievesCard } from './SievesCard';

/**
 * Карточка сит рисуется настоящим компонентом под клиентом запросов, в кэше
 * которого лежит ответ `GET /api/sieves` — так, как её видит человек во
 * вкладке «Группы». Ловит сырой ключ перевода (класс или встроенное сито без
 * текста), потерянную кнопку удаления и счёт за месяцы, которых уже не видно.
 */
function render(view?: SievesView): string {
  const client = new QueryClient();
  if (view) client.setQueryData(['project-git', 'sieves'], view);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SievesCard />
    </QueryClientProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');

const learned: SievesView['learned'][number] = {
  id: 'ls-1',
  class: 'consumers',
  status: 'proposed',
  scope: 'project',
  projectPath: 'C:/work/demo',
  trigger: 'A test id is renamed in a component',
  check: 'git grep the old test id across e2e and QA scripts',
  sources: [
    { thread: 'https://tracker.example.com/mr/1#note_1', at: '2026-09-01T00:00:00Z' },
    { thread: 'https://tracker.example.com/mr/2#note_2', at: '2026-09-02T00:00:00Z' },
  ],
  createdAt: '2026-09-01T00:00:00Z',
  lastSeenAt: '2026-09-02T00:00:00Z',
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка сит перед MR', () => {
  it('каждое встроенное сито и каждый класс — словами, без сырых ключей', () => {
    const html = render({ learned: [learned], tally: {} });

    expect(textOf(html)).not.toMatch(/settings\.sieves\./);
    for (const sieve of BUILTIN_SIEVES) {
      expect(html).toContain(i18n.t(`settings.sieves.builtin.${sieve.id}`));
    }
  });

  it('выученное сито: класс, охват, оба текста и своя кнопка удаления', () => {
    const html = render({ learned: [learned], tally: {} });

    expect(html).toContain('data-learned-sieve="ls-1"');
    expect(html).toContain(i18n.t('settings.sieves.class.consumers'));
    expect(html).toContain(i18n.t('settings.sieves.scopeProject', { path: 'C:/work/demo' }));
    expect(html).toContain(learned.trigger);
    expect(html).toContain(learned.check);
    expect(html).toContain(`aria-label="${i18n.t('settings.sieves.remove')}: ${learned.trigger}"`);
  });

  it('предложенное сито — пометка и две кнопки принятия; принятое общее — без них', () => {
    const proposed = render({ learned: [learned], tally: {} });
    expect(proposed).toContain(i18n.t('settings.sieves.proposed'));
    expect(proposed).toContain(i18n.t('settings.sieves.acceptProject'));
    expect(proposed).toContain(i18n.t('settings.sieves.acceptGlobal'));

    const shared = render({
      learned: [{ ...learned, status: 'active', scope: 'global', projectPath: undefined }],
      tally: {},
    });
    expect(shared).not.toContain(i18n.t('settings.sieves.proposed'));
    expect(shared).not.toContain(i18n.t('settings.sieves.acceptProject'));
    expect(shared).not.toContain(i18n.t('settings.sieves.acceptGlobal'));
    expect(shared).not.toContain(i18n.t('settings.sieves.makeGlobal'));
  });

  it('принятое проектное с советом «для всех» — кнопка «Сделать общим» и сам совет', () => {
    const html = render({
      learned: [{ ...learned, status: 'active', suggestedScope: 'global' }],
      tally: {},
    });
    expect(html).toContain(i18n.t('settings.sieves.makeGlobal'));
    expect(html).toContain(i18n.t('settings.sieves.suggestedGlobal'));
    expect(html).not.toContain(i18n.t('settings.sieves.acceptProject'));
  });

  it('счёт — последние шесть месяцев, новые сверху, пустые классы не рисуются', () => {
    const tally: SievesView['tally'] = {};
    for (let month = 1; month <= 8; month += 1) {
      tally[`2026-0${month}`] = { contract: { escaped: month, caught: 0 } };
    }
    tally['2026-08'] = { ...tally['2026-08'], boundary: { escaped: 0, caught: 3 } };

    const html = render({ learned: [], tally });
    const months = [...html.matchAll(/<th scope="row">(\d{4}-\d{2})<\/th>/g)].map((m) => m[1]);

    expect(new Set(months)).toEqual(
      new Set(['2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03']),
    );
    expect(months[0]).toBe('2026-08');
    expect(months).toHaveLength(7);
    expect(html).toContain(i18n.t('settings.sieves.learnedEmpty'));
  });

  it('пустой счёт и загрузка — поясняющей строкой, не пустой таблицей', () => {
    expect(render({ learned: [], tally: {} })).toContain(i18n.t('settings.sieves.tallyEmpty'));

    const loading = render();
    expect(loading).toContain(i18n.t('settings.sieves.loading'));
    expect(loading).not.toContain('<table');
  });
});
