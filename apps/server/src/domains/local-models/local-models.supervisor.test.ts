import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ON_DEMAND_BACKOFF_MS, ON_DEMAND_MAX, createLocalModels, loadCatalog } from './service.ts';
import { localPaths, updateState } from './paths.ts';
import { IDLE_SLEEP_SECONDS, readRecord, type ServerShape } from './server.ts';
import { HUNG_AFTER_MISSES, MAX_RESTARTS } from './supervisor.ts';
import { modelFilePath } from './hf.ts';
import type { FetchLike } from './download.ts';

/**
 * Присмотр за сервером на настоящем сервисе (L4b): запись о сервере, подъём по ней и
 * сообщение карточки — настоящие; подменены сеть до llama-server, запуск процесса и
 * «жив ли номер процесса». Шлюз приходит сюда через `upstream(model).revive()`.
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_498;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

let root: string;
let up: boolean;
let nextPid: number;
let alive: Set<number>;
let spawned: number;
/** Запуск не удаётся: процесс сразу выходит с кодом. */
let crashOnStart: boolean;
/** Через сколько снятый процесс «уходит»; 0 — сразу. */
let killDelayMs = 0;
/** Что падающий запуск пишет в журнал сервера — как llama-server перед выходом. */
let crashLine = '';
/** Часы сервиса: пауза между неудачными подъёмами по запросу. */
let clock = 1_000_000;
/** Что отвечает `nvidia-smi`: имя, всего и свободно, МиБ. */
let smi = 'NVIDIA GeForce RTX 4090, 24564, 22868';
/** Ответ `GET /slots`; нет — 404, как у сервера без каталога слотов. */
let slots: unknown;

const net: FetchLike = async (input) => {
  if (!String(input).startsWith(`http://127.0.0.1:${PORT}`)) throw new TypeError('fetch failed');
  if (!up) throw new TypeError('fetch failed');
  if (String(input).endsWith('/health')) return Response.json({ status: 'ok' });
  if (String(input).endsWith('/slots') && slots !== undefined) return Response.json(slots);
  return new Response('{}', { status: 404 });
};

const ENV = (): NodeJS.ProcessEnv => ({
  AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
  PATH: '',
  LOCALAPPDATA: join(root, 'appdata'),
  ProgramFiles: join(root, 'programs'),
  HOME: root,
  USERPROFILE: root,
});

function service(extra: Partial<Parameters<typeof createLocalModels>[0]> = {}) {
  return createLocalModels({
    ...extra,
    appRoot: root,
    env: ENV(),
    port: PORT,
    fetchImpl: net,
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return `${smi}\n`;
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, _args: string[]) => {
      spawned += 1;
      const pid = nextPid++;
      if (crashOnStart) {
        if (crashLine) appendFileSync(localPaths(root, ENV()).serverLog, `${crashLine}\n`);
        return {
          pid,
          once: (event: string, callback: (code: number) => void) => {
            if (event === 'exit') callback(1);
          },
          unref: () => undefined,
        };
      }
      up = true;
      alive.add(pid);
      return { pid, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      up = false;
      // Снятый процесс отпускает порт не сразу: окно, в котором человек успевает нажать «Стоп».
      if (killDelayMs > 0) setTimeout(() => alive.delete(pid), killDelayMs).unref();
      else alive.delete(pid);
    },
    supervise: { pidAlive: (pid) => alive.has(pid) },
    now: () => clock,
  });
}

