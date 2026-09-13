import { describe, it, expect } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import type { OurRules, Platform } from '@agentdeck/contracts';
import { layerOn, runLayers } from './layers.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Наши слои в прогоне через контур (Т8).
 *
 * Проверяется не «функция вернула массив», а то, чем этот массив становится в
 * запуске: КАКОЙ флаг стоит за каждой галочкой. Что эти флаги делают с настоящим
 * CLI, доказывает не таблица, а живая проба — `tools/qa/check-run-layers.mjs`
 * (настоящий `claude` против стаба, метки слоёв ищутся в теле запроса наверх):
 * таблица проверяет НАШУ половину — что панель просит ровно то, о чём написано
 * на карточке.
 */

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  budgetSince: '',
  capabilities: [],
  targets: [],
  consumers: ['chat'],
  projectPaths: [],
  agents: [],
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const withOurs = (patch: Partial<OurRules>): Platform => ({
  ...PLATFORM,
  rules: { platform: defaultPlatformRules(), ours: { ...defaultOurRules(), ...patch } },
});

describe('наши слои в прогоне через контур', () => {
  it('умолчание — всё наше едет, флагов нет вовсе', () => {
    const layers = runLayers(PLATFORM);
    expect(layers.args).toEqual([]);
    expect(layers.dropped).toEqual([]);
    expect(layers.systemPrompt).toBe(true);
  });

  it('снятые личные настройки уносят правила, хуки и права одним флагом — проектные остаются', () => {
    const layers = runLayers(withOurs({ settings: false }));
    // Именно `project,local`: пустой список источников унёс бы и правила самой
    // задачи, а человеку на карточке обещано, что проектный CLAUDE.md остаётся.
    expect(layers.args).toEqual(['--setting-sources', 'project,local']);
    expect(layers.dropped).toEqual(['settings']);
  });

  it('скиллы и MCP снимаются своими флагами, не трогая остального', () => {
    expect(runLayers(withOurs({ skills: false })).args).toEqual(['--disable-slash-commands']);
    expect(runLayers(withOurs({ mcp: false })).args).toEqual(['--strict-mcp-config']);
  });

  it('снятая дописка панели не даёт флага: её снимает реестр прогонов, а не CLI', () => {
    const layers = runLayers(withOurs({ systemPrompt: false }));
    expect(layers.args).toEqual([]);
    expect(layers.systemPrompt).toBe(false);
    expect(layers.dropped).toEqual(['systemPrompt']);
  });

  it('общий выключатель снимает всё, что бы ни стояло в частных галочках', () => {
    const layers = runLayers(withOurs({ enabled: false }));
    expect(layers.args).toEqual([
      '--setting-sources',
      'project,local',
      '--disable-slash-commands',
      '--strict-mcp-config',
    ]);
    expect(layers.dropped).toEqual(['settings', 'skills', 'mcp', 'systemPrompt']);
    expect(layers.systemPrompt).toBe(false);
  });

  it('частная галочка не переспоривает общий выключатель', () => {
    expect(layerOn({ ...defaultOurRules(), enabled: false }, 'settings')).toBe(false);
    expect(layerOn({ ...defaultOurRules(), settings: false }, 'skills')).toBe(true);
  });
});
