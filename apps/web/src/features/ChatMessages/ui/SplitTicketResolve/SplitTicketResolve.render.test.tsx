import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatTreeView, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import {
  bundleSplitTickets,
  clusterSplitTickets,
  openSplitTickets,
  type SplitTicketPublished,
  type SplitTicketTarget,
} from '@agentdeck/contracts/split-ticket-batch';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import { ChildStages } from '../ChildStages/ChildStages';
import { SplitTicketResolveBody } from './SplitTicketResolveBody';
import { SplitTicketResolveActions } from './SplitTicketResolveActions';
import type { SplitTicketResolveActionsProps, TargetState } from './SplitTicketResolve.types';

/**
 * «Разобрать…» в хабе (владелец 24.10.2026). Кнопка — в настоящей карточке
 * `ChildStages`, как её видит человек; тело и низ окна — в каждом состоянии
 * напрямую (окно рисуется порталом, статическая отрисовка его не видит).
 */

const at = '2026-10-24T10:00:00.000Z';
const EXPORT = { title: 'Падает экспорт', where: 'apps/web/src/export.ts:42', why: 'пусто', at };
const SAVE = { title: 'Кнопка не жмётся', where: 'apps/web/src/save.tsx:7', why: 'disabled', at };
const DRAFT_LOST = {
  title: 'Черновик теряется при уходе',
  where: 'apps/web/src/save.tsx:30',
  why: 'нет автосохранения',
  at,
};

type Tickets = NonNullable<SplitPlanView['groups'][number]['tickets']>;

const plan = (first: Tickets, second: Tickets = []): SplitPlanView =>
  ({
    parentChatId: 'parent',
    order: [0, 1],
    groups: [
      { index: 0, title: 'Вход', branch: 'agent/g0', after: [], status: 'done', tickets: first },
      { index: 1, title: 'Отчёт', branch: 'agent/g1', after: [], status: 'done', tickets: second },
    ],
  }) as unknown as SplitPlanView;

/** `open` — разделы под карточками раскрыты (строки предложений видны). */
function hub(split: SplitPlanView, { foreign = false, open = false } = {}): string {
  const tree = { root: 'parent', running: 0, split };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages
        groups={mergeSplitGroups(new Map(), split)}
        onOpen={() => {}}
        tree={tree as unknown as ChatTreeView}
        foreign={foreign}
        sectionsOpen={open}
      />
    </QueryClientProvider>,
  );
}

const connected: SplitTicketTarget = {
  connected: true,
  site: 'https://tracker.example.com',
  projects: [
    { key: 'PROJ', name: 'Project' },
    { key: 'OPS', name: 'Ops' },
  ],
  projectKey: 'PROJ',
  projectFrom: 'bound',
  issueTypes: ['Task', 'Bug'],
  issueType: 'Bug',
};

function body(
  target: TargetState,
  extra: { result?: SplitTicketPublished; error?: string } = {},
): string {
  // Экспорт нашли обе группы и ещё раз — другими словами по тому же месту;
  // в файле кнопки — второй, другой дефект: одна задача на оба.
  const clusters = clusterSplitTickets(
    openSplitTickets(
      plan([EXPORT, SAVE], [{ ...EXPORT, title: 'Экспорт пустой' }, DRAFT_LOST]).groups,
    ),
  );
  return renderToStaticMarkup(
    <SplitTicketResolveBody
      bundles={bundleSplitTickets(clusters)}
      target={target}
      project={target.state === 'ready' ? (target.data.projectKey ?? '') : ''}
      issueType="Bug"
      onProject={() => {}}
      onIssueType={() => {}}
      {...extra}
    />,
  );
}

const noop = () => {};
function actions(props: Partial<SplitTicketResolveActionsProps>): string {
  return renderToStaticMarkup(
    <SplitTicketResolveActions
      publishing={false}
      taking={false}
      canTake
      offline={false}
      onPublish={noop}
      onRetry={noop}
      onTake={noop}
      onConnect={noop}
      onClose={noop}
      {...props}
    />,
  );
}

const button = (html: string, attr: string): string =>
  html.match(new RegExp(`<button[^>]*${attr}[^>]*>`))?.[0] ?? '';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('«Разобрать…» — кнопка в заголовке «Предложить тикет»', () => {
  it('есть открытые предложения — кнопка видна', () => {
    const html = hub(plan([EXPORT, SAVE]));

    expect(html).toContain('data-resolve-tickets="2"');
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.action'));
  });

  it('все заведены или взяты — кнопки нет; взятое показывает «Взято в чат»', () => {
    const html = hub(
      plan([
        { ...EXPORT, filed: { key: 'PROJ-1', at } },
        { ...SAVE, taken: { chatId: 'new-1', at } },
      ]),
      { open: true },
    );

    expect(html).not.toContain('data-resolve-tickets');
    expect(html).toContain('data-ticket-taken="new-1"');
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.taken'));
    expect(html).toContain('data-ticket-filed="PROJ-1"');
  });

  it('строка ушла комментарием в открытую задачу — подпись «уже была открыта», у заведённой — «Заведено»', () => {
    const html = hub(
      plan([
        { ...EXPORT, filed: { key: 'PROJ-9', at, commented: true } },
        { ...SAVE, filed: { key: 'PROJ-1', at } },
      ]),
      { open: true },
    );

    expect(html.match(/data-ticket-commented/g)).toHaveLength(1);
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.filedCommented', { key: 'PROJ-9' }));
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.filed', { key: 'PROJ-1' }));
    expect(html).not.toContain(i18n.t('chat.cascade.hub.tickets.filed', { key: 'PROJ-9' }));
  });
});

