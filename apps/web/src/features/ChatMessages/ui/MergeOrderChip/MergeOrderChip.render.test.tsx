import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { MergeOrderChip } from './MergeOrderChip';

/**
 * Номер в очереди слияния (G3) на обоих языках: русская форма «2-м из 3»,
 * английская — порядковым «2nd of 3»; подсказка называет, кого влить раньше,
 * а без зависимостей так и говорит.
 */
afterAll(async () => {
  await i18n.changeLanguage('ru');
});

const render = (before: string[]) =>
  renderToStaticMarkup(<MergeOrderChip order={{ position: 2, total: 3, before }} />);

describe('MergeOrderChip', () => {
  it('ru: «мержить 2-м из 3», в подсказке — имена в ёлочках', async () => {
    await i18n.changeLanguage('ru');
    const html = render(['Настройки', 'Схема БД']);
    expect(html).toContain('мержить 2-м из 3');
    expect(html).toContain('data-merge-order="2"');
    expect(html).toContain('title="Сначала влейте MR групп: «Настройки», «Схема БД»"');
  });

  it('en: порядковое «merge 2nd of 3», подсказка по-английски', async () => {
    await i18n.changeLanguage('en');
    const html = render(['Settings']);
    expect(html).toContain('merge 2nd of 3');
    expect(html).toContain('title="Merge the MRs of these groups first: “Settings”"');
  });

  it('без зависимостей — подсказка про порядок плана', async () => {
    await i18n.changeLanguage('ru');
    expect(render([])).toContain('Ни от одного другого MR не зависит');
  });
});