function seededShape(paths: ReturnType<typeof localPaths>): ServerShape {
  const model = loadCatalog().models.find((item) => item.tag === TAG);
  if (!model) throw new Error('27B not in catalog');
  const quant = model.quants.find((item) => item.id === model.defaultQuant);
  if (!quant) throw new Error('default quant missing');
  return {
    tag: TAG,
    file: modelFilePath(paths, model.repo, quant.file),
    quant: quant.id,
    context: 65_536,
    kvCache: 'q8_0',
    device: 'gpu',
    mtp: true,
    offload: 'all',
    idleSeconds: IDLE_SLEEP_SECONDS,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-supervisor-'));
  spawned = 0;
  nextPid = 7_000;
  alive = new Set();
  crashOnStart = false;
  killDelayMs = 0;
  crashLine = '';
  clock = 1_000_000;
  smi = 'NVIDIA GeForce RTX 4090, 24564, 22868';
  slots = undefined;
  up = false;
  const paths = localPaths(root, ENV());
  const runtimeDir = join(paths.runtime, 'llama-b11583');
  // Окно 65536 — выбор человека (как у владельца): умолчание каталога выросло до 131072 (L6),
  // а эти проверки — о перезапуске и присмотре, не о подборе окна.
  updateState(paths, (state) => {
    state.choices[TAG] = { context: 65_536 };
  });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, BINARY), '');
  const shape = seededShape(paths);
  stubs.writeGguf(shape.file, { nextn: 1 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function startedAndKilled(local: ReturnType<typeof service>): Promise<number> {
  await local.startServer({ tag: TAG });
  const record = readRecord(localPaths(root, ENV()));
  if (!record) throw new Error('no record after start');
  // Сервер падает: порт закрыт, процесса нет, запись о нём остаётся.
  up = false;
  alive.delete(record.pid);
  return record.pid;
}

describe('сервер моделей упал — присмотр поднимает его по записи', () => {
  it('шлюз просит подъём: сервер стартует заново теми же параметрами, окно не меняется', async () => {
    const local = service();
    const before = await startedAndKilled(local);
    const info = local.upstream(TAG);
    expect(info).toBeDefined();
    const outcome = await info?.revive();
    expect(outcome).toBe('restarted');
    expect(spawned).toBe(2);
    const record = readRecord(localPaths(root, ENV()));
    expect(record?.pid).not.toBe(before);
    expect(record?.context).toBe(65_536);
    expect(record?.tag).toBe(TAG);
    expect(up).toBe(true);
    // Сообщение видно карточке сервера.
    expect((await local.describe()).server.notice).toMatchObject({ kind: 'restarted' });
  });

  it('сервер остановлен человеком — присмотр его не поднимает; поднимает только запрос чата (L6)', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    await local.stopServer();
    expect(spawned).toBe(1);
    expect(readRecord(localPaths(root, ENV()))).toBeUndefined();
    // Шлюз получает окно ДО подъёма — выбор человека, не пустоту и не «нет связи».
    const info = local.upstream(TAG);
    expect(info?.context).toBe(65_536);
    // Запрос чата на эту модель поднимает сервер сам, одним подъёмом на два одновременных запроса.
    const [first, second] = await Promise.all([info?.revive(), info?.revive()]);
    expect([first, second]).toEqual(['restarted', 'restarted']);
    expect(spawned).toBe(2);
    expect(readRecord(localPaths(root, ENV()))).toMatchObject({ tag: TAG, context: 65_536 });
    expect(up).toBe(true);
  });

  it('сервер не запущен с самого начала — первый запрос чата поднимает его, ошибка подъёма идёт шлюзу (L6)', async () => {
    const local = service();
    // Скачанного файла нет и сервера нет — подымать нечего, шлюзу по-прежнему пусто.
    expect(local.upstream('other:1b')).toBeUndefined();
    crashOnStart = true;
    const info = local.upstream(TAG);
    expect(info).toBeDefined();
    expect(await info?.revive()).toBe('failed');
    expect(info?.notice()).toContain(`1 из ${ON_DEMAND_MAX}`);
    // Повтор сразу (Claude Code повторяет 529 без конца) — пауза, модель не грузится заново.
    expect(await info?.revive()).toBe('capped');
    expect(spawned).toBe(1);
    crashOnStart = false;
    clock += ON_DEMAND_BACKOFF_MS;
    expect(await info?.revive()).toBe('restarted');
    expect(spawned).toBe(2);
  });

  it('подъём по запросу падает раз за разом — после потолка модель больше не грузится, отказ называет причину из журнала (ревью M1)', async () => {
    const local = service();
    crashOnStart = true;
    crashLine =
      'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 21504.00 MiB on device 0: cudaMalloc failed: out of memory';
    const info = local.upstream(TAG);
    for (let i = 0; i < ON_DEMAND_MAX; i += 1) {
      expect(await info?.revive()).toBe('failed');
      clock += 10 * 60_000;
    }
    // Всю ночь повторов — ни одного нового запуска.
    for (let i = 0; i < 20; i += 1) {
      clock += 10 * 60_000;
      expect(await info?.revive()).toBe('capped');
    }
    expect(spawned).toBe(ON_DEMAND_MAX);
    expect(info?.notice()).toContain('больше не запускает');
    expect(info?.notice()).toContain('cudaMalloc failed: out of memory');
    // Человек запустил сам — отказ снят.
    crashOnStart = false;
    await local.startServer({ tag: TAG });
    expect(spawned).toBe(ON_DEMAND_MAX + 1);
    expect(info?.notice()).toBeUndefined();
  });

  it('жив и отвечает — шлюз получает «alive», второго процесса нет', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    expect(await local.upstream(TAG)?.revive()).toBe('alive');
    expect(spawned).toBe(1);
  });

  it('подъём не удаётся: после трёх попыток — потолок, причина в сообщении карточки и в тексте для шлюза', async () => {
    const local = service();
    await startedAndKilled(local);
    crashOnStart = true;
    const info = local.upstream(TAG);
    for (let i = 0; i < MAX_RESTARTS; i += 1) expect(await info?.revive()).toBe('failed');
    expect(await info?.revive()).toBe('capped');
    // Попыток запуска ровно потолок: четвёртая не делается.
    expect(spawned).toBe(1 + MAX_RESTARTS);
    expect(info?.notice()).toContain('не поднялся после');
    const shown = (await local.describe()).server.notice;
    expect(shown).toMatchObject({ kind: 'gave-up', restarts: MAX_RESTARTS });
    expect(shown?.reason).toBeTruthy();
  });

  it('человек запускает сервер сам — потолок сброшен, сообщение снято', async () => {
    const local = service();
    await startedAndKilled(local);
    crashOnStart = true;
    const info = local.upstream(TAG);
    for (let i = 0; i < MAX_RESTARTS + 1; i += 1) await info?.revive();
    crashOnStart = false;
    await local.startServer({ tag: TAG });
    expect((await local.describe()).server.notice).toBeUndefined();
    expect(info?.notice()).toBeUndefined();
  });
});

