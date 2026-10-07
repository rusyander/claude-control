import { describe, expect, it } from 'vitest';
import { isCliImage, pickCliChild } from './run-ledger.ts';

/**
 * Агент тестов и агент панели ходят и чужими CLI. Их сирота после падения
 * панели обязана узнаваться уборкой на старте (`reapPanelAgentOrphans`), иначе
 * `qwen`/`codex` жили бы дальше без присмотра.
 */
describe('run-ledger: образы чужих CLI', () => {
  it.each(['codex.exe', 'codex', 'qwen', 'qwen.exe', 'CODEX.EXE', 'node.exe', 'claude.exe'])(
    '«%s» — процесс CLI',
    (name) => expect(isCliImage(name)).toBe(true),
  );

  it.each(['chrome.exe', 'git.exe', 'codex-helper.exe', 'conhost.exe', ''])(
    '«%s» — не CLI',
    (name) => expect(isCliImage(name)).toBe(false),
  );

  it('под обёрткой cmd в журнал идёт сам codex.exe, а не conhost', () => {
    expect(
      pickCliChild([
        { pid: 11, name: 'conhost.exe' },
        { pid: 12, name: 'codex.exe' },
      ]),
    ).toBe(12);
    expect(pickCliChild([{ pid: 21, name: 'qwen.exe' }])).toBe(21);
  });
});
