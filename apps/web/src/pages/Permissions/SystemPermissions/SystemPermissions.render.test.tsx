import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PERMISSION_PRESETS } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { SystemPermissions } from './SystemPermissions';

const CYRILLIC = /[А-Яа-яЁё]/;

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SystemPermissions rules={[]} onEdit={() => undefined} onCreate={() => undefined} />
    </QueryClientProvider>,
  );
}

/**
 * Карточки «Системные» строятся из заготовок contracts, а там названия и
 * пояснения по-русски: английская страница показывала «Чтение любых файлов»
 * (кадр справки permissions/setup, 28.09). Текст заготовки идёт через словарь.
 */
describe('системные права: заготовки на языке интерфейса', () => {
  afterAll(async () => {
    await i18n.changeLanguage('ru');
  });

  describe('en', () => {
    beforeAll(async () => {
      await i18n.changeLanguage('en');
    });

    it('ни одной русской буквы на странице', () => {
      const text = render().replace(/<[^>]+>/g, ' ');
      expect(text.match(/\S*[А-Яа-яЁё]\S*/g) ?? []).toEqual([]);
    });

    it('у каждой заготовки английское название', () => {
      const html = render();
      expect(html).toContain('Read any file');
      expect(html).toContain('Push to a remote repository');
    });
  });

  describe('ru', () => {
    beforeAll(async () => {
      await i18n.changeLanguage('ru');
    });

    it('русские названия — те же, что в contracts', () => {
      const html = render();
      for (const preset of PERMISSION_PRESETS) {
        expect(CYRILLIC.test(preset.title)).toBe(true);
        expect(html).toContain(preset.title);
      }
    });
  });
});
