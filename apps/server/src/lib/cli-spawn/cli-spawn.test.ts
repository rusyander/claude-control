import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ledgerCliMarker, spawnCliProcess } from './cli-spawn.ts';

/**
 * Окружение прогона — там, где его читает сам процесс.
 *
 * Почему тест устроен так: маршрут контура (Т3) доходит до CLI ровно одной
 * опцией `env` этого модуля, и опция эта была объявлена, задокументирована — и
 * не передавалась в spawn вовсе. Шпион на `spawnImpl` такой пропажи не увидел
 * бы: он проверил бы, что МЫ позвали функцию с нужным объектом. Поэтому здесь
 * запускается настоящий процесс, и спрашивается его собственное окружение.
 */

/** Ответ настоящего ребёнка: что он видит в своём окружении. */
function childEnv(env?: Record<string, string>): Promise<{ value: string; path: string }> {
  const code =
    'process.stdout.write(JSON.stringify({' +
    'value: process.env.CC_CONTOUR_PROBE ?? "", ' +
    'path: process.env.PATH ?? process.env.Path ?? ""}))';

  return new Promise((resolve, reject) => {
    const spawned = spawnCliProcess(process.execPath, ['-e', code], {
      ...(env ? { env } : {}),
    });
    if (spawned.error) {
      reject(spawned.error);
      return;
    }

    let out = '';
    spawned.child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    spawned.child.on('error', reject);
    spawned.child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()) as { value: string; path: string });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

describe('lib/cli-spawn: окружение доходит до процесса', () => {
  it('переменная из options.env видна самому процессу', async () => {
    const child = await childEnv({ CC_CONTOUR_PROBE: 'http://127.0.0.1:5179/enterprise-platform' });
    expect(child.value).toBe('http://127.0.0.1:5179/enterprise-platform');
  });

  it('это ДОБАВКА: PATH процесса остаётся на месте', async () => {
    // Замена окружения целиком лишила бы CLI поиска исполняемых файлов, дома и
    // входа в аккаунт — «направить в контур» превратилось бы в «сломать запуск».
    const child = await childEnv({ CC_CONTOUR_PROBE: 'x' });
    expect(child.path.length).toBeGreaterThan(0);
  });

  it('без options.env процесс наследует окружение сервера как раньше', async () => {
    const child = await childEnv();
    expect(child.value).toBe('');
    expect(child.path.length).toBeGreaterThan(0);
  });
});

/** Метка CLI, которую видит сам процесс, при журнале в окружении сервера и без него. */
async function ledgerMarker(home: string | undefined, inheritEnv?: boolean): Promise<string> {
  const before = process.env.AGENTDECK_VERIFY_LEDGER_HOME;
  // Запуск из сессии CLI с глобальным журналом приносит его метку в окружение — тест видел бы её, а не нашу.
  const inherited = process.env.AGENTDECK_VERIFY_LEDGER_CLI;
  delete process.env.AGENTDECK_VERIFY_LEDGER_CLI;
  if (home === undefined) delete process.env.AGENTDECK_VERIFY_LEDGER_HOME;
  else process.env.AGENTDECK_VERIFY_LEDGER_HOME = home;
  try {
    const spawned = spawnCliProcess(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.AGENTDECK_VERIFY_LEDGER_CLI ?? "")'],
      inheritEnv === false ? { inheritEnv: false, env: { PATH: process.env.PATH ?? '' } } : {},
    );
    if (spawned.error) throw spawned.error;
    let out = '';
    spawned.child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    await new Promise((resolve) => spawned.child.on('close', resolve));
    return out;
  } finally {
    if (before === undefined) delete process.env.AGENTDECK_VERIFY_LEDGER_HOME;
    else process.env.AGENTDECK_VERIFY_LEDGER_HOME = before;
    if (inherited !== undefined) process.env.AGENTDECK_VERIFY_LEDGER_CLI = inherited;
  }
}

