import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { Typography } from '@shared/ui/typography';
import type { GroupListItem } from '@entities/Group';
import { GroupsTabs } from './GroupsTabs/GroupsTabs';
import { GroupTile } from './GroupTile/GroupTile';

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

function group(patch: Partial<GroupListItem> = {}): GroupListItem {
  return {
    id: 'g1',
    name: 'Набор',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    isEnabled: true,
    order: 0,
    ...patch,
  };
}

const PATH = {
  steps: [
    { id: 's1', title: { ru: 'Сборка', en: 'Build' } },
    { id: 's2', title: { ru: 'Ревью', en: 'Review' } },
  ],
} as unknown as GroupListItem['path'];

describe('вкладки групп: aria-controls только у открытой (F-215)', () => {
  it('полоса страницы: две вкладки, панель в разметке одна — на неё и ссылается одна вкладка', () => {
    const html = renderToStaticMarkup(
      <GroupsTabs
        active="project"
        counts={{ global: count, project: count }}
        onSelect={() => undefined}
      />,
    );
    expect(html.match(/role="tab"/g)?.length).toBe(2);
    expect(html.match(/aria-controls=/g)?.length).toBe(1);
    expect(html).toContain('aria-controls="groups-panel-project"');
  });
});

// Этап 10, F1: прежний исполнитель групп снят — карточка только для чтения.
describe('карточка прежней группы: только для чтения', () => {
  it('единственная кнопка — «В ядро»; ни тумблера, ни копии, имя не кнопка', () => {
    const html = renderToStaticMarkup(
      <GroupTile group={group({ path: PATH })} onCore={() => undefined} />,
    );
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(html).toContain('data-group-core-import');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('Сборка');
    expect(html).toContain('Ревью');
  });

  it('шагов нет — переводить нечего, кнопки «В ядро» нет', () => {
    const html = renderToStaticMarkup(<GroupTile group={group()} onCore={() => undefined} />);
    expect(html).not.toContain('<button');
  });

  const whenLine = (html: string): string =>
    /<p class="([^"]*)"[^>]*><span[^>]*>Когда: <\/span>/.exec(html)?.[1] ?? '';

  it('пустое «Когда» — запасной текст цветом `subtle`, заполненное — `muted` (F-237)', () => {
    const empty = renderToStaticMarkup(<GroupTile group={group()} />);
    expect(empty).toContain(i18n.t('groupSources.whenEmpty'));
    expect(whenLine(empty).split(' ')).toContain(colorClass('subtle'));
    const filled = renderToStaticMarkup(<GroupTile group={group({ when: 'задача с тикетом' })} />);
    expect(whenLine(filled).split(' ')).toContain(colorClass('muted'));
  });
});
