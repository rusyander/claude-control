import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANEL_ACTIONS } from './actions.ts';
import { PANEL_SECTIONS } from './sections.ts';

/**
 * Строгая сверка реестра действий агента в обе стороны:
 * - каждое действие с записью (change/danger) показывает карточку И снимает
 *   отпечаток — без отпечатка правка между показом и кликом прошла бы молча;
 * - у каждого раздела панели есть хотя бы одно действие, и каждое действие
 *   принадлежит разделу панели (или навигации);
 * - каждое действие хоть раз вызывается интеграционным тестом через маршрут.
 */

/** Раздел окна → разделы действий. Настройки собирают несколько разделов действий. */
const ROUTE_SECTIONS: Record<string, readonly string[]> = {
  '/': ['overview'],
  '/search': ['search'],
  '/groups': ['groups'],
  '/history': ['history'],
  '/settings': ['settings', 'provider', 'endpoints', 'integrations'],
  '/dlp': ['dlp'],
  '/platform': ['contour'],
  '/compare': ['compare'],
  '/help': ['help'],
  '/analytics': ['analytics'],
  '/chat': ['chat'],
  '/rules': ['rules'],
  '/claude-md': ['claude-md'],
  '/hooks': ['hooks'],
  '/skills': ['skills'],
  '/commands': ['commands'],
  '/scripts': ['scripts'],
  '/plugins': ['plugins'],
  '/mcp': ['mcp'],
  '/permissions': ['permissions'],
  '/env': ['env'],
  '/projects': ['projects'],
  '/tests': ['tests'],
};

/** Разделы действий без своей страницы. */
const PAGELESS = ['navigation'];

describe('реестр действий агента: строгая сверка', () => {
  it('имена уникальны', () => {
    const names = PANEL_ACTIONS.map((action) => action.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('каждое действие с записью — с карточкой, отпечатком и заголовком следа', () => {
    const problems = PANEL_ACTIONS.filter((action) => action.risk !== 'read').flatMap((action) => [
      ...(action.preview ? [] : [`${action.name}: нет preview`]),
      ...(action.fingerprint ? [] : [`${action.name}: нет fingerprint`]),
      ...(action.title ? [] : [`${action.name}: нет title`]),
      ...(action.route || action.local ? [] : [`${action.name}: нечем исполнить`]),
    ]);
    expect(problems).toEqual([]);
  });

  it('каждое чтение — со сводкой следа и без карточки', () => {
    const problems = PANEL_ACTIONS.filter((action) => action.risk === 'read').flatMap((action) => [
      ...(action.summary || action.local ? [] : [`${action.name}: нет summary`]),
      ...(action.preview ? [`${action.name}: чтение с карточкой`] : []),
    ]);
    expect(problems).toEqual([]);
  });

  it('разделы окна ↔ разделы действий — в обе стороны', () => {
    // Карта сверки покрывает ровно разделы окна.
    expect(Object.keys(ROUTE_SECTIONS).sort()).toEqual(
      PANEL_SECTIONS.map((section) => section.route).sort(),
    );
    const actionSections = new Set(PANEL_ACTIONS.map((action) => action.section));
    const withoutActions = Object.entries(ROUTE_SECTIONS).flatMap(([route, keys]) =>
      keys.filter((key) => !actionSections.has(key)).map((key) => `${route} → ${key}`),
    );
    expect(withoutActions).toEqual([]);
    const allowed = new Set([...Object.values(ROUTE_SECTIONS).flat(), ...PAGELESS]);
    const orphan = [...actionSections].filter((section) => !allowed.has(section));
    expect(orphan).toEqual([]);
  });

  it('каждое действие вызывается интеграционным тестом через маршрут', () => {
    const dir = import.meta.dirname;
    const tests = readdirSync(dir)
      .filter((file) => file.endsWith('.integration.test.ts'))
      .map((file) => readFileSync(resolve(dir, file), 'utf8'))
      .join('\n');
    const untested = PANEL_ACTIONS.map((action) => action.name).filter(
      // Вызов действия тестом или настоящий инструмент MCP в потоке фальшивого CLI.
      (name) => !new RegExp(`(call|decided)\\(\\s*'${name}'|__${name}'`).test(tests),
    );
    expect(untested).toEqual([]);
  });
});
