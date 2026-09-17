import { describe, expect, it } from 'vitest';
import {
  PANEL_PLATFORMS_VERSION,
  panelPlatformsFile,
  planPanelPlatforms,
  takePanelPlatforms,
  type PanelPlatformsDocument,
} from './platforms.ts';

/**
 * Секция контуров в архиве переноса. Проверяется РАЗБОР чужого архива: это
 * единственное место, где настройка контура приезжает извне и где потерять
 * поле не стоит ничего.
 */

/** Байты секции так, как их кладёт архив, но с сырой записью контура. */
function archive(platforms: unknown[]): Buffer {
  const document = {
    version: PANEL_PLATFORMS_VERSION,
    gateway: { enabled: true, port: 5199, forceStream: false },
    platforms,
  } as unknown as PanelPlatformsDocument;
  return panelPlatformsFile(document);
}

/** Контур из архива прежней машины: обязательные поля схемы и ничего лишнего. */
function legacyEntry(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'enterprise-platform',
    title: 'Контур',
    driver: 'enterprise-platform',
    baseUrl: 'https://contour.example',
    enabled: true,
    mode: 'best-effort',
    budgetUsd: 0,
    budgetSince: '',
    capabilities: ['models', 'chat'],
    targets: [],
    projectPaths: [],
    agents: [],
    toolShim: true,
    contourPrompt: true,
    caCertPath: '',
    ...extra,
  };
}

describe('секция контуров в архиве переноса', () => {
  it('архив без поля потребителей отдаёт прежнее поведение контура, а не пустоту', () => {
    // Архив собран ДО Т3: поля `consumers` в нём нет вовсе, а цели применения
    // есть. Схема подставила бы пустой список — «никуда не подключён», и
    // перенесённый контур молча перестал бы работать у ассистента.
    const taken = takePanelPlatforms(archive([legacyEntry({ targets: ['assistant', 'claude'] })]), [
      'enterprise-platform',
    ]);

    expect(taken).toHaveLength(1);
    expect(taken[0]?.consumers).toEqual(['assistant', 'terminal']);
  });

  it('архив без целей применения не выдумывает потребителей', () => {
    const taken = takePanelPlatforms(archive([legacyEntry({ targets: [] })]), [
      'enterprise-platform',
    ]);

    expect(taken[0]?.consumers).toEqual([]);
  });

  it('пустой список в архиве остаётся пустым: это осознанное «никуда не подключён»', () => {
    // Человек снял все галочки и перенёс окружение. Подстановка прежнего
    // поведения тут была бы возвратом того, что он только что выключил.
    const taken = takePanelPlatforms(
      archive([legacyEntry({ targets: ['assistant'], consumers: [] })]),
      ['enterprise-platform'],
    );

    expect(taken[0]?.consumers).toEqual([]);
  });

  it('выбранный список переносится как есть', () => {
    const taken = takePanelPlatforms(
      archive([legacyEntry({ targets: ['assistant'], consumers: ['chat', 'tests'] })]),
      ['enterprise-platform'],
    );

    expect(taken[0]?.consumers).toEqual(['chat', 'tests']);
  });

  it('противоречие правил из чужого архива названо ДО разворота', () => {
    // Единственная дорога в состояние «включены оба набора инструментов» — этот
    // самый разворот: дверь сохранения его отклоняет. Промолчав здесь, панель
    // отдала бы человеку контур, который отвечает 400 на первую же правку,
    // которую он не делал (ревью Т7, M5).
    const plan = planPanelPlatforms({
      data: archive([
        legacyEntry({ toolShim: true, rules: { platform: { platformTools: ['web_search'] } } }),
      ]),
      current: [],
      hasToken: () => false,
      fileExists: () => true,
    });

    expect(plan.entries[0]?.notes.some((note) => note.includes('сохранение'))).toBe(true);
  });

  it('контур без противоречия лишней заметки не получает', () => {
    const plan = planPanelPlatforms({
      data: archive([legacyEntry({ toolShim: true })]),
      current: [],
      hasToken: () => false,
      fileExists: () => true,
    });

    expect(plan.entries[0]?.notes.some((note) => note.includes('сохранение'))).toBe(false);
  });
});
