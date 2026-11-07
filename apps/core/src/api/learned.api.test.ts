import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { learnedPortOf } from '../bootstrap/economy-wiring/learned-port.ts';
import { learnedPathsFor, learnedResetsPath, readLearned } from '../economy/learned/index.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { SESSION_PID, startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * `POST /v1/learned/reset` (этап 11, P140): сброс ключа обучения — суд `human-strict` (число
 * страницы и чистый пир, или подпись), запись в файл сбросов настоящим портом загрузки,
 * следующее чтение выученного несёт сброс. Модель (токен сессии, процесс из её дерева) снять
 * подъём своего ключа не может.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const KEY = {
  project: 'r1',
  stepKind: 'work',
  adapter: 'claude',
  route: 'claude-login',
  model: 'sonnet',
};

async function reset(body: unknown, token = TOKENS.core) {
  const res = await fetch(`${stand?.url}/v1/learned/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('stage 11 POST /v1/learned/reset is human-strict and clears the key (P140)', () => {
  it('stage 11 learned-reset: without a port 501; nonce + clear peer writes the reset and refreshes; session token, session peer, no proof and a task envelope are refused', async () => {
    stand = await startStand();
    expect(await reset({ cmdId: newId(), key: KEY, proof: {} })).toMatchObject({
      status: 501,
      body: { code: 'not-implemented' },
    });
    await stand.close();

    const notes: { event: string; data: Record<string, unknown> }[] = [];
    let refreshed = 0;
    stand = await startStand(undefined, {
      learned: () =>
        learnedPortOf({
          tasksDir: stand!.layout.tasks,
          note: (event, data) => notes.push({ event, data }),
          refresh: () => {
            refreshed += 1;
          },
          now: () => 5_000,
        }),
    });
    const cmdId = newId();
    const ok = await reset({ cmdId, key: KEY, proof: await stand.nonce() });
    // Ключ без роли — роль вида шага (`work` → `implement`), как строка таблицы обучения.
    const row = 'r1|work|claude|claude-login|sonnet|implement';
    expect(ok).toMatchObject({ status: 200, body: { cmdId, key: row, at: 5_000 } });
    expect(refreshed).toBe(1);
    expect(notes).toMatchObject([{ event: 'learned.reset', data: { cmdId, key: row, at: 5_000 } }]);
    // Сброс — в долговечном файле сбросов дома ядра, не в кэше выученного.
    const paths = learnedPathsFor(stand.layout.tasks);
    expect(paths.resetsFile).toBe(learnedResetsPath(dirname(stand.layout.tasks)));
    expect(JSON.parse(readFileSync(paths.resetsFile, 'utf8')).resets).toEqual({
      [row]: { at: 5_000, cmdId },
    });
    const table = await readLearned(paths);
    expect('value' in table && table.value.resets).toEqual({ [row]: { at: 5_000, cmdId } });

    // Процесс из дерева сессии с числом страницы — подделка человека.
    const fromSession = await stand.nonce();
    stand.peer.direct = SESSION_PID;
    expect(await reset({ cmdId: newId(), key: KEY, proof: fromSession })).toMatchObject({
      status: 403,
      body: { code: 'forged-authority' },
    });
    stand.peer.direct = 4242;
    // Токен сессии к ручке человека.
    expect(await reset({ cmdId: newId(), key: KEY, proof: {} }, TOKENS.session)).toMatchObject({
      status: 403,
      body: { code: 'forged-authority' },
    });
    // Без числа страницы — отказ.
    expect((await reset({ cmdId: newId(), key: KEY, proof: {} })).status).toBe(403);
    expect(notes.filter((n) => n.event === 'learned.refused')).toHaveLength(3);
    // Конверт команды задачи и чужое поле ключа — разбор, не запись.
    const envelope = {
      cmdId: newId(),
      key: KEY,
      target: { taskId: newId() },
      proof: await stand.nonce(),
    };
    expect((await reset(envelope)).status).toBe(400);
    expect((await reset({ cmdId: newId(), key: { ...KEY, extra: 1 }, proof: {} })).status).toBe(
      400,
    );
    expect((await reset({ cmdId: newId(), key: KEY, proof: {} }, '')).status).toBe(401);
    expect(refreshed).toBe(1);
    expect(Object.keys(JSON.parse(readFileSync(paths.resetsFile, 'utf8')).resets)).toEqual([row]);
  });
});
