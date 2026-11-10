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

/**
 * Пути страниц роутера. Адрес без `component` (только `beforeLoad`, перевод на другой раздел,
 * как старый `/core/chat` → `/chat`) — не раздел: агенту открывать там нечего.
 */
function routerPaths(): string[] {
  const text = readFileSync(ROUTER, 'utf8');
  return [...text.matchAll(/\{\s*path:\s*'([^']+)'([^\n]*)/g)]
    .filter((match) => !/^\s*,\s*beforeLoad:[^}]*\}/.test(match[2] ?? ''))
    .map((match) => match[1] ?? '');
}

/**
 * Адреса-переадресации, которые агенту всё же даны: веб переводит их сам (`pageNavigation.ts`),
 * и без них модель не открыла бы то, куда они ведут. `/groups` — полосы групп доски ядра
 * (этап 12, D13): `z.enum` путей не пускает в `open_page` адрес с ключами `/core?lane=group`.
 */
const AGENT_ALIASES = ['/groups'];

describe('PANEL_SECTIONS ↔ router.tsx', () => {
  it('каждый адрес-ярлык агента веб переводит сам, а роутер держит его переадресацией', () => {
    const navigation = readFileSync(
      resolve(WEB, 'entities/PanelAgent/model/pageNavigation.ts'),
      'utf8',
    );
    const router = readFileSync(ROUTER, 'utf8');
    for (const alias of AGENT_ALIASES) {
      expect(navigation).toContain(`path === '${alias}'`);
      expect(router).toMatch(new RegExp(`path: '${alias}', beforeLoad:`));
    }
  });

  it('роутер разобран (проверка не пустая)', () => {
    expect(routerPaths().length).toBeGreaterThan(10);
  });

  it('каждый путь роутера есть в списке разделов, и лишних нет', () => {
    const server = PANEL_SECTIONS.map((section) => section.route).sort();
    expect(server).toEqual([...routerPaths(), ...AGENT_ALIASES].sort());
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

  it('«Группы» — полосы групп доски ядра, а не прежняя страница групп (этап 12, D13)', () => {
    const groups = PANEL_SECTIONS.find((item) => item.route === '/groups')?.description ?? '';
    expect(groups).toContain('/core?view=board&lane=group');
    expect(groups).not.toContain('toggled together');
    const core = PANEL_SECTIONS.find((item) => item.route === '/core')?.description ?? '';
    expect(core).toContain('board');
  });

  it('раздел со вкладками говорит модели, что focus — ключ вкладки', () => {
    for (const section of PANEL_SECTIONS.filter((item) => item.tabs)) {
      expect(section.description).toContain('focus');
    }
  });
});
