import { describe, it, expect } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import type { OurRules, Platform } from '@agentdeck/contracts';
import { layerOn, lightWindowLayers, runLayers, userMemorySettings } from './layers.ts';
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

  it('лёгкое окно агента панели: всё снято, и проектный источник тоже', () => {
    const layers = lightWindowLayers();
    // Тот же набор, что у общего выключателя, кроме `project`: иначе
    // `~/.claude/CLAUDE.md` доезжает поиском вверх (check-run-layers, случай 7).
    expect(layers.args).toEqual([
      '--setting-sources',
      'local',
      '--disable-slash-commands',
      '--strict-mcp-config',
    ]);
    expect(layers.dropped).toEqual(runLayers(withOurs({ enabled: false })).dropped);
  });

  it('частная галочка не переспоривает общий выключатель', () => {
    expect(layerOn({ ...defaultOurRules(), enabled: false }, 'settings')).toBe(false);
    expect(layerOn({ ...defaultOurRules(), settings: false }, 'skills')).toBe(true);
  });
});

/**
 * Личный `CLAUDE.md`, прочитанный CLI как проектный (проект под домом). Что
 * исключение действительно срабатывает в настоящем CLI, доказывает
 * `check-run-layers.mjs`, случай 8; здесь — что панель просит ровно нужные файлы.
 */
describe('исключение личного CLAUDE.md при снятых настройках', () => {
  const excludes = (args: readonly string[], place: Parameters<typeof userMemorySettings>[1]) => {
    const text = userMemorySettings(args, place);
    return text === undefined
      ? undefined
      : (JSON.parse(text) as { claudeMdExcludes: string[] }).claudeMdExcludes;
  };
  const settingsOff = runLayers(withOurs({ settings: false })).args;

  it('слой настроек на месте или проекта нет вовсе — исключать нечего', () => {
    const place = {
      cwd: '/home/u/work/app',
      env: {},
      platform: 'linux' as const,
      fallbackHome: '/home/u',
    };
    expect(userMemorySettings(runLayers(PLATFORM).args, place)).toBeUndefined();
    expect(userMemorySettings(runLayers(withOurs({ skills: false })).args, place)).toBeUndefined();
    // Лёгкое окно агента панели снимает `project` целиком — то же правило, ответ «нечего».
    expect(userMemorySettings(lightWindowLayers().args, place)).toBeUndefined();
  });

  it('linux: дом и каталог конфигурации, CLAUDE.md монорепозитория не задет', () => {
    const list = excludes(settingsOff, {
      cwd: '/home/u/mono/app',
      env: { HOME: '/home/u' },
      platform: 'linux',
      fallbackHome: '/root',
    });
    expect(list).toEqual(['/home/u/.claude/CLAUDE.md']);
    expect(list?.some((file) => file.startsWith('/home/u/mono'))).toBe(false);
  });

  it('свой CLAUDE_CONFIG_DIR и предок, который и есть этот каталог', () => {
    const list = excludes(settingsOff, {
      cwd: '/cfg/sandbox/app',
      env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' },
      platform: 'linux',
      fallbackHome: '/root',
    });
    expect(list).toEqual(['/cfg/CLAUDE.md', '/home/u/.claude/CLAUDE.md']);
  });

  it('windows: написание рабочего каталога, прямые слэши и шаблон без учёта регистра', () => {
    const list = excludes(settingsOff, {
      cwd: 'c:\\users\\ivan (work)\\mono\\app',
      env: { USERPROFILE: 'C:\\Users\\Ivan (Work)', HOME: '/ignored' },
      platform: 'win32',
      fallbackHome: 'C:\\Users\\other',
    });
    expect(list).toEqual([
      'C:/Users/Ivan (Work)/.claude/CLAUDE.md',
      'c:/users/ivan (work)/.claude/CLAUDE.md',
      '[cC]:/[uU][sS][eE][rR][sS]/[iI][vV][aA][nN] [(][wW][oO][rR][kK][)]/.[cC][lL][aA][uU][dD][eE]/[cC][lL][aA][uU][dD][eE].[mM][dD]',
    ]);
  });

  it('windows: путь с `[` остаётся только буквальным — класс сломал бы шаблон', () => {
    const list = excludes(settingsOff, {
      cwd: 'D:\\p[1]\\app',
      env: { USERPROFILE: 'D:\\p[1]' },
      platform: 'win32',
      fallbackHome: 'C:\\Users\\other',
    });
    expect(list).toEqual(['D:/p[1]/.claude/CLAUDE.md']);
  });
});
