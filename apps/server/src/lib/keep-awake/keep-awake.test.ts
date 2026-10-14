import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AWAKE_RETRY_MS, awakeCommand, createKeepAwake } from './keep-awake.ts';

/**
 * Запрет сна на время локального прогона (L4b). Помощник — отдельный процесс; здесь его
 * заменяет фальшивый (запуск ОС — внешняя граница), а решения «когда держать, когда
 * отпустить, когда сдаться» — настоящие. Что настоящий помощник держит запрет в ОС,
 * показывает живая проверка отдельно.
 */

class FakeHelper extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function world(platform: NodeJS.Platform = 'win32') {
  const helpers: FakeHelper[] = [];
  const spawned: { command: string; args: string[] }[] = [];
  const log = vi.fn();
  let clock = 1_000_000;
  const awake = createKeepAwake({
    platform,
    pid: 4321,
    spawnHelper: (command, args) => {
      spawned.push({ command, args });
      const helper = new FakeHelper();
      helpers.push(helper);
      return helper as never;
    },
    now: () => clock,
    log,
  });
  return {
    awake,
    helpers,
    spawned,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('команда помощника по платформам', () => {
  it('Windows: PowerShell зовёт SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) и следит за панелью', () => {
    const made = awakeCommand('win32', 4321);
    expect(made?.command).toBe('powershell.exe');
    const encoded = made?.args.at(-1) ?? '';
    expect(made?.args.at(-2)).toBe('-EncodedCommand');
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain('SetThreadExecutionState');
    // 0x80000001 как десятичное uint32: шестнадцатеричный литерал PowerShell — знаковый.
    expect(script).toContain('[uint32]2147483649');
    expect(script).toContain('Get-Process -Id 4321');
  });

  it('macOS: caffeinate -i -w <pid панели>', () => {
    expect(awakeCommand('darwin', 77)).toEqual({
      command: 'caffeinate',
      args: ['-i', '-w', '77'],
    });
  });

  it('Linux: systemd-inhibit на сон и простой, держит, пока жива панель', () => {
    const made = awakeCommand('linux', 88);
    expect(made?.command).toBe('systemd-inhibit');
    expect(made?.args).toContain('--what=sleep:idle');
    expect(made?.args).toContain('--mode=block');
    expect(made?.args).toContain('--pid=88');
  });

  it('другая платформа — команды нет', () => {
    expect(awakeCommand('freebsd', 1)).toBeUndefined();
  });
});

describe('запрет сна: когда держать и когда отпустить', () => {
  it('прогон пошёл — помощник один; повторные «нужен» второго не заводят', () => {
    const { awake, helpers, spawned } = world();
    awake.sync(true);
    awake.sync(true);
    awake.sync(true);
    expect(spawned).toHaveLength(1);
    expect(helpers).toHaveLength(1);
    expect(awake.status()).toEqual({ held: true, supported: true });
  });

  it('прогон кончился — помощник снят, а не оставлен до выхода панели', () => {
    const { awake, helpers } = world();
    awake.sync(true);
    awake.sync(false);
    expect(helpers[0]?.killed).toBe(true);
    expect(awake.status().held).toBe(false);
  });

  it('следующий прогон — новый помощник', () => {
    const { awake, helpers } = world();
    awake.sync(true);
    awake.sync(false);
    awake.sync(true);
    expect(helpers).toHaveLength(2);
    expect(helpers[1]?.killed).toBe(false);
  });

  it('«не нужен» без запрета — ничего не происходит', () => {
    const { awake, spawned } = world();
    awake.sync(false);
    expect(spawned).toHaveLength(0);
  });

  it('выход панели (stop) снимает запрет', () => {
    const { awake, helpers } = world();
    awake.sync(true);
    awake.stop();
    expect(helpers[0]?.killed).toBe(true);
    expect(awake.status().held).toBe(false);
  });
});

describe('запрет сна: помощник не работает', () => {
  it('платформа без помощника — прогон идёт, запрета нет, «не поддерживается»', () => {
    const { awake, spawned } = world('freebsd');
    awake.sync(true);
    expect(spawned).toHaveLength(0);
    expect(awake.status()).toEqual({ held: false, supported: false });
  });

  it('команды нет в системе (ENOENT) — навсегда, в журнал один раз', () => {
    const { awake, helpers, spawned, log, advance } = world('linux');
    awake.sync(true);
    helpers[0]?.emit(
      'error',
      Object.assign(new Error('spawn systemd-inhibit'), { code: 'ENOENT' }),
    );
    expect(awake.status()).toEqual({ held: false, supported: false });
    advance(AWAKE_RETRY_MS * 10);
    awake.sync(true);
    awake.sync(true);
    expect(spawned).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('помощник вышел сразу — повтор не раньше срока; после трёх быстрых выходов подряд — сдаёмся', () => {
    const { awake, helpers, spawned, advance } = world();
    awake.sync(true);
    helpers[0]?.emit('exit', 1);
    awake.sync(true);
    // Срок повтора не вышел: второго запуска нет.
    expect(spawned).toHaveLength(1);
    advance(AWAKE_RETRY_MS + 1);
    awake.sync(true);
    expect(spawned).toHaveLength(2);
    helpers[1]?.emit('exit', 1);
    advance(AWAKE_RETRY_MS + 1);
    awake.sync(true);
    expect(spawned).toHaveLength(3);
    helpers[2]?.emit('exit', 1);
    expect(awake.status().supported).toBe(false);
    advance(AWAKE_RETRY_MS + 1);
    awake.sync(true);
    expect(spawned).toHaveLength(3);
  });

  it('быстрые выходы считаются подряд: помощник, поработавший как следует, счёт обнуляет (L4c, F8)', () => {
    const { awake, helpers, spawned, advance } = world();
    // Два быстрых выхода.
    awake.sync(true);
    helpers[0]?.emit('exit', 1);
    advance(AWAKE_RETRY_MS + 1);
    awake.sync(true);
    helpers[1]?.emit('exit', 1);
    advance(AWAKE_RETRY_MS + 1);
    // Третий помощник работает всю ночь и снимается штатно, когда прогон кончился.
    awake.sync(true);
    advance(8 * 3_600_000);
    awake.sync(false);
    expect(awake.status().supported).toBe(true);
    // Через дни ещё два быстрых выхода — до сдачи далеко: счёт начался заново.
    for (let round = 0; round < 2; round += 1) {
      advance(24 * 3_600_000);
      awake.sync(true);
      helpers.at(-1)?.emit('exit', 1);
    }
    expect(awake.status().supported).toBe(true);
    advance(AWAKE_RETRY_MS + 1);
    awake.sync(true);
    expect(spawned.length).toBeGreaterThanOrEqual(5);
    expect(awake.status().held).toBe(true);
  });

  it('помощник, поработавший и вышедший сам, тоже обнуляет счёт быстрых выходов (L4c, F8)', () => {
    const { awake, helpers, advance } = world();
    for (let round = 0; round < 2; round += 1) {
      awake.sync(true);
      helpers.at(-1)?.emit('exit', 1);
      advance(AWAKE_RETRY_MS + 1);
    }
    awake.sync(true);
    advance(60_000);
    helpers.at(-1)?.emit('exit', 0);
    for (let round = 0; round < 2; round += 1) {
      awake.sync(true);
      helpers.at(-1)?.emit('exit', 1);
      advance(AWAKE_RETRY_MS + 1);
    }
    expect(awake.status().supported).toBe(true);
  });

  it('помощник, проработавший долго и вышедший, — не неудача: следующий «нужен» поднимает нового сразу', () => {
    const { awake, helpers, spawned, advance } = world();
    awake.sync(true);
    advance(60_000);
    helpers[0]?.emit('exit', 0);
    expect(awake.status().held).toBe(false);
    awake.sync(true);
    expect(spawned).toHaveLength(2);
  });

  it('прогон кончился, и помощник вышел после этого — чужой «exit» нового не задевает', () => {
    const { awake, helpers, spawned } = world();
    awake.sync(true);
    awake.sync(false);
    awake.sync(true);
    // Запоздавший выход СНЯТОГО помощника не должен обнулить нового.
    helpers[0]?.emit('exit', 0);
    expect(awake.status().held).toBe(true);
    expect(spawned).toHaveLength(2);
  });
});