describe('lib/cli-spawn: метка CLI для пульса журнала проверок', () => {
  it('журнал подмешан — процесс видит имя своего CLI без пути и расширения', async () => {
    expect(await ledgerMarker('/tmp/ledger-home')).toBe('node');
  });

  it('журнала нет — метки нет', async () => {
    expect(await ledgerMarker(undefined)).toBe('');
  });

  it('агент панели (inheritEnv: false) метку не получает', async () => {
    expect(await ledgerMarker('/tmp/ledger-home', false)).toBe('');
  });

  it('журнал подмешан — CLI получает замок: off в команде модели повтор не выключает', () => {
    const names = [
      'AGENTDECK_VERIFY_LEDGER_HOME',
      'AGENTDECK_VERIFY_LEDGER',
      'AGENTDECK_VERIFY_LEDGER_DELTA',
      'NODE_OPTIONS',
    ] as const;
    const before = names.map((name) => process.env[name]);
    try {
      process.env.AGENTDECK_VERIFY_LEDGER_HOME = '/tmp/ledger-home';
      delete process.env.AGENTDECK_VERIFY_LEDGER;
      delete process.env.AGENTDECK_VERIFY_LEDGER_DELTA;
      delete process.env.NODE_OPTIONS;
      expect(ledgerCliMarker('C:/bin/claude.exe')).toEqual({
        AGENTDECK_VERIFY_LEDGER_LOCK: '1',
        AGENTDECK_VERIFY_LEDGER_CLI: 'claude',
      });
      // Имя не разобрано — метки нет, замок есть.
      expect(ledgerCliMarker('weird name!')).toEqual({ AGENTDECK_VERIFY_LEDGER_LOCK: '1' });
      // Человек выключил повтор или сужение в окружении самой панели — его выбор, замка нет.
      process.env.AGENTDECK_VERIFY_LEDGER = 'off';
      expect(ledgerCliMarker('claude')).toEqual({ AGENTDECK_VERIFY_LEDGER_CLI: 'claude' });
      process.env.AGENTDECK_VERIFY_LEDGER = 'on';
      process.env.AGENTDECK_VERIFY_LEDGER_DELTA = 'off';
      expect(ledgerCliMarker('claude')).toEqual({ AGENTDECK_VERIFY_LEDGER_CLI: 'claude' });
      delete process.env.AGENTDECK_VERIFY_LEDGER_HOME;
      expect(ledgerCliMarker('claude')).toEqual({});
    } finally {
      names.forEach((name, i) => {
        const value = before[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });

  it('замок во входе (F-30): NODE_OPTIONS ведёт на preload-locked.cjs, только если файл есть', () => {
    const names = [
      'AGENTDECK_VERIFY_LEDGER_HOME',
      'AGENTDECK_VERIFY_LEDGER',
      'AGENTDECK_VERIFY_LEDGER_DELTA',
      'NODE_OPTIONS',
    ] as const;
    const before = names.map((name) => process.env[name]);
    const home = mkdtempSync(join(tmpdir(), 'ledger-home-')).replace(/\\/g, '/');
    const bin = `${home}/bin`;
    mkdirSync(bin);
    try {
      process.env.AGENTDECK_VERIFY_LEDGER_HOME = '/tmp/ledger-home';
      delete process.env.AGENTDECK_VERIFY_LEDGER;
      delete process.env.AGENTDECK_VERIFY_LEDGER_DELTA;
      process.env.NODE_OPTIONS = `--max-old-space-size=4096 --require "${bin}/preload.cjs"`;
      // Входа с замком ещё нет (старая установка) — NODE_OPTIONS не трогается.
      expect(ledgerCliMarker('claude').NODE_OPTIONS).toBeUndefined();
      writeFileSync(`${bin}/preload-locked.cjs`, '');
      expect(ledgerCliMarker('claude')).toEqual({
        AGENTDECK_VERIFY_LEDGER_LOCK: '1',
        NODE_OPTIONS: `--max-old-space-size=4096 --require "${bin}/preload-locked.cjs"`,
        AGENTDECK_VERIFY_LEDGER_CLI: 'claude',
      });
      // Выбор человека (off в окружении панели) — обычный вход, без замка.
      process.env.AGENTDECK_VERIFY_LEDGER = 'off';
      expect(ledgerCliMarker('claude').NODE_OPTIONS).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      names.forEach((name, i) => {
        const value = before[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});
