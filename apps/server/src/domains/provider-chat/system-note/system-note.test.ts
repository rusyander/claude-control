import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  qwenLimitLayersRoot,
  qwenNoteLayersRoot,
  writeQwenLimits,
  writeQwenSystemNote,
} from './system-note.ts';

/**
 * Слой строки о каталоге для Qwen: `QWEN.md` со строкой и файл системных
 * настроек ПОВЕРХ уже выбранного. Что Qwen кладёт такой `QWEN.md` в системный
 * промпт, доказано живьём на qwen 0.25 заглушкой модели (11.10); здесь —
 * то, что принадлежит панели: состав слоя и сохранность основы.
 */
describe('writeQwenSystemNote', () => {
  let appData: string;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-qwen-note-'));
  });

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const settingsOf = (env: Record<string, string> | undefined): Record<string, unknown> =>
    JSON.parse(readFileSync(env?.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '', 'utf8')) as Record<
      string,
      unknown
    >;

  it('строка — в QWEN.md каталога слоя, каталог — в контексте поверх основы', () => {
    // Основа — слой группы: его MCP и уже подключённый каталог правил не теряются.
    const group = join(appData, 'group.json');
    writeFileSync(
      group,
      JSON.stringify({
        mcpServers: { a: { command: 'a' } },
        context: { includeDirectories: ['/group-rules'], fileName: 'QWEN.md' },
      }),
    );
    const env = writeQwenSystemNote({
      appData,
      note: '  QA workspace: e2e  ',
      env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: group },
    });

    const dir = dirname(env?.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '');
    expect(dirname(dir)).toBe(qwenNoteLayersRoot(appData));
    expect(readFileSync(join(dir, 'QWEN.md'), 'utf8')).toBe(
      '<agentdeck-workspace>QA workspace: e2e</agentdeck-workspace>\n',
    );
    expect(settingsOf(env)).toEqual({
      mcpServers: { a: { command: 'a' } },
      context: {
        includeDirectories: ['/group-rules', dir],
        fileName: 'QWEN.md',
        loadFromIncludeDirectories: true,
      },
    });
  });

  it('та же строка на той же основе — тот же каталог; другая — свой', () => {
    const base = join(appData, 'none.json');
    const first = writeQwenSystemNote({
      appData,
      note: 'A',
      env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: base },
    });
    const again = writeQwenSystemNote({
      appData,
      note: 'A',
      env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: base },
    });
    const other = writeQwenSystemNote({
      appData,
      note: 'B',
      env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: base },
    });
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
    // Основы нет на диске — слой стоит на пустых настройках.
    expect(settingsOf(first)).toEqual({
      context: {
        includeDirectories: [dirname(first?.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '')],
        loadFromIncludeDirectories: true,
      },
    });
  });

  it('пустая строка — слоя нет', () => {
    expect(writeQwenSystemNote({ appData, note: '  ', env: {} })).toBeUndefined();
    expect(existsSync(qwenNoteLayersRoot(appData))).toBe(false);
  });
});

/**
 * Окно и сроки локальной модели для Qwen Code (L4b). Имена полей `model.generationConfig`
 * (`contextWindowSize`, `timeout`, `streamIdleTimeoutMs`) — из схемы настроек бандла 0.25.0;
 * живым прогоном с моделью не проверено (Qwen Code не установлен на этой машине).
 */
describe('writeQwenLimits', () => {
  let appData: string;
  const limits = { contextWindow: 65_536, timeoutMs: 600_000, idleMs: 300_000 };

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-qwen-limits-'));
  });

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const read = (env: Record<string, string>): Record<string, unknown> =>
    JSON.parse(readFileSync(env.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '', 'utf8')) as Record<
      string,
      unknown
    >;

  it('окно и сроки — в model.generationConfig слоя, а не в окружении', () => {
    const env = writeQwenLimits({ appData, limits, env: {} });
    expect(dirname(dirname(env.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? ''))).toBe(
      qwenLimitLayersRoot(appData),
    );
    expect(read(env).model).toEqual({
      generationConfig: {
        contextWindowSize: 65_536,
        timeout: 600_000,
        streamIdleTimeoutMs: 300_000,
      },
    });
  });

  it('основа не теряется: группы, MCP и чужие поля generationConfig остаются', () => {
    const group = join(appData, 'group.json');
    writeFileSync(
      group,
      JSON.stringify({
        mcpServers: { a: { command: 'a' } },
        model: { name: 'x', generationConfig: { maxRetries: 7, contextWindowSize: 1 } },
      }),
    );
    const env = writeQwenLimits({
      appData,
      limits,
      env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: group },
    });
    const merged = read(env);
    expect(merged.mcpServers).toEqual({ a: { command: 'a' } });
    expect(merged.model).toEqual({
      name: 'x',
      generationConfig: {
        maxRetries: 7,
        contextWindowSize: 65_536,
        timeout: 600_000,
        streamIdleTimeoutMs: 300_000,
      },
    });
  });

  it('слой строки о каталоге ложится ПОВЕРХ слоя окна и не теряет его', () => {
    const window = writeQwenLimits({ appData, limits, env: {} });
    const note = writeQwenSystemNote({ appData, note: 'QA', env: window });
    expect(read(note ?? {}).model).toEqual(read(window).model);
  });

  it('те же числа — тот же каталог: два разговора не переписывают файл друг друга', () => {
    const first = writeQwenLimits({ appData, limits, env: {} });
    const second = writeQwenLimits({ appData, limits, env: {} });
    expect(second).toEqual(first);
    const other = writeQwenLimits({
      appData,
      limits: { ...limits, contextWindow: 131_072 },
      env: {},
    });
    expect(other).not.toEqual(first);
  });
});
