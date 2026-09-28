import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { PathToolbar } from './PathToolbar';

const render = (query: string, shown: number, announcement = ''): string => {
  const html = renderToStaticMarkup(
    <PathToolbar
      query={query}
      onQuery={() => undefined}
      total={9}
      shown={shown}
      hasBlocks={false}
      isAllOpen
      onToggleAll={() => undefined}
      isEmpty={false}
      onAdd={() => undefined}
      announcement={announcement}
    />,
  );
  return /role="status"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('живая область пути говорит итог фильтра (F-278)', () => {
  it('фильтр нашёл шаги — сколько показано', () => {
    expect(render('e2e', 2)).toBe('показано 2 из 9');
  });

  it('фильтр не нашёл ничего — так и говорит', () => {
    expect(render('zzz', 0)).toBe('Под фильтр ни один шаг не подходит.');
  });

  it('без фильтра — объявление переноса', () => {
    expect(render('', 9, 'Шаг взят')).toBe('Шаг взят');
  });
});
