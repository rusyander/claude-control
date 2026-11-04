import { describe, expect, it } from 'vitest';
import { autostartArgs, createCoreAutostart, type AutostartRun } from './autostart.ts';

/** Раннер команды ядра: отвечает кодом по действию, записывает argv. */
function runner(codes: Partial<Record<string, number | null>>) {
  const calls: string[][] = [];
  const run = async (args: readonly string[]): Promise<AutostartRun> => {
    calls.push([...args]);
    const action = args[1] ?? '';
    return { code: action in codes ? (codes[action] ?? null) : 0, out: `${action} out` };
  };
  return { calls, run };
}

describe('core autostart toggle (stage 10, P57) — panel over `keepalive install|remove|status`', () => {
  it('argv: action and home; the name only when given (a stand never touches the default entry)', () => {
    expect(autostartArgs('status', '/h')).toEqual(['keepalive', 'status', '--home', '/h']);
    expect(autostartArgs('install', '/h', 'qa-1')).toEqual([
      'keepalive',
      'install',
      '--home',
      '/h',
      '--name',
      'qa-1',
    ]);
  });

  it('status exit code maps 0 → on, 1 → off, anything else → unsupported', async () => {
    for (const [code, state] of [
      [0, 'on'],
      [1, 'off'],
      [2, 'unsupported'],
      [null, 'unsupported'],
    ] as const) {
      const { run } = runner({ status: code });
      const autostart = createCoreAutostart(() => '/h', run);
      expect(autostart.state()).toBe('off');
      expect(await autostart.refresh()).toBe(state);
      expect(autostart.state()).toBe(state);
    }
  });

  it('set(true) installs with the current home and name, then re-reads status', async () => {
    let home = '/a';
    const { calls, run } = runner({ install: 0, status: 0 });
    const autostart = createCoreAutostart(() => home, run, 'qa-2');
    home = '/b';
    expect(await autostart.set(true)).toEqual({ ok: true, state: 'on', out: 'install out' });
    expect(calls).toEqual([
      ['keepalive', 'install', '--home', '/b', '--name', 'qa-2'],
      ['keepalive', 'status', '--home', '/b', '--name', 'qa-2'],
    ]);
  });

  it('set(false) removes; a refused install reports ok:false with the state the OS kept', async () => {
    const off = runner({ remove: 0, status: 1 });
    expect(await createCoreAutostart(() => '/h', off.run).set(false)).toEqual({
      ok: true,
      state: 'off',
      out: 'remove out',
    });
    expect(off.calls[0]).toEqual(['keepalive', 'remove', '--home', '/h']);
    const refused = runner({ install: 1, status: 1 });
    expect(await createCoreAutostart(() => '/h', refused.run).set(true)).toEqual({
      ok: false,
      state: 'off',
      out: 'install out',
    });
  });
});
