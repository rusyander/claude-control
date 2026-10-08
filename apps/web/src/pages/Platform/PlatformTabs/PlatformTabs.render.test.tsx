import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { PlatformTabs } from './PlatformTabs';
import { platformPanelDomId } from '../model/platformPanelDomId';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

/**
 * Страница рисует панель только открытой вкладки (`PlatformPage`), поэтому
 * `aria-controls` остальных вёл бы на несуществующий id (ревью 28.09, F-215 —
 * сосед вкладок групп).
 */
describe('вкладки контура: aria-controls только у открытой', () => {
  it('ссылка одна — на панель, которая есть в разметке', () => {
    const html = renderToStaticMarkup(<PlatformTabs active="rules" onSelect={() => undefined} />);

    expect(html.match(/aria-controls=/g)?.length).toBe(1);
    expect(html).toContain(`aria-controls="${platformPanelDomId('rules')}"`);
  });
});
