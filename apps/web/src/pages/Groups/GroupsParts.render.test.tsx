import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiscoveredGroup, DiscoveryView } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { Typography } from '@shared/ui/typography';
import { GroupsTabs } from './GroupsTabs/GroupsTabs';
import { GroupViewTabs } from './GroupViewTabs/GroupViewTabs';
import { DiscoveryProgress } from './DiscoveryProgress/DiscoveryProgress';
import { FoundTile } from './FoundTile/FoundTile';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const count = { count: 1 };

/** Класс, которым Typography красит строку цветом `color`. */
function colorClass(color: 'muted' | 'subtle'): string {
  const html = renderToStaticMarkup(
    <Typography variant="body-sm" color={color}>
      x
    </Typography>,
  );
  const classes = /class="([^"]*)"/.exec(html)?.[1] ?? '';
  return classes.split(' ').find((name) => name.includes('color-')) ?? '';
}

describe('вкладки групп: aria-controls только у открытой (F-215)', () => {
  it('полоса страницы: панель в разметке одна — на неё и ссылается одна вкладка', () => {
    const html = renderToStaticMarkup(
      <GroupsTabs
        active="project"
        counts={{ global: count, project: count, found: count, discovery: count }}
        onSelect={() => undefined}
      />,
    );
    expect(html.match(/aria-controls=/g)?.length).toBe(1);
    expect(html).toContain('aria-controls="groups-panel-project"');
  });

  it('вкладки окна группы — то же', () => {
    const html = renderToStaticMarkup(
      <GroupViewTabs idBase="group-g" active="members" onSelect={() => undefined} />,
    );
    expect(html.match(/aria-controls=/g)?.length).toBe(1);
    expect(html).toContain('aria-controls="group-g-panel-members"');
  });
});

describe('журнал обнаружения: «ошибок нет» только когда всё прочитано (F-210)', () => {
  const view = (states: DiscoveryView['sources'][number]['state'][]): DiscoveryView => ({
    groups: [],
    running: states.includes('running'),
    sources: states.map((state, index) => ({ source: `C:/work/p${index}`, state, found: 0 })),
  });
  const allGood = () => i18n.t('groupsPage.discovery.allGood');

  it('источник ещё читается — строки «ошибок нет» нет', () => {
    expect(
      renderToStaticMarkup(<DiscoveryProgress view={view(['running', 'done'])} />),
    ).not.toContain(allGood());
  });

  it('всё прочитано без сбоев — строка есть; сбой — нет', () => {
    expect(renderToStaticMarkup(<DiscoveryProgress view={view(['done', 'cached'])} />)).toContain(
      allGood(),
    );
    expect(renderToStaticMarkup(<DiscoveryProgress view={view(['failed'])} />)).not.toContain(
      allGood(),
    );
  });
});

describe('карточка: пустое «Когда» приглушено (F-237)', () => {
  const found = (when: string): DiscoveredGroup => ({
    key: 'k',
    name: 'Набор',
    when,
    why: '',
    foundIn: 'C:/work/shop',
    usedIn: [],
    members: [],
    steps: [],
    inventoryHash: 'h',
    status: 'new',
  });
  const whenLine = (html: string): string =>
    /<p class="([^"]*)"[^>]*><span[^>]*>Когда: <\/span>/.exec(html)?.[1] ?? '';

  it('пусто — запасной текст цветом `subtle`, заполнено — `muted`', () => {
    const empty = renderToStaticMarkup(<FoundTile found={found('')} onOpen={() => undefined} />);
    expect(empty).toContain(i18n.t('groupSources.whenEmpty'));
    expect(whenLine(empty).split(' ')).toContain(colorClass('subtle'));
    const filled = renderToStaticMarkup(
      <FoundTile found={found('задача с тикетом')} onOpen={() => undefined} />,
    );
    expect(whenLine(filled).split(' ')).toContain(colorClass('muted'));
  });
});
