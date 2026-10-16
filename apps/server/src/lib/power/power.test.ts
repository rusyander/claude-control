import { describe, expect, it } from 'vitest';
import {
  parseLogindAnswer,
  parsePmsetHibernateMode,
  parseRegDword,
  powerCommand,
  probePower,
  type CommandResult,
  type PowerProbe,
} from './power.ts';

/** Вывод `reg query … /v HibernateEnabledDefault` — как его печатает Windows 11. */
const REG_DEFAULT = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Power',
  '    HibernateEnabledDefault    REG_DWORD    0x1',
  '',
].join('\r\n');

/** Начало `pmset -g` с MacBook (macOS 15). */
const PMSET = [
  'System-wide power settings:',
  'Currently in use:',
  ' standby              1',
  ' Sleep On Power Button 1',
  ' hibernatefile        /var/vm/sleepimage',
  ' hibernatemode        3',
  ' ttyskeepawake        1',
].join('\n');

/**
 * Пробник с ответами по «имени утилиты + последнему аргументу»; чего нет — утилита
 * «не нашлась». `calls` хранит команду как есть — с путём, которым её позвали.
 */
function fakeProbe(
  platform: NodeJS.Platform,
  answers: Record<string, CommandResult>,
  exists: (path: string) => boolean = () => false,
): PowerProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform,
    systemDrive: 'C:',
    systemRoot: 'C:\\Windows',
    exists,
    calls,
    run: async (command, args) => {
      calls.push(`${command} ${args.at(-1)}`);
      return answers[`${command.split(/[\\/]/).at(-1)} ${args.at(-1)}`] ?? { code: -1, stdout: '' };
    },
  };
}

describe('разбор вывода утилит', () => {
  it('reg query: значение DWORD по имени, чужое имя — пусто', () => {
    expect(parseRegDword(REG_DEFAULT, 'HibernateEnabledDefault')).toBe(1);
    expect(parseRegDword(REG_DEFAULT, 'HibernateEnabled')).toBeUndefined();
    expect(parseRegDword('    HibernateEnabled    REG_DWORD    0x0', 'HibernateEnabled')).toBe(0);
  });

  it('pmset -g: hibernatemode, строки hibernatefile не путают', () => {
    expect(parsePmsetHibernateMode(PMSET)).toBe(3);
    expect(parsePmsetHibernateMode(' hibernatemode        25\n')).toBe(25);
    expect(parsePmsetHibernateMode('Currently in use:\n')).toBeUndefined();
  });

  it('busctl: ответ logind в кавычках', () => {
    expect(parseLogindAnswer('s "yes"\n')).toBe('yes');
    expect(parseLogindAnswer('s "challenge"\n')).toBe('challenge');
    expect(parseLogindAnswer('Failed to connect to bus')).toBeUndefined();
  });
});

