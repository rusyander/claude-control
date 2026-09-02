import { describe, it, expect } from 'vitest';
import { parseServers } from './McpJsonImport.lib';

/**
 * Аудит 2026-09-02: адрес без type импорт считал sse, а сервер панели ту же
 * запись из файла читает как http (`readTransport` в domains/mcp.ts) — и так же
 * её понимает Claude Code. Предпросмотр показывал не тот транспорт, что
 * получился бы у записи, положенной в файл руками.
 */
describe('parseServers — транспорт', () => {
  it('адрес без type — http, как у сервера панели', () => {
    const { drafts } = parseServers(
      JSON.stringify({ mcpServers: { remote: { url: 'https://x.test/mcp' } } }),
    );
    expect(drafts[0]?.transport).toBe('http');
  });

  it('type или transport = sse уточняют sse; команда без адреса — stdio', () => {
    const { drafts } = parseServers(
      JSON.stringify({
        a: { url: 'https://x.test/sse', type: 'sse' },
        b: { url: 'https://x.test/sse', transport: 'sse' },
        c: { command: 'npx', args: ['-y', 'pkg'] },
      }),
    );
    expect(drafts.map((d) => [d.name, d.transport])).toEqual([
      ['a', 'sse'],
      ['b', 'sse'],
      ['c', 'stdio'],
    ]);
    expect(drafts[2]?.args).toEqual(['-y', 'pkg']);
  });

  it('пустой ввод и не-JSON различаются', () => {
    expect(parseServers('   ')).toEqual({ drafts: [] });
    expect(parseServers('{oops').error).toMatch(/JSON/);
    expect(parseServers('{"mcpServers": {}}').error).toMatch(/ни одного/);
  });
});
