import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { GroupPermissionRows } from './GroupPermissionRows';

/**
 * Три положения строки разрешений групп (аудит 25.09, L51): тумблер давал
 * только «сама» и «человеку», середины «пусть идёт, но покажи» не было.
 */

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('строки разрешений групп', () => {
  it('у строки три положения, отмечено текущее', () => {
    const html = renderToStaticMarkup(
      <GroupPermissionRows
        rows={[
          { id: 'gitWrite', level: 'notify', own: false },
          { id: 'gitHistory', level: 'human', own: true },
        ]}
        onChange={() => {}}
      />,
    );
    // Кнопки-переключатели в группе, а не радио: у радио обещаны стрелки и один
    // шаг табом на группу, которых нет (ревью 28.09, F-244).
    expect(html).not.toContain('role="radio');
    expect(html.split('role="group"').length - 1).toBe(2);
    expect(html.split('aria-pressed=').length - 1).toBe(6);
    const checked = [...html.matchAll(/aria-pressed="true"[^>]*>([^<]*)/g)].map(
      (match) => match[1],
    );
    expect(checked).toEqual([
      i18n.t('settings.groups.level.notify'),
      i18n.t('settings.groups.level.human'),
    ]);
  });
});
