import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FormatCheckProvider } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { FormatCheckRow } from './FormatCheckRow';

/**
 * Строка «схемы нет» приходит с сервера. Раньше она ехала только русским
 * текстом, и английская «Сверка форматов» показывала «Схема config.toml
 * официально не публикуется…» (кадр справки providers/switch, 28.09). Теперь
 * рядом едут `noteCode` + `noteParams`, а русский текст остаётся запасным.
 */
const NO_SCHEMA: FormatCheckProvider = {
  providerId: 'codex',
  state: 'no-schema',
  keys: [],
  note: 'Схема config.toml официально не публикуется — сверять не с чем.',
  noteCode: 'checks-format-no-schema',
  noteParams: { file: 'config.toml' },
};

function render(row: FormatCheckProvider): string {
  return renderToStaticMarkup(<FormatCheckRow row={row} name="Codex" />).replace(/<[^>]+>/g, ' ');
}

describe('сверка форматов: пояснение строки на языке интерфейса', () => {
  afterAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('en: «схемы нет» по-английски, с именем файла', async () => {
    await i18n.changeLanguage('en');
    const text = render(NO_SCHEMA);
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
    expect(text).toContain('config.toml');
  });

  it('ru: тот же текст, что пишет сервер', async () => {
    await i18n.changeLanguage('ru');
    expect(render(NO_SCHEMA)).toContain(NO_SCHEMA.note);
  });

  it('без кода (ошибка сети) — текст сервера как есть', async () => {
    await i18n.changeLanguage('en');
    const row: FormatCheckProvider = {
      providerId: 'opencode',
      state: 'unavailable',
      keys: [],
      note: 'HTTP 404',
    };
    expect(render(row)).toContain('HTTP 404');
  });
});
