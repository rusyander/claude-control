import { describe, expect, it } from 'vitest';
import { defaultQwenSystemSettingsPath, needsQwenLayer, qwenMcpEntry } from './qwen-layer.ts';

/**
 * Общие части слоя Qwen. Сам слой групп на прогон проверяет
 * `qwen-run-layer.test.ts`; здесь — перевод записи MCP и выбор групп.
 */

describe('qwenMcpEntry / needsQwenLayer', () => {
  it('stdio — команда, аргументы и env; тип выводится из command', () => {
    expect(qwenMcpEntry({ command: 'srv', args: ['-x'], env: { K: 'v' } })).toEqual({
      command: 'srv',
      args: ['-x'],
      env: { K: 'v' },
    });
  });

  it('HTTP — httpUrl с заголовками, SSE — url, неизвестная форма — отказ', () => {
    expect(qwenMcpEntry({ type: 'http', url: 'https://h', headers: { A: '1' } })).toEqual({
      httpUrl: 'https://h',
      headers: { A: '1' },
    });
    expect(qwenMcpEntry({ type: 'sse', url: 'https://s' })).toEqual({ url: 'https://s' });
    expect(qwenMcpEntry({ type: 'ws', url: 'wss://x' })).toBeUndefined();
    expect(qwenMcpEntry(['not', 'an', 'entry'])).toBeUndefined();
  });

  it('системные настройки по умолчанию — как у самого CLI на каждой ОС', () => {
    expect(defaultQwenSystemSettingsPath('win32')).toBe(
      'C:\\ProgramData\\qwen-code\\settings.json',
    );
    expect(defaultQwenSystemSettingsPath('linux')).toBe('/etc/qwen-code/settings.json');
  });

  it('слоем едет только группа из файлов Claude', () => {
    expect(needsQwenLayer({ scope: { kind: 'global' } })).toBe(true);
    expect(needsQwenLayer({ scope: { kind: 'global', provider: 'qwen' } })).toBe(false);
    expect(needsQwenLayer({ scope: { kind: 'project', path: '/p', provider: 'qwen' } })).toBe(
      false,
    );
  });
});
