import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANEL_SECTIONS } from './sections.ts';

/**
 * Серверный список разделов обязан совпадать с роутером веба: `open_page`
 * проверяет путь по этому списку, и раздел, забытый здесь, агент открыть не
 * сможет, а лишний — откроет пустую страницу «не найдено».
 */
const ROUTER = resolve(import.meta.dirname, '../../../../web/src/app/router/router.tsx');

function routerPaths(): string[] {
  const text = readFileSync(ROUTER, 'utf8');
  return [...text.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('PANEL_SECTIONS ↔ router.tsx', () => {
  it('роутер разобран (проверка не пустая)', () => {
    expect(routerPaths().length).toBeGreaterThan(10);
  });

  it('каждый путь роутера есть в списке разделов, и лишних нет', () => {
    const server = PANEL_SECTIONS.map((section) => section.route).sort();
    expect(server).toEqual([...routerPaths()].sort());
  });

  it('у каждого раздела есть название и описание', () => {
    for (const section of PANEL_SECTIONS) {
      expect(section.title.trim()).not.toBe('');
      expect(section.description.trim()).not.toBe('');
    }
  });
});
