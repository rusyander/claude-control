import { describe, expect, it } from 'vitest';
import { createLivenessProbe, fakeProcessTable } from './process-identity.ts';

describe('F-30 liveness tick cache — a pid born after the snapshot is not judged dead', () => {
  it('F-30 isAlive: pid missing from the cached snapshot → fresh read decides, not the stale tick', async () => {
    const table = fakeProcessTable([{ pid: 1, ppid: 0, start: 'a', startMs: 1 }]);
    let now = 1_000;
    const probe = createLivenessProbe(table, 1_000, () => now);
    expect(await probe.isAlive({ pid: 1, start: 'a' })).toBe('alive');
    table.set([
      { pid: 1, ppid: 0, start: 'a', startMs: 1 },
      { pid: 77, ppid: 1, start: 'new', startMs: 2 },
    ]);
    now += 10;
    expect(await probe.isAlive({ pid: 77, start: 'new' })).toBe('alive');
  });

  it('F-30 identityOf: a pid absent from the cached snapshot is re-read before «absent»', async () => {
    const table = fakeProcessTable([{ pid: 1, ppid: 0, start: 'a', startMs: 1 }]);
    const probe = createLivenessProbe(table, 1_000, () => 5);
    await probe.snapshot();
    table.set([{ pid: 88, ppid: 1, start: 'b', startMs: 2 }]);
    expect(await probe.identityOf(88)).toEqual({ value: { pid: 88, start: 'b' } });
  });

  it('F-30 a genuinely dead pid stays dead; dead questions of one tick share one fresh read', async () => {
    const table = fakeProcessTable([{ pid: 1, ppid: 0, start: 'a', startMs: 1 }]);
    const probe = createLivenessProbe(table, 1_000, () => 5);
    await probe.snapshot();
    const before = table.reads();
    const answers = await Promise.all([
      probe.isAlive({ pid: 2, start: 'x' }),
      probe.isAlive({ pid: 3, start: 'y' }),
      probe.isAlive({ pid: 1, start: 'other' }),
    ]);
    expect(answers).toEqual(['dead', 'dead', 'dead']);
    expect(table.reads() - before).toBe(1);
    // Вопрос, заданный после того снимка, снова читает: снимок начат раньше вопроса.
    expect(await probe.isAlive({ pid: 4, start: 'z' })).toBe('dead');
    expect(table.reads() - before).toBe(2);
    // «Жив» из кэша тика — без нового чтения.
    expect(await probe.isAlive({ pid: 1, start: 'a' })).toBe('alive');
    expect(table.reads() - before).toBe(2);
  });

  it('F-30 the fresh read fails → unknown, never dead', async () => {
    const table = fakeProcessTable([{ pid: 1, ppid: 0, start: 'a', startMs: 1 }]);
    const probe = createLivenessProbe(table, 1_000, () => 5);
    await probe.snapshot();
    table.fail('os said no');
    expect(await probe.isAlive({ pid: 9, start: 'q' })).toBe('unknown');
  });

  it('fresh isAlive: «alive» cached in the tick is not trusted; every fresh question gets a read started after it', async () => {
    const table = fakeProcessTable([{ pid: 1, ppid: 0, start: 'a', startMs: 1 }]);
    const probe = createLivenessProbe(table, 60_000, () => 5);
    expect(await probe.isAlive({ pid: 1, start: 'a' })).toBe('alive');
    table.set([]);
    // Кэш такта ещё зовёт его живым — обычный вопрос так и отвечает, свежий читает заново.
    expect(await probe.isAlive({ pid: 1, start: 'a' })).toBe('alive');
    const before = table.reads();
    const answers = await Promise.all([
      probe.isAlive({ pid: 1, start: 'a' }, { fresh: true }),
      probe.isAlive({ pid: 1, start: 'a' }, { fresh: true }),
    ]);
    expect(answers).toEqual(['dead', 'dead']);
    // Чтение, начатое до вопроса, ему не ответ: второй свежий вопрос читает сам.
    expect(table.reads() - before).toBe(2);
    // Свежее чтение стало снимком такта: обычный вопрос теперь видит смерть без нового чтения.
    expect(await probe.isAlive({ pid: 1, start: 'a' })).toBe('dead');
    table.fail('os said no');
    expect(await probe.isAlive({ pid: 1, start: 'a' }, { fresh: true })).toBe('unknown');
  });
});
