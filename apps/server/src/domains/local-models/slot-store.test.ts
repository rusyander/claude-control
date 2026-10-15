import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SLOT_AGE_MS,
  MAX_SLOT_FILES,
  SAVE_MIN_TOKENS,
  createSlotStore,
  slotFileOf,
  type SlotStoreDeps,
} from './slot-store.ts';

/**
 * Кеш слота на диске (L8). Клиент сервера — подделка, которая пишет файл в каталог сама, как
 * это делает `llama-server` по `action=save`; каталог — временный, настоящий.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slot-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface World {
  calls: string[];
  /** Сколько токенов сейчас в слоте сервера (то, что вернёт save). */
  slotTokens: number;
  pid: number | undefined;
  asleep: boolean;
  shape: string | undefined;
  failSave: boolean;
  failRestore: boolean;
  clock: number;
}

function setup(over: Partial<World> = {}) {
  const world: World = {
    calls: [],
    slotTokens: 0,
    pid: 100,
    asleep: false,
    shape: 'model-a|131072|q4_0|tpl1',
    failSave: false,
    failRestore: false,
    clock: 1_000,
    ...over,
  };
  const client: SlotStoreDeps['client'] = {
    async saveSlot(filename) {
      world.calls.push(`save ${filename}`);
      world.asleep = false;
      if (world.failSave) throw new Error('save boom');
      writeFileSync(join(dir, filename), Buffer.alloc(16));
      return world.slotTokens;
    },
    async restoreSlot(filename) {
      world.calls.push(`restore ${filename}`);
      world.asleep = false;
      if (world.failRestore) throw new Error('restore boom');
      const meta = JSON.parse(
        readFileSync(join(dir, filename.replace(/\.bin$/, '.json')), 'utf8'),
      ) as { tokens: number };
      world.slotTokens = meta.tokens;
      return meta.tokens;
    },
    async eraseSlot() {
      world.calls.push('erase');
      world.asleep = false;
      world.slotTokens = 0;
      return 0;
    },
  };
  const store = createSlotStore({
    dir,
    client,
    shape: () => world.shape,
    pid: () => world.pid,
    sleeping: async () => world.asleep,
    now: () => world.clock,
  });
  /** Ход разговора: смена слота, затем запрос, наполнивший кеш до `tokens`. */
  async function turn(session: string, tokens: number) {
    const result = await store.switchTo(session);
    world.slotTokens = tokens;
    store.noteTokens(tokens);
    store.done();
    world.clock += 1_000;
    return result;
  }
  return { world, store, turn };
}

const BIG = SAVE_MIN_TOKENS + 10_000;

