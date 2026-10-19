import { describe, it, expect } from 'vitest';
import { spawnCliProcess } from './cli-spawn.ts';

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
});
