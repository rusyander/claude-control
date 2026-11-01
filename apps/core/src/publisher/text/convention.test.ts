import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectConvention,
  isConventional,
  languageOf,
  loadPublishTextConfig,
  matchesConvention,
} from './index.ts';

describe('publisher/text convention', () => {
  it('conventional subjects, language and DCO share come from the history', () => {
    const history = [
      'feat(web): кнопка выгрузки',
      'fix: повтор обновления токена',
      'fix!: убран старый вход\n\nSigned-off-by: Dev <dev@example.com>',
      'Обновлены зависимости',
    ];
    expect(detectConvention(history)).toEqual({
      conventional: true,
      language: 'ru',
      signedOffShare: 0.25,
    });
    expect(detectConvention(['Update readme', 'Add login'])).toMatchObject({
      conventional: false,
      language: 'en',
    });
    expect(detectConvention([])).toEqual({ conventional: false, language: '', signedOffShare: 0 });
  });

  it('a message matches when its shape and language follow the repo', () => {
    const conv = { conventional: true, language: 'ru', signedOffShare: 0 };
    expect(matchesConvention('fix: повтор запроса `fetchUser`', conv)).toBe(true);
    expect(matchesConvention('fix: retry the request', conv)).toBe(false);
    expect(matchesConvention('повтор запроса', conv)).toBe(false);
    expect(matchesConvention('anything', { ...conv, conventional: false, language: '' })).toBe(
      true,
    );
    expect(isConventional('feat(): x')).toBe(false);
    expect(isConventional('feature: x')).toBe(false);
    expect(languageOf('123')).toBe('');
  });

  it('config: absent file = empty defaults, junk fields dropped, broken JSON = unknown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'adk-text-'));
    try {
      expect(await loadPublishTextConfig(home)).toEqual({
        value: { companyNames: [], requireSignOff: false },
      });
      writeFileSync(
        join(home, 'publish-text.json'),
        JSON.stringify({ companyNames: ['Example Corp', 7, ' '], requireSignOff: 'yes' }),
      );
      expect(await loadPublishTextConfig(home)).toEqual({
        value: { companyNames: ['Example Corp'], requireSignOff: false },
      });
      writeFileSync(join(home, 'publish-text.json'), '{');
      expect(await loadPublishTextConfig(home)).toEqual({
        unknown: 'publish-text.json is not JSON',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
