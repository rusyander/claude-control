import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { qwenNoteLayersRoot, writeQwenSystemNote } from './system-note.ts';

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