describe('probePower', () => {
  it('Windows: явного HibernateEnabled нет — решает HibernateEnabledDefault', async () => {
    const probe = fakeProbe('win32', {
      'reg.exe HibernateEnabled': { code: 1, stdout: '' },
      'reg.exe HibernateEnabledDefault': { code: 0, stdout: REG_DEFAULT },
    });
    expect(await probePower(probe)).toEqual({
      platform: 'win32',
      options: [{ action: 'hibernate', available: true }],
    });
  });

  it('Windows: гибернация выключена (HibernateEnabled = 0) — «disabled», даже если default = 1', async () => {
    const probe = fakeProbe('win32', {
      'reg.exe HibernateEnabled': {
        code: 0,
        stdout: '    HibernateEnabled    REG_DWORD    0x0',
      },
      'reg.exe HibernateEnabledDefault': { code: 0, stdout: REG_DEFAULT },
    });
    expect((await probePower(probe)).options).toEqual([
      { action: 'hibernate', available: false, reason: 'disabled' },
    ]);
  });

  // Windows ищет exe по имени сначала в текущем каталоге процесса: позвать `reg.exe`
  // по имени — значит запустить подложенный туда файл.
  it('Windows: реестр читается reg.exe из System32 полным путём, не по имени', async () => {
    const probe = fakeProbe('win32', {});
    await probePower(probe);
    expect(probe.calls).toEqual([
      'C:\\Windows\\System32\\reg.exe HibernateEnabled',
      'C:\\Windows\\System32\\reg.exe HibernateEnabledDefault',
    ]);
  });

  it('Windows: реестр молчит совсем — по hiberfil.sys на системном диске', async () => {
    const seen: string[] = [];
    const probe = fakeProbe('win32', {}, (path) => {
      seen.push(path);
      return true;
    });
    expect((await probePower(probe)).options[0]?.available).toBe(true);
    expect(seen).toEqual([expect.stringMatching(/^C:[\\/]+hiberfil\.sys$/)]);
  });

  it('macOS: сон и режим гибернации из pmset; без pmset — «no-tool»', async () => {
    expect(
      await probePower(fakeProbe('darwin', { 'pmset -g': { code: 0, stdout: PMSET } })),
    ).toEqual({
      platform: 'darwin',
      options: [{ action: 'sleep', available: true }],
      macHibernateMode: 3,
    });
    const missing = fakeProbe('darwin', {});
    expect((await probePower(missing)).options).toEqual([
      { action: 'sleep', available: false, reason: 'no-tool' },
    ]);
    expect(missing.calls).toEqual(['/usr/bin/pmset -g']);
  });

  it('Linux: гибернация по CanHibernate, сон по CanSuspend; «challenge» — недоступно', async () => {
    const probe = fakeProbe('linux', {
      'busctl CanHibernate': { code: 0, stdout: 's "challenge"\n' },
      'busctl CanSuspend': { code: 0, stdout: 's "yes"\n' },
    });
    expect((await probePower(probe)).options).toEqual([
      { action: 'hibernate', available: false, reason: 'not-allowed' },
      { action: 'sleep', available: true },
    ]);
  });

  it('Linux без logind — оба «no-tool», CanSuspend уже не спрашиваем', async () => {
    const probe = fakeProbe('linux', {});
    expect((await probePower(probe)).options).toEqual([
      { action: 'hibernate', available: false, reason: 'no-tool' },
      { action: 'sleep', available: false, reason: 'no-tool' },
    ]);
    expect(probe.calls).toEqual(['busctl CanHibernate']);
  });

  it('незнакомая платформа — ничего не спрашиваем, всё «unsupported»', async () => {
    const probe = fakeProbe('freebsd', {});
    expect((await probePower(probe)).platform).toBe('other');
    expect(probe.calls).toEqual([]);
  });
});

describe('powerCommand', () => {
  const on = (platform: NodeJS.Platform) => ({ platform, systemRoot: 'D:\\WINDOWS' });

  it('у каждой платформы своя команда, лишних нет', () => {
    // Windows — shutdown.exe из каталога системы, который назвала сама система.
    expect(powerCommand(on('win32'), 'hibernate')).toEqual({
      command: 'D:\\WINDOWS\\System32\\shutdown.exe',
      args: ['/h'],
    });
    expect(powerCommand(on('win32'), 'sleep')).toBeUndefined();
    expect(powerCommand(on('darwin'), 'sleep')).toEqual({
      command: '/usr/bin/pmset',
      args: ['sleepnow'],
    });
    expect(powerCommand(on('darwin'), 'hibernate')).toBeUndefined();
    expect(powerCommand(on('freebsd'), 'sleep')).toBeUndefined();
  });

  // Пароль с телефона не ввести — systemctl не должен его ждать; а запреты системы
  // (`-i` / `--ignore-inhibitors` / `--force`) не обходятся никогда.
  it('Linux: без запроса пароля и без обхода запретов', () => {
    for (const [action, verb] of [
      ['hibernate', 'hibernate'],
      ['sleep', 'suspend'],
    ] as const) {
      const command = powerCommand(on('linux'), action);
      expect(command).toEqual({ command: 'systemctl', args: ['--no-ask-password', verb] });
      expect(command?.args.some((arg) => /^-i$|ignore-inhibitors|force/.test(arg))).toBe(false);
    }
  });

  it('ни на одной платформе нет выключения и перезагрузки', () => {
    const banned = /^\/[sprg]$|poweroff|reboot|halt|shutdown$|restart/i;
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const action of ['hibernate', 'sleep'] as const) {
        const command = powerCommand(on(platform), action);
        for (const arg of command?.args ?? []) expect(arg).not.toMatch(banned);
      }
    }
  });
});
