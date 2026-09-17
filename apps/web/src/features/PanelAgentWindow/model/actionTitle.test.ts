import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelAgentRu } from '@shared/config/i18n/panel-agent/ru';
import { panelAgentEn } from '@shared/config/i18n/panel-agent/en';
import { actionTitle } from './actionTitle';

/**
 * Имена действий читаются из исходников реестра сервера, а не из списка,
 * переписанного сюда руками: переписанный список отстал бы от реестра так же
 * молча, как словарь. Новое действие без названия делает тест красным.
 */
function registeredActionNames(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', '..', '..', '..', 'server', 'src', 'routes', 'panel-agent');
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!/^actions.*\.ts$/.test(file) || file.includes('.test.')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(/definePanelAction\(\{\s*name:\s*'([a-z_]+)'/g)) {
      if (match[1]) names.add(match[1]);
    }
    // Переключатели скиллов, MCP и прав собираются одной фабрикой — имя вторым аргументом.
    for (const match of source.matchAll(/toggleAction\(\s*'[a-z]+',\s*'([a-z_]+)'/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe('названия действий агента панели', () => {
  const names = registeredActionNames();

  it('реестр прочитан (скан не пустой)', () => {
    expect(names.length).toBeGreaterThan(25);
    expect(names).toContain('create_project');
    expect(names).toContain('toggle_skill');
  });

  it('у каждого действия реестра есть название на русском и английском', () => {
    const ru = panelAgentRu.actions as Record<string, string>;
    const en = panelAgentEn.actions as Record<string, string>;
    expect(names.filter((name) => !ru[name])).toEqual([]);
    expect(names.filter((name) => !en[name])).toEqual([]);
  });

  it('в словаре нет названий действий, которых нет в реестре', () => {
    expect(Object.keys(panelAgentRu.actions).filter((name) => !names.includes(name))).toEqual([]);
    expect(Object.keys(panelAgentEn.actions).filter((name) => !names.includes(name))).toEqual([]);
  });

  it('неизвестное действие показывается своим именем', () => {
    const dict: Record<string, string> = { 'panelAgent.actions.save_rule': 'Сохранить правило' };
    const t = (key: string) => dict[key] ?? key;
    const exists = (key: string) => key in dict;
    expect(actionTitle('save_rule', t, exists)).toBe('Сохранить правило');
    expect(actionTitle('brand_new', t, exists)).toBe('brand_new');
  });
});
