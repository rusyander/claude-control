import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../../shared/config/i18n/en';
import { ru } from '../../shared/config/i18n/ru';
import { agentTextView, svgRatio } from './agentTextView';

const svg =
  '<svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

describe('agentTextView — рисунок агента на телефоне', () => {
  it('блок agentdeck:svg становится карточкой и уходит из текста', () => {
    const text = `Вот схема:\n\n\`\`\`agentdeck:svg\n${svg}\n\`\`\`\n\nГотово.`;
    const view = agentTextView(text, ru.chat);
    expect(view.pictures).toEqual([{ svg, ratio: 2 }]);
    expect(view.markdown).toBe('Вот схема:\n\nГотово.');
    expect(view.markdown).not.toContain('<svg');
    expect(view.notes).toEqual([]);
  });

  it('опасный рисунок не становится карточкой, и телефон говорит, что панель его не приняла', () => {
    const bad = '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>';
    const view = agentTextView(`\`\`\`agentdeck:svg\n${bad}\n\`\`\``, en.chat);
    expect(view.pictures).toEqual([]);
    expect(view.markdown).toContain('<script>');
    expect(view.notes).toEqual([en.chat.blocksRejected(1)]);
  });

  it('пока ответ печатается, недописанный блок спрятан вместе с хвостом', () => {
    const view = agentTextView('Рисую:\n```agentdeck:svg\n<svg viewBox="0 0', ru.chat, {
      streaming: true,
    });
    expect(view.markdown).toBe('Рисую:');
    expect(view.notes).toEqual([]);
  });

  it('колода — строкой, решение в панели', () => {
    const deck = JSON.stringify({ title: 'Итоги', slides: [{ title: 'Один', bullets: ['a'] }] });
    const view = agentTextView(`\`\`\`agentdeck:deck\n${deck}\n\`\`\``, ru.chat);
    expect(view.notes).toEqual([ru.chat.offerDeck]);
    expect(view.markdown).toBe('');
  });

  it('пропорция — из viewBox, затем из width/height, иначе квадрат', () => {
    expect(svgRatio('<svg viewBox="0,0,300,100"></svg>')).toBe(3);
    expect(svgRatio('<svg width="200" height="400"></svg>')).toBe(0.5);
    expect(svgRatio('<svg></svg>')).toBe(1);
  });
});

/**
 * Metro грузит `media-block` прямо из исходника контрактов, а zod у телефона нет:
 * один импорт пакета по дороге — и бандл не собирается, хотя vitest (он находит
 * zod у пакета контрактов) зелёный. Поэтому граф проверяется по тексту.
 */
describe('media-block грузится без чужих пакетов', () => {
  it('ни один модуль, достижимый из media-block.ts, не ввозит пакет значением', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = resolve(here, '../../../../../packages/contracts/src/media-block.ts');
    const statement = /^(?:import|export)\s+(?!type[\s{])([^;]*?)\s*from\s+'([^']+)';/gm;
    const seen = new Set<string>();
    const queue = [entry];
    const bare: string[] = [];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(statement)) {
        const specifier = match[2] as string;
        if (!specifier.startsWith('.')) bare.push(`${file} → ${specifier}`);
        else queue.push(resolve(dirname(file), specifier));
      }
    }
    expect(seen.size).toBeGreaterThan(4);
    expect(bare).toEqual([]);
  });
});