describe('«Стоп» человека посреди подъёма зависшего сервера (L4c, F4)', () => {
  it('процесс жив, /health молчит; присмотр снимает его и ждёт порт; Стоп в этом окне — сервер не поднимается', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    const info = local.upstream(TAG);
    // Зависший: порт молчит, процесс жив. Снятие отпускает его не сразу — окно ожидания порта.
    up = false;
    for (let i = 0; i < HUNG_AFTER_MISSES - 1; i += 1) expect(await info?.revive()).toBe('alive');
    killDelayMs = 700;
    const spawnedBefore = spawned;
    const recovery = info?.revive();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await local.stopServer();
    const outcome = await recovery;
    expect(outcome).toBe('none');
    expect(spawned).toBe(spawnedBefore);
    expect(readRecord(localPaths(root, ENV()))).toBeUndefined();
    expect((await local.describe()).server.notice).toBeUndefined();
  });
});

/** Ждать, пока условие станет верным (таймеры присмотра настоящие, сроки — доли секунды). */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('ревью L6: окно до подъёма, слой прогона, застывший слот', () => {
  it('окно до подъёма — то, с которым сервер и поднимется: подбор под эту карту, а не умолчание каталога (m2)', async () => {
    smi = 'NVIDIA GeForce RTX 4080, 16376, 15900';
    updateState(localPaths(root, ENV()), (state) => {
      delete state.choices[TAG];
    });
    const local = service();
    await local.refreshHardware();
    const info = local.upstream(TAG);
    const planned = info?.context;
    expect(planned).toBeLessThan(131_072);
    expect(await info?.revive()).toBe('restarted');
    expect(readRecord(localPaths(root, ENV()))?.context).toBe(planned);
    expect(info?.context).toBe(planned);
  });

  it('слой не влезает в окно сервера: числа и одно действие — в состоянии чата, на карточке сервера и после перезапуска панели (B1)', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    const info = local.upstream(TAG);
    info?.layer(73_254);
    expect((await local.activity()).layer).toMatchObject({
      tokens: 73_254,
      context: 65_536,
      limit: 61_440,
      fits: false,
      fix: { context: 98_304 },
    });
    expect((await local.describe()).server.layer).toMatchObject({ tokens: 73_254, fits: false });
    // Подагент или служебный запрос несёт слой меньше основного — основной не прячется.
    info?.layer(9_000);
    expect((await local.activity()).layer?.tokens).toBe(73_254);
    // Сервер остановлен, панель перезапущена: замер из файла состояния виден до первого хода.
    await local.stopServer();
    const fresh = service();
    expect((await fresh.activity()).layer).toMatchObject({
      tokens: 73_254,
      context: 65_536,
      fits: false,
    });
  });

  it('окно подняли до предложенного — предупреждения нет (B1)', async () => {
    const local = service();
    local.upstream(TAG)?.layer(73_254);
    expect((await local.activity()).layer?.fits).toBe(false);
    await local.setChoice({ tag: TAG, context: 98_304 });
    expect((await local.activity()).layer).toMatchObject({ context: 98_304, fits: true });
    expect((await local.activity()).layer?.fix).toBeUndefined();
  });

  it('нынешнее квантование такое окно на карту не вынесет — действие называет квантование, которое вынесет (B1)', async () => {
    // Linux: занятое не вытесняется, свободно 18,5 ГиБ.
    smi = 'NVIDIA GeForce RTX 4090, 24564, 18944';
    const local = service({ os: 'linux' });
    local.upstream(TAG)?.layer(73_254);
    const layer = (await local.activity()).layer;
    expect(layer?.fits).toBe(false);
    expect(layer?.fix?.context).toBe(98_304);
    const model = loadCatalog().models.find((item) => item.tag === TAG);
    const sizeOf = (id: string | undefined): number =>
      model?.quants.find((quant) => quant.id === id)?.sizeBytes ?? 0;
    expect(layer?.fix?.quant).toBeTruthy();
    expect(sizeOf(layer?.fix?.quant)).toBeLessThan(sizeOf(model?.defaultQuant));
  });

  it('слот застыл посреди разбора при живом /health — сервер перезапускается теми же параметрами (m5, onWedged)', async () => {
    const sample = JSON.parse(
      readFileSync(new URL('./__fixtures__/slots-b11583.json', import.meta.url), 'utf8'),
    ) as { prompt: unknown };
    slots = sample.prompt;
    const local = service({ activity: { intervalMs: 20, stallMs: () => 200 } });
    await local.startServer({ tag: TAG });
    const before = readRecord(localPaths(root, ENV()))?.pid;
    const track = local.upstream(TAG)?.watch(1_000);
    await until(() => spawned === 2 && up);
    expect(track?.signal.aborted).toBe(true);
    const after = readRecord(localPaths(root, ENV()));
    expect(after?.pid).not.toBe(before);
    expect(after?.context).toBe(65_536);
    expect(after?.tag).toBe(TAG);
    expect(up).toBe(true);
    local.shutdown();
  });
});