describe('окно «Разобрать…» — тело', () => {
  it('Jira подключена: число открытых, повторы, список, сайт, проект с причиной выбора', () => {
    const html = body({ state: 'ready', data: connected });

    expect(html).toContain('data-resolve-open="4"');
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.open', { count: 4 }));
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.duplicates', { count: 1 }));
    expect(html.match(/data-resolve-duplicate/g)).toHaveLength(1);
    // Связки: экспорт (с повтором) — одна задача, два дефекта файла кнопки — другая.
    expect(html).toContain('data-resolve-planned="2"');
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.planned', { count: 2 }));
    expect(html.match(/data-resolve-bundle="\d+"/g)).toEqual([
      'data-resolve-bundle="1"',
      'data-resolve-bundle="2"',
    ]);
    expect(html).toContain(
      i18n.t('chat.cascade.hub.tickets.resolve.bundleFiles', { files: 'apps/web/src/save.tsx' }),
    );
    expect(html).toContain('Кнопка не жмётся');
    expect(html).toContain('https://tracker.example.com');
    expect(html).toContain('PROJ — Project');
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.projectFrom.bound'));
  });

  it('Jira не подключена — сказано, где подключить, выбора проекта нет', () => {
    const html = body({ state: 'ready', data: { connected: false, projects: [], issueTypes: [] } });

    expect(html).toContain('data-resolve-offline');
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.offline'));
    expect(html).not.toContain('data-resolve-target');
  });

  it('чтение Jira не удалось — причина текстом', () => {
    const html = body({ state: 'error', message: 'нет сети' });

    expect(html).toContain('data-resolve-target-error');
    expect(html).toContain('нет сети');
  });

  it('итог: ключи ссылками, сколько собрала каждая, упавшие с причиной, режим без модели', () => {
    const html = body(
      { state: 'ready', data: connected },
      {
        result: {
          mode: 'fallback',
          issues: [
            {
              key: 'PROJ-7',
              url: 'https://tracker.example.com/browse/PROJ-7',
              title: 'Падает экспорт',
              proposals: ['a', 'b'],
              created: true,
              defects: [{ title: 'Падает экспорт', duplicates: ['Экспорт падает'] }],
            },
          ],
          failed: [{ title: 'Кнопка не жмётся', proposals: ['c'], message: 'Jira 500' }],
        },
      },
    );

    expect(html).toContain('href="https://tracker.example.com/browse/PROJ-7"');
    expect(html).toContain('data-resolve-issue="PROJ-7"');
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.merged', { count: 2 }));
    expect(html).toContain('data-resolve-failed');
    expect(html).toContain('Jira 500');
    expect(html).toContain('data-resolve-fallback');
    // В итоге выбора проекта уже нет.
    expect(html).not.toContain('data-resolve-target');
    // Что склеено: дефект и повтор, сведённый в него.
    expect(html).toContain(
      i18n.t('chat.cascade.hub.tickets.resolve.defectMerged', { titles: 'Экспорт падает' }),
    );
  });

  it('итог: открытая задача получила комментарий; задача из двух дефектов их перечисляет', () => {
    const html = body(
      { state: 'ready', data: connected },
      {
        result: {
          mode: 'model',
          issues: [
            {
              key: 'PROJ-9',
              url: 'https://tracker.example.com/browse/PROJ-9',
              title: 'Падает экспорт отчётов',
              proposals: ['a'],
              created: false,
              commented: true,
              defects: [{ title: 'Падает экспорт', duplicates: [] }],
            },
            {
              key: 'PROJ-10',
              url: 'https://tracker.example.com/browse/PROJ-10',
              title: 'Сохранение: кнопка и черновик',
              proposals: ['b', 'c'],
              created: true,
              defects: [
                { title: 'Кнопка не жмётся', duplicates: [] },
                { title: 'Черновик теряется при уходе', duplicates: [] },
              ],
            },
          ],
          failed: [],
        },
      },
    );

    expect(html.match(/data-resolve-commented/g)).toHaveLength(1);
    expect(html).toContain(i18n.t('chat.cascade.hub.tickets.resolve.commented'));
    expect(html.match(/data-resolve-defects/g)).toHaveLength(1);
    expect(html).toContain('Черновик теряется при уходе');
    expect(html).not.toContain('data-resolve-fallback');
  });
});

describe('окно «Разобрать…» — действия', () => {
  it('всё готово — оба действия включены', () => {
    const html = actions({});

    expect(button(html, 'data-resolve-publish')).not.toContain('disabled=""');
    expect(button(html, 'data-resolve-take')).not.toContain('disabled=""');
  });

  it('Jira нет — «Опубликовать» выключено с причиной, «Решить здесь» работает, есть «Подключить»', () => {
    const html = actions({ publishBlocked: 'Jira не подключена', offline: true });

    expect(button(html, 'data-resolve-publish')).toContain('disabled=""');
    expect(button(html, 'data-resolve-publish')).toContain('title="Jira не подключена"');
    expect(html).toContain('data-resolve-connect');
    expect(button(html, 'data-resolve-take')).not.toContain('disabled=""');
  });

  it('чужой CLI — «Решить здесь» нет', () => {
    expect(actions({ canTake: false })).not.toContain('data-resolve-take');
  });

  it('итог с упавшими — «Повторить упавшие»; без упавших — только «Закрыть»', () => {
    const failed = actions({
      result: {
        mode: 'model',
        issues: [],
        failed: [{ title: 'x', proposals: ['k'], message: 'm' }],
      },
    });
    const clean = actions({ result: { mode: 'model', issues: [], failed: [] } });

    expect(failed).toContain('data-resolve-retry');
    expect(clean).not.toContain('data-resolve-retry');
    expect(clean).not.toContain('data-resolve-publish');
    expect(clean).toContain(i18n.t('chat.cascade.hub.tickets.resolve.close'));
  });
});
