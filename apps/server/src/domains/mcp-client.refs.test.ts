import { describe, it, expect } from 'vitest';
import type { McpServer } from '@claude-control/contracts';
import { decodeStderr, expandEnvRefs, resolveServerRefs } from './mcp-client.ts';

/**
 * Аудит 2026-09-02. Ссылки `${VAR}` из записи сервера уезжали в транспорт
 * буквально: заголовок `Authorization: Bearer ${TOKEN}` честно получал 401, а
 * карточка объясняла это как «требуется OAuth». И stderr упавшего процесса на
 * русской Windows (CP866) превращался в знаки вопроса.
 */

function makeServer(partial: Partial<McpServer>): McpServer {
  return {
    id: 'fixture',
    name: 'fixture',
    transport: 'http',
    args: [],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
    ...partial,
  };
}

describe('expandEnvRefs', () => {
  it('подставляет значение, значение по умолчанию и собирает незаданные', () => {
    const missing = new Set<string>();
    const out = expandEnvRefs('${A}/${B:-fallback}/${C}/${D:-}', { A: 'a' }, missing);
    expect(out).toBe('a/fallback/${C}/');
    expect([...missing]).toEqual(['C']);
  });

  it('пустая строка в окружении — это значение, а не «не задано»', () => {
    const missing = new Set<string>();
    expect(expandEnvRefs('[${E}]', { E: '' }, missing)).toBe('[]');
    expect(missing.size).toBe(0);
  });

  it('текст без ссылок и «$» без фигурных скобок не трогаются', () => {
    const missing = new Set<string>();
    expect(expandEnvRefs('price $5 and $HOME', {}, missing)).toBe('price $5 and $HOME');
    expect(missing.size).toBe(0);
  });
});

describe('resolveServerRefs', () => {
  it('раскрывает ссылки в команде, аргументах, env, url и заголовках', () => {
    const server = makeServer({
      transport: 'stdio',
      command: '${NODE}',
      args: ['${SCRIPT}', 'plain'],
      env: { TOKEN: '${GITLAB_TOKEN}', KEEP: 'as-is' },
      url: '${BASE}/mcp',
      headers: { Authorization: 'Bearer ${GITLAB_TOKEN}' },
    });

    const resolved = resolveServerRefs(server, {
      NODE: 'node',
      SCRIPT: 'server.mjs',
      GITLAB_TOKEN: 'glpat-x',
      BASE: 'https://x.test',
    });

    expect(resolved.command).toBe('node');
    expect(resolved.args).toEqual(['server.mjs', 'plain']);
    expect(resolved.env).toEqual({ TOKEN: 'glpat-x', KEEP: 'as-is' });
    expect(resolved.url).toBe('https://x.test/mcp');
    expect(resolved.headers).toEqual({ Authorization: 'Bearer glpat-x' });
    // Исходная запись не изменена — она же уходит в ответ API и на карточку.
    expect(server.headers.Authorization).toBe('Bearer ${GITLAB_TOKEN}');
  });

  it('незаданные переменные называются все разом, с подсказкой, где их задать', () => {
    const server = makeServer({
      headers: { Authorization: 'Bearer ${T1}' },
      env: { X: '${T2}', Y: '${T1}' },
    });

    expect(() => resolveServerRefs(server, {})).toThrow(/\$\{T1\}, \$\{T2\}/);
    expect(() => resolveServerRefs(server, {})).toThrow(/Переменные/);
  });
});

describe('decodeStderr', () => {
  it('корректный UTF-8 читается как UTF-8 на любой платформе', () => {
    const raw = Buffer.from('Ошибка: нет модуля', 'utf8');
    expect(decodeStderr(raw, 'win32')).toBe('Ошибка: нет модуля');
    expect(decodeStderr(raw, 'linux')).toBe('Ошибка: нет модуля');
  });

  it('байты CP866 на Windows читаются как CP866, а не как знаки вопроса', () => {
    // «Ошибка» в CP866.
    const raw = Buffer.from([0x8e, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0]);
    expect(decodeStderr(raw, 'win32')).toBe('Ошибка');
    // Вне Windows кодовой страницы консоли нет — остаётся нестрогий UTF-8.
    expect(decodeStderr(raw, 'linux')).toContain('�');
  });
});
