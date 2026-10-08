import { describe, it, expect } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { setCodexTableBoolean, UnrecognizedFormatError } from './codex-toml.ts';

/**
 * `setCodexTableBoolean` — включение плагина Codex: строка `enabled` в
 * `[plugins."имя@рынок"]`. Инвариант: меняется одна строка (или добавляется
 * одна под заголовком), всё прочее байт-в-байт; таблицы нет — отказ, а не
 * дописанная наугад секция.
 */
describe('setCodexTableBoolean', () => {
  const src = `model = "gpt-5"

[marketplaces.qa-mkt]
source_type = "local"

[plugins."hello@qa-mkt"]
enabled = true # включён панелью

[plugins."other@qa-mkt"]
enabled = true
`;

  it('меняет только значение нужной таблицы, комментарий и соседи целы', () => {
    const next = setCodexTableBoolean(src, ['plugins', 'hello@qa-mkt'], 'enabled', false);
    expect(next).toBe(src.replace('enabled = true # включён', 'enabled = false # включён'));
    const parsed = parseToml(next) as { plugins: Record<string, { enabled: boolean }> };
    expect(parsed.plugins['other@qa-mkt']!.enabled).toBe(true);
  });

  it('таблица находится по смыслу заголовка, а не по написанию', () => {
    const spaced = src.replace('[plugins."hello@qa-mkt"]', "[ plugins . 'hello@qa-mkt' ]");
    const next = setCodexTableBoolean(spaced, ['plugins', 'hello@qa-mkt'], 'enabled', false);
    const parsed = parseToml(next) as { plugins: Record<string, { enabled: boolean }> };
    expect(parsed.plugins['hello@qa-mkt']!.enabled).toBe(false);
  });

  it('ключа нет — строка добавляется под заголовком, CRLF сохраняется', () => {
    const crlf = '[plugins."hello@qa-mkt"]\r\nnote = "x"\r\n';
    const next = setCodexTableBoolean(crlf, ['plugins', 'hello@qa-mkt'], 'enabled', false);
    expect(next).toBe('[plugins."hello@qa-mkt"]\r\nenabled = false\r\nnote = "x"\r\n');
  });

  it('то же значение — текст не меняется', () => {
    expect(setCodexTableBoolean(src, ['plugins', 'other@qa-mkt'], 'enabled', true)).toBe(src);
  });

  it('таблицы нет или она задана inline — отказ, без записи', () => {
    expect(() => setCodexTableBoolean(src, ['plugins', 'ghost@qa-mkt'], 'enabled', false)).toThrow(
      UnrecognizedFormatError,
    );
    const inline = 'plugins = { "hello@qa-mkt" = { enabled = true } }\n';
    expect(() =>
      setCodexTableBoolean(inline, ['plugins', 'hello@qa-mkt'], 'enabled', false),
    ).toThrow(UnrecognizedFormatError);
    expect(() => setCodexTableBoolean('not = [toml', ['plugins', 'x'], 'enabled', true)).toThrow(
      UnrecognizedFormatError,
    );
  });
});