describe('slot-store: смена разговора', () => {
  it('тот же разговор — слот не трогается', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    world.calls = [];
    expect(await turn('A', BIG + 50)).toBe('kept');
    expect(world.calls).toEqual([]);
  });

  it('первый разговор на бодром сервере стирает неизвестный префикс', async () => {
    const { world, store } = setup({ slotTokens: 5_000 });
    expect(await store.switchTo('A')).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });

  it('смена: длинный кеш уходящего — на диск, возврат поднимает его из файла', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    expect(await turn('B', BIG)).toBe('erased');
    expect(world.calls.slice(1)).toEqual([`save ${slotFileOf('A')}`, 'erase']);
    world.calls = [];
    expect(await turn('A', BIG + 100)).toBe('restored');
    expect(world.calls).toEqual([`save ${slotFileOf('B')}`, `restore ${slotFileOf('A')}`]);
    const meta = JSON.parse(readFileSync(join(dir, 'A.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ session: 'A', shape: 'model-a|131072|q4_0|tpl1', tokens: BIG });
  });

  it('короткий кеш не пишется: дешевле прочитать заново', async () => {
    const { world, turn } = setup();
    await turn('A', SAVE_MIN_TOKENS - 1);
    world.calls = [];
    await turn('B', 10);
    expect(world.calls).toEqual(['erase']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('после сна слот пуст: ничего не пишется и не стирается, сервер не будится', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    world.asleep = true;
    world.calls = [];
    expect(await turn('B', 10)).toBe('fresh');
    expect(world.calls).toEqual([]);
  });

  it('сменился процесс сервера (перезапуск): прежний кеш не пишется, слот стирается', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    world.pid = 200;
    world.calls = [];
    expect(await turn('B', 10)).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });

  it('файл чужого запуска не читается и уходит при уборке', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    await turn('B', BIG);
    world.shape = 'model-a|65536|q8_0|tpl1';
    world.calls = [];
    expect(await turn('A', BIG)).toBe('erased');
    expect(world.calls).toEqual([`save ${slotFileOf('B')}`, 'erase']);
    // Уборка после записи B: файл A снят с другого запуска.
    expect(existsSync(join(dir, 'A.bin'))).toBe(false);
    expect(existsSync(join(dir, 'A.json'))).toBe(false);
    expect(existsSync(join(dir, 'B.bin'))).toBe(true);
  });

  it('файл чужого запуска не читается и без уборки перед ним', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    await turn('B', 10);
    world.shape = 'model-b|131072|q4_0|tpl1';
    world.calls = [];
    expect(await turn('A', BIG)).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });

  it(`файлов не больше ${MAX_SLOT_FILES}: самые давние уходят`, async () => {
    const { turn } = setup();
    const sessions = Array.from({ length: MAX_SLOT_FILES + 2 }, (_, i) => `s${i}`);
    for (const session of sessions) await turn(session, BIG);
    await turn('last', 10);
    const kept = readdirSync(dir).filter((name) => name.endsWith('.bin'));
    expect(kept).toHaveLength(MAX_SLOT_FILES);
    expect(kept).not.toContain('s0.bin');
    expect(kept).not.toContain('s1.bin');
    expect(kept).toContain(`s${MAX_SLOT_FILES + 1}.bin`);
  });

  it('сбой записи не срывает смену: слот стирается', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    world.failSave = true;
    world.calls = [];
    expect(await turn('B', 10)).toBe('erased');
    expect(world.calls).toEqual([`save ${slotFileOf('A')}`, 'erase']);
  });

  it('сбой чтения — как файла нет: слот стирается', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    await turn('B', 10);
    world.failRestore = true;
    world.calls = [];
    expect(await turn('A', BIG)).toBe('erased');
    expect(world.calls).toEqual([`restore ${slotFileOf('A')}`, 'erase']);
  });

  it('имя файла из номера разговора без пути и чужих знаков', () => {
    expect(slotFileOf('../x/y:z')).toBe('___x_y_z.bin');
  });
});

describe('slot-store: запрос без метки разговора', () => {
  it('кеш разговора — на диск, следующий ход того же разговора поднимает его, а не «свой»', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    world.calls = [];
    await store.release();
    expect(world.calls).toEqual([`save ${slotFileOf('A')}`]);
    // Проба переписала слот своим промптом.
    world.slotTokens = 300;
    world.calls = [];
    expect(await turn('A', BIG)).toBe('restored');
    expect(world.calls).toEqual([`restore ${slotFileOf('A')}`]);
  });

  it('короткий кеш не пишется, но держатель забыт: следующий ход стирает чужой префикс', async () => {
    const { world, store, turn } = setup();
    await turn('A', 100);
    world.calls = [];
    await store.release();
    expect(world.calls).toEqual([]);
    expect(await turn('A', 100)).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });

  it('запись по простою после пробы не кладёт её промпт под именем разговора', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    await store.release();
    world.slotTokens = BIG + 5;
    world.clock += 10 * 60_000;
    world.calls = [];
    expect(await store.saveIdle(0)).toBe(false);
    expect(world.calls).toEqual([]);
  });
});

