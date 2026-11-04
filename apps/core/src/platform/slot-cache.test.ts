import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SLOT_FILES,
  SAVE_MIN_TOKENS,
  createSlotCache,
  slotFileOf,
  type SlotTarget,
} from './slot-cache.ts';

/**
 * Кеш слота по разговорам (L8; перенесён из панели `local-models/slot-store.ts` на этапе 10 —
 * здесь же живут проверки смены разговора, снятые вместе с ним). Сервер — подделка `fetch`,
 * которая пишет файл в каталог сама, как `llama-server` по `action=save`; каталог — настоящий.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slot-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface World {
  calls: string[];
  /** Сколько токенов сейчас в слоте сервера (то, что вернёт save). */
  slotTokens: number;
  failSave: boolean;
  failRestore: boolean;
  clock: number;
}

const BIG = SAVE_MIN_TOKENS + 10_000;

function setup(over: Partial<World> = {}) {
  const world: World = {
    calls: [],
    slotTokens: 0,
    failSave: false,
    failRestore: false,
    clock: 1_000,
    ...over,
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const action = url.searchParams.get('action');
    const filename = init?.body
      ? (JSON.parse(String(init.body)) as { filename: string }).filename
      : undefined;
    world.calls.push(filename ? `${action} ${filename}` : String(action));
    const reply = (body: Record<string, unknown>): Response =>
      new Response(JSON.stringify(body), { status: 200 });
    if (action === 'save') {
      if (world.failSave) return new Response('boom', { status: 500 });
      writeFileSync(join(dir, String(filename)), Buffer.alloc(16));
      return reply({ n_saved: world.slotTokens });
    }
    if (action === 'restore') {
      if (world.failRestore) return new Response('boom', { status: 500 });
      const meta = JSON.parse(
        readFileSync(join(dir, String(filename).replace(/\.bin$/, '.json')), 'utf8'),
      ) as { tokens: number };
      world.slotTokens = meta.tokens;
      return reply({ n_restored: meta.tokens });
    }
    world.slotTokens = 0;
    return reply({ n_erased: 0 });
  }) as typeof fetch;
  const cache = createSlotCache({ fetchImpl, now: () => world.clock });
  const target = (over: Partial<SlotTarget> = {}): SlotTarget => ({
    origin: 'http://127.0.0.1:11435',
    model: 'qwen',
    shape: 'model-a|131072|q4_0|tpl1',
    dir,
    ...over,
  });
  /** Ход разговора: смена слота, затем запрос, наполнивший кеш до `tokens`. */
  async function turn(session: string | undefined, tokens: number, at = target()) {
    const result = await cache.prepare(session, at);
    world.slotTokens = tokens;
    cache.noteTokens(tokens);
    world.clock += 1_000;
    return result;
  }
  return { world, cache, target, turn };
}

describe('slot-cache: смена разговора', () => {
  it('тот же разговор — слот не трогается', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    world.calls = [];
    expect(await turn('A', BIG)).toBe('kept');
    expect(world.calls).toEqual([]);
  });

  it('первый разговор стирает неизвестный префикс', async () => {
    const { world, turn } = setup();
    expect(await turn('A', 10)).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });

  it('смена: длинный кеш уходящего — на диск, возврат поднимает его из файла', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    expect(await turn('B', 10)).toBe('erased');
    expect(world.calls).toContain(`save ${slotFileOf('A')}`);
    expect(existsSync(join(dir, 'A.json'))).toBe(true);
    world.calls = [];
    expect(await turn('A', 10)).toBe('restored');
    expect(world.calls).toEqual([`restore ${slotFileOf('A')}`]);
  });

  it('короткий кеш не пишется: дешевле прочитать заново', async () => {
    const { world, turn } = setup();
    await turn('A', SAVE_MIN_TOKENS - 1);
    await turn('B', 10);
    expect(world.calls.some((call) => call.startsWith('save'))).toBe(false);
  });

  it('сменился сервер (новый адрес): прежний кеш не пишется, слот стирается', async () => {
    const { world, target, turn } = setup();
    await turn('A', BIG);
    world.calls = [];
    expect(await turn('B', 10, target({ origin: 'http://127.0.0.1:40001' }))).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });

  it('файл чужого запуска не читается: слот стирается', async () => {
    const { world, target, turn } = setup();
    await turn('A', BIG);
    await turn('B', 10);
    world.calls = [];
    expect(await turn('A', 10, target({ shape: 'model-b|131072|q4_0|tpl1' }))).toBe('erased');
    expect(world.calls.some((call) => call.startsWith('restore'))).toBe(false);
  });

  it(`файлов не больше ${MAX_SLOT_FILES}: самые давние уходят`, async () => {
    const { turn } = setup();
    for (let index = 0; index <= MAX_SLOT_FILES + 1; index += 1) await turn(`S${index}`, BIG);
    const metas = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(metas).toHaveLength(MAX_SLOT_FILES);
    expect(existsSync(join(dir, 'S0.json'))).toBe(false);
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
    expect(await turn('A', 10)).toBe('erased');
    expect(world.calls).toEqual([`restore ${slotFileOf('A')}`, 'erase']);
  });

  it('сервер без каталога слотов: ничего не пишется и не читается', async () => {
    const { world, target, turn } = setup();
    await turn('A', BIG, target({ dir: undefined }));
    world.calls = [];
    expect(await turn('B', 10, target({ dir: undefined }))).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });

  it('имя файла из номера разговора без пути и чужих знаков', () => {
    expect(slotFileOf('../a b/c')).toBe('___a_b_c.bin');
  });
});

describe('slot-cache: запрос без метки разговора', () => {
  it('кеш разговора — на диск, следующий ход того же разговора поднимает его, а не «свой»', async () => {
    const { world, turn } = setup();
    await turn('A', BIG);
    expect(await turn(undefined, 50)).toBe('skipped');
    expect(world.calls).toContain(`save ${slotFileOf('A')}`);
    world.calls = [];
    expect(await turn('A', 10)).toBe('restored');
  });

  it('короткий кеш не пишется, но держатель забыт: следующий ход стирает чужой префикс', async () => {
    const { world, turn } = setup();
    await turn('A', 10);
    await turn(undefined, 50);
    world.calls = [];
    expect(await turn('A', 10)).toBe('erased');
    expect(world.calls).toEqual(['erase']);
  });
});
