import { describe, it, expect } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import type { OurRules, Platform } from '@agentdeck/contracts';
import { LEAN_TOOLS, layerOn, runLayers } from './layers.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Наши слои в прогоне через контур (Т8).
 *
 * Проверяется не «функция вернула массив», а то, чем этот массив становится в
 * запуске: КАКОЙ флаг стоит за каждой галочкой. Что эти флаги делают с настоящим
 * CLI, доказывает не таблица, а живая проба ядра — флаги панель переводит в поля
 * сеанса (`session-carry.test.ts`), поля на настоящем `claude` против стаба проверяют
 * `apps/core/src/adapters/claude/claude.carry.live.integration.test.ts` и
 * `claude.mcp.live.integration.test.ts` (метки слоёв ищутся в теле запроса наверх):
 * таблица проверяет НАШУ половину — что панель просит ровно то, о чём написано
 * на карточке.
 */

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
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

  it('облегчённый набор инструментов: белый список рабочих, не зависит от общего выключателя', () => {
    const lean = runLayers(withOurs({ tools: false }));
    expect(lean.args).toEqual(['--tools', LEAN_TOOLS.join(',')]);
    expect(lean.dropped).toEqual(['tools']);
    // Рабочие руки на месте; расписания, воркфлоу и рассылки в список не входят.
    for (const name of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) {
      expect(LEAN_TOOLS).toContain(name);
    }
    for (const name of ['CronCreate', 'Workflow', 'SendMessage', 'ScheduleWakeup']) {
      expect(LEAN_TOOLS).not.toContain(name);
    }
    // Общий выключатель слой инструментов не трогает: он не из `~/.claude`.
    expect(runLayers(withOurs({ enabled: false })).args).not.toContain('--tools');
    expect(layerOn({ ...defaultOurRules(), enabled: false }, 'tools')).toBe(true);
    // Запись, сохранённая до появления слоя, — полный набор.
    const older = { ...defaultOurRules() } as Partial<OurRules>;
    delete older.tools;
    expect(layerOn(older as OurRules, 'tools')).toBe(true);
  });

  it('частная галочка не переспоривает общий выключатель', () => {
    expect(layerOn({ ...defaultOurRules(), enabled: false }, 'settings')).toBe(false);
    expect(layerOn({ ...defaultOurRules(), settings: false }, 'skills')).toBe(true);
  });
});
