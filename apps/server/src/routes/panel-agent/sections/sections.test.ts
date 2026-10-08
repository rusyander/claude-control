import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANEL_SECTIONS } from './sections.ts';

/**
 * Серверный список разделов обязан совпадать с роутером веба: `open_page`
 * проверяет путь по этому списку, и раздел, забытый здесь, агент открыть не
 * сможет, а лишний — откроет пустую страницу «не найдено».
 */
const ROUTER = resolve(import.meta.dirname, '../../../../../web/src/app/router/router.tsx');
const WEB = resolve(import.meta.dirname, '../../../../../web/src');

/** Ключи вкладок из исходника веба: `{ id: 'x'` у настроек, `const TABS = [...]` у тестов. */
function webTabs(file: string, pattern: RegExp): string[] {
  const text = readFileSync(resolve(WEB, file), 'utf8');
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '');
}

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

/**
 * «Открой настройки моделей» открывало общую вкладку: модель не знала, что у
 * раздела есть вкладки и что `focus` open_page — ключ вкладки. Ключи обязаны
 * совпадать с вебом, иначе `?tab=` откроет вкладку по умолчанию.
 */
describe('вкладки разделов ↔ веб', () => {
  const tabsOf = (route: string) => PANEL_SECTIONS.find((item) => item.route === route)?.tabs;

  it('настройки: те же ключи вкладок, что SETTINGS_TABS', () => {
    const web = webTabs('pages/Settings/model/tabs.constants.ts', /\{\s*id:\s*'([^']+)'/g);
    expect(web.length).toBeGreaterThan(5);
    expect(tabsOf('/settings')).toEqual(web);
  });

  it('тестирование: те же ключи вкладок, что TABS страницы', () => {
    const line = readFileSync(
      resolve(WEB, 'pages/Tests/TestsPage/TestsPage.constants.ts'),
      'utf8',
    ).match(/const TABS = \[([^\]]+)\]/);
    const web = [...(line?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(web.length).toBeGreaterThan(2);
    expect(tabsOf('/tests')).toEqual(web);
  });

  it('раздел со вкладками говорит модели, что focus — ключ вкладки', () => {
    for (const section of PANEL_SECTIONS.filter((item) => item.tabs)) {
      expect(section.description).toContain('focus');
    }
  });
});
