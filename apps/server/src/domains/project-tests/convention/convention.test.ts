import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LEGACY_BRAND_SLUG } from '../../../lib/brand.mjs';
import { hasConvention, installConvention } from './convention.ts';

/**
 * F-311. Блок соглашения прежней версии (русский) опознавался по одному маркеру:
 * «уже вписано» — и нынешний английский текст не попадал в проект никогда.
 */
const OLD_BODY = [
  '## Тест-кейсы проекта',
  '',
  'Кейсы по интерфейсу лежат в `.agent/tests/`.',
  '',
  '```json',
  '{ "version": 1 }',
  '```',
  '',
  'Правила:',
  '',
  '- не меняй `id`;',
  '- найденный баг — это `status: "failed"`, а не повод чинить код',
  '  без отдельной просьбы.',
  '',
].join('\n');

describe('соглашение о тест-кейсах: блок прежней версии', () => {
  let root = '';
  const file = () => join(root, 'CLAUDE.md');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-convention-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const marker of ['<!-- agentdeck:tests -->', `<!-- ${LEGACY_BRAND_SLUG}:tests -->`]) {
    it(`${marker}: заменяется на месте, дописанное человеком после — остаётся`, () => {
      const before = '# Правила проекта\n\nСвоё.\n\n';
      const after = '\nМой хвост без заголовка.\n\n## Раздел человека\n\nТекст.\n';
      writeFileSync(file(), `${before}${marker}\n${OLD_BODY}${after}`);
      expect(hasConvention(root)).toBe(false);

      expect(installConvention(root)).toBe(true);
      const text = readFileSync(file(), 'utf8');
      expect(text.startsWith(before)).toBe(true);
      expect(text).toContain('<!-- agentdeck:tests -->\n## Project test cases');
      expect(text).not.toContain('Тест-кейсы проекта');
      expect(text).not.toContain(marker === '<!-- agentdeck:tests -->' ? 'Правила:' : marker);
      expect(text).toContain('Мой хвост без заголовка.');
      expect(text.endsWith('## Раздел человека\n\nТекст.\n')).toBe(true);
      expect(hasConvention(root)).toBe(true);

      // Повтор ничего не меняет: блок уже нынешний.
      expect(installConvention(root)).toBe(false);
      expect(readFileSync(file(), 'utf8')).toBe(text);
    });
  }

  it('правка человека внутри нынешнего блока — не повод его заменять', () => {
    writeFileSync(file(), '# P\n');
    installConvention(root);
    const edited = `${readFileSync(file(), 'utf8')}- моё правило.\n`;
    writeFileSync(file(), edited);
    expect(hasConvention(root)).toBe(true);
    expect(installConvention(root)).toBe(false);
    expect(readFileSync(file(), 'utf8')).toBe(edited);
  });
});