describe('slot-store: запись перед сном', () => {
  it('один раз до следующего запроса; смена после неё не пишет повторно', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    world.calls = [];
    expect(await store.saveIdle(0)).toBe(true);
    expect(await store.saveIdle(0)).toBe(false);
    expect(world.calls).toEqual([`save ${slotFileOf('A')}`]);
    world.calls = [];
    await turn('B', 10);
    expect(world.calls).toEqual(['erase']);
  });

  it('новый запрос того же разговора — кеш снова «не на диске»', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    await store.saveIdle(0);
    await turn('A', BIG + 500);
    world.calls = [];
    expect(await store.saveIdle(0)).toBe(true);
    expect(world.calls).toEqual([`save ${slotFileOf('A')}`]);
  });

  it('первый ход того же разговора после сна поднимает кеш из записи перед сном', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    await store.saveIdle(0);
    world.asleep = true;
    world.calls = [];
    expect(await turn('A', BIG + 20)).toBe('restored');
    expect(world.calls).toEqual([`restore ${slotFileOf('A')}`]);
  });

  it('запись не раньше заданного простоя', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    expect(await store.saveIdle(60_000)).toBe(false);
    world.clock += 60_000;
    expect(await store.saveIdle(60_000)).toBe(true);
  });

  it('запись, вставшая в очередь за сменой разговора, видит свежий простой и не пишет', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    await store.saveIdle(0);
    world.asleep = true;
    world.clock += 20 * 60_000;
    world.calls = [];
    // Замер 15.10: проверка простоя сработала, пока кеш поднимался из файла после сна.
    const [switched, saved] = await Promise.all([store.switchTo('A'), store.saveIdle(60_000)]);
    expect(switched).toBe('restored');
    expect(saved).toBe(false);
    expect(world.calls).toEqual([`restore ${slotFileOf('A')}`]);
  });

  it('спящий сервер и короткий кеш не пишутся', async () => {
    const short = setup();
    await short.turn('A', 10);
    expect(await short.store.saveIdle(0)).toBe(false);
    const asleep = setup();
    await asleep.turn('A', BIG);
    asleep.world.asleep = true;
    expect(await asleep.store.saveIdle(0)).toBe(false);
    expect(asleep.world.calls).toEqual(['erase']);
  });

  it('простой считается от конца последнего запроса', async () => {
    const { world, store, turn } = setup();
    expect(store.idleMs()).toBeUndefined();
    await turn('A', 10);
    world.clock += 30_000;
    expect(store.idleMs()).toBe(31_000);
  });
});

describe('slot-store: уборка', () => {
  it('файл старше срока уходит, свежий остаётся', async () => {
    const { world, store, turn } = setup();
    await turn('old', BIG);
    await turn('fresh', BIG);
    await turn('x', 10); // fresh — на диск
    world.clock += MAX_SLOT_AGE_MS - 1_500; // old записан на 2 с раньше fresh
    await store.sweep();
    expect(existsSync(join(dir, 'old.bin'))).toBe(false);
    expect(existsSync(join(dir, 'old.json'))).toBe(false);
    expect(existsSync(join(dir, 'fresh.bin'))).toBe(true);
  });

  it('.bin без описания (запись оборвалась, файл замера) уходит, описанный остаётся', async () => {
    const { store, turn } = setup();
    await turn('A', BIG);
    await turn('B', 10);
    writeFileSync(join(dir, 'l8-probe.bin'), Buffer.alloc(8));
    await store.sweep();
    expect(existsSync(join(dir, 'l8-probe.bin'))).toBe(false);
    expect(existsSync(join(dir, 'A.bin'))).toBe(true);
  });

  it('сервер не поднят — файл другого запуска не судится по запуску и остаётся', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    await turn('B', 10);
    world.shape = undefined;
    await store.sweep();
    expect(existsSync(join(dir, 'A.bin'))).toBe(true);
    world.shape = 'model-b|131072|q4_0|tpl1';
    await store.sweep();
    expect(existsSync(join(dir, 'A.bin'))).toBe(false);
  });

  it('кеш в слоте, записанный перед сном и убранный по сроку, при смене пишется заново', async () => {
    const { world, store, turn } = setup();
    await turn('A', BIG);
    world.clock += 10 * 60_000;
    expect(await store.saveIdle(60_000)).toBe(true);
    world.clock += MAX_SLOT_AGE_MS + 1;
    await store.sweep();
    expect(existsSync(join(dir, 'A.bin'))).toBe(false);
    world.calls = [];
    await turn('B', 10);
    expect(world.calls[0]).toBe(`save ${slotFileOf('A')}`);
  });

  it('каталога нет — уборка молчит', async () => {
    const { store } = setup();
    rmSync(dir, { recursive: true, force: true });
    await expect(store.sweep()).resolves.toBeUndefined();
  });
});
