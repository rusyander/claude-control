import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  findSettingsTab,
  settingsPanelDomId,
  settingsTabDomId,
} from './tabs';

/**
 * Вкладка из адреса `/settings?tab=…`: ссылкой на раздел делятся, и она обязана
 * пережить и перезагрузку, и переименование вкладки — устаревший адрес открывает
 * первый раздел, а не пустой экран.
 */
describe('вкладки настроек', () => {
  it('идентификаторы уникальны: адрес обязан вести ровно в одно место', () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('знакомый раздел находится, незнакомый и пустой открывают первый', () => {
    expect(findSettingsTab('prompts')).toBe('prompts');
    expect(findSettingsTab('такой-вкладки-нет')).toBe(DEFAULT_SETTINGS_TAB);
    expect(findSettingsTab(undefined)).toBe(DEFAULT_SETTINGS_TAB);
  });

  it('кнопка и панель ссылаются друг на друга разными именами', () => {
    expect(settingsTabDomId('access')).toBe('settings-tab-access');
    expect(settingsPanelDomId('access')).toBe('settings-panel-access');
    expect(settingsTabDomId('access')).not.toBe(settingsPanelDomId('access'));
  });
});
