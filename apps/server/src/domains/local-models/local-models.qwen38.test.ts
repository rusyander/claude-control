import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { recommendModel, type HardwareGpu } from '@agentdeck/contracts/local-models';
import { createLocalModels, loadCatalog, templatePath } from './service.ts';
import { localPaths } from './paths.ts';
import { IDLE_SLEEP_SECONDS, readRecord, sameShape, serverArgs } from './server.ts';
import { modelFilePath } from './hf.ts';
import type { FetchLike } from './download.ts';

/**
 * Qwen3.8 27B в каталоге (15.10): рекомендуется агенту на 24 ГБ, Qwen3.6 27B Coding —
 * следующая по порядку (запасная). У 3.8 рассуждение по умолчанию `xhigh`, поэтому
 * каталог несёт `reasoning_effort: medium`, и он доходит до аргументов llama-server.
 * Сервис, подбор и запись о сервере — настоящие; подменены сеть и запуск процесса.
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const Q38 = 'qwen3.8:27b';
const Q36 = 'qwen3.6:27b-coding';
const PORT = 11_497;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const KWARGS = '{"reasoning_effort":"medium"}';
const RTX_4090: HardwareGpu = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  freeGb: 22.3,
  bandwidthGbs: 1008,
  bandwidthFrom: 'table',
};

let root: string;
let up: boolean;
let spawned: string[][];
let killed: number[];

const fakeServerNet: FetchLike = async (input) => {
  if (!String(input).startsWith(`http://127.0.0.1:${PORT}`)) throw new TypeError('fetch failed');
  if (!up) throw new TypeError('fetch failed');
  if (String(input).endsWith('/health')) return Response.json({ status: 'ok' });
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

function service() {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    fetchImpl: fakeServerNet,
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, args: string[]) => {
      spawned.push(args);
      up = true;
      return { pid: 4242, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      killed.push(pid);
      up = false;
    },
  });
}

/** Модель «скачана»: настоящий заголовок GGUF со слоем MTP, квантование по умолчанию. */
function seed(tag: string): string {
  const model = loadCatalog().models.find((item) => item.tag === tag);
  const quant = model?.quants.find((item) => item.id === model.defaultQuant);
  if (!model || !quant) throw new Error(`${tag} not in catalog`);
  const file = modelFilePath(localPaths(root, ENV()), model.repo, quant.file);
  stubs.writeGguf(file, { nextn: 1 });
  return file;
}

const after = (args: string[], flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-q38-'));
  spawned = [];
  killed = [];
  up = false;
  const runtimeDir = join(localPaths(root, ENV()).runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, BINARY), '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Qwen3.8 27B в каталоге', () => {
  const catalog = loadCatalog().models;

  it('запись: репозиторий unsloth, UD-IQ4_XS по умолчанию (ревью L6), окно как у 3.6, MTP, reasoning_effort medium', () => {
    const model = catalog.find((item) => item.tag === Q38);
    expect(model?.repo).toBe('unsloth/Qwen3.8-27B-GGUF');
    expect(model?.defaultQuant).toBe('UD-IQ4_XS');
    expect(model?.sizeBytes).toBe(14_252_845_984);
    // Окно по умолчанию — то же, что у 3.6 Coding: одна политика окна для плотных 27B.
    expect(model?.defaultContext).toBe(catalog.find((item) => item.tag === Q36)?.defaultContext);
    expect(model?.mtp).toBe(true);
    expect(model?.agentic).toBe(true);
    expect(model?.chatTemplateKwargs).toEqual({ reasoning_effort: 'medium' });
    // У прочих моделей каталога параметров шаблона нет: флаг не уходит чужим моделям.
    expect(catalog.filter((item) => item.chatTemplateKwargs).map((item) => item.tag)).toEqual([
      Q38,
    ]);
  });

  it('на 4090 агенту рекомендуется 3.8, без неё — 3.6 Coding (запасная)', () => {
    expect(recommendModel(catalog, RTX_4090, 95)?.model.tag).toBe(Q38);
    const without = catalog.filter((item) => item.tag !== Q38);
    expect(recommendModel(without, RTX_4090, 95)?.model.tag).toBe(Q36);
  });

  it('запуск 3.8: --chat-template-kwargs с medium и MTP; у 3.6 флага нет', async () => {
    seed(Q38);
    seed(Q36);
    const local = service();
    await local.startServer({ tag: Q38 });
    const args38 = spawned.at(-1) ?? [];
    expect(after(args38, '--chat-template-kwargs')).toBe(KWARGS);
    expect(after(args38, '--spec-type')).toBe('draft-mtp');
    expect(readRecord(localPaths(root, ENV()))?.templateKwargs).toBe(KWARGS);
    await local.startServer({ tag: Q36 });
    expect(spawned.at(-1)).not.toContain('--chat-template-kwargs');
  });

  it('запуск 3.8: свой шаблон чата файлом, он есть на диске и принимает системное сообщение не в начале; у 3.6 флага нет', async () => {
    seed(Q38);
    seed(Q36);
    const local = service();
    await local.startServer({ tag: Q38 });
    const file = after(spawned.at(-1) ?? [], '--chat-template-file');
    expect(file).toBe(templatePath('qwen3.8.jinja'));
    expect(existsSync(file ?? '')).toBe(true);
    // Claude Code шлёт блок окружения системным сообщением после первого пользовательского;
    // шаблон из GGUF на нём бросал исключение, и каждый запрос получал 500.
    const text = readFileSync(file ?? '', 'utf8');
    expect(text).not.toContain("raise_exception('System message must be at the beginning.')");
    expect(text).toContain('{%- if message.role == "system" or message.role == "developer" %}');
    expect(readRecord(localPaths(root, ENV()))?.templateFile).toBe(file);
    await local.startServer({ tag: Q36 });
    expect(spawned.at(-1)).not.toContain('--chat-template-file');
  });

  it('каждый шаблон, названный каталогом, лежит в data/templates', () => {
    const named = catalog.flatMap((item) => (item.chatTemplate ? [item.chatTemplate] : []));
    expect(named).toContain('qwen3.8.jinja');
    for (const name of named) expect(existsSync(templatePath(name))).toBe(true);
  });

  it('сервер, поднятый без своего шаблона, — другой запуск: перезапуск его подхватит', () => {
    const shape = {
      tag: Q38,
      file: 'm.gguf',
      quant: 'UD-Q4_K_XL',
      context: 131_072,
      kvCache: 'q8_0' as const,
      device: 'gpu' as const,
      mtp: true,
      offload: 'all' as const,
      templateFile: templatePath('qwen3.8.jinja'),
    };
    const { templateFile: _dropped, ...old } = shape;
    expect(sameShape(old, shape)).toBe(false);
    expect(sameShape(shape, { ...shape })).toBe(true);
  });

  it('сервер 3.8, поднятый прежней панелью без параметров шаблона, перезапускается; второй вызов его не трогает', async () => {
    seed(Q38);
    const paths = localPaths(root, ENV());
    // Запись такая, какую оставила бы прежняя панель: тот же запуск, что выберет сервис, но без параметров шаблона.
    // Два запуска: первый без своего сервера считает память иначе (кеш может лечь в q4_0), второй — устоявшийся.
    const warm = service();
    await warm.startServer({ tag: Q38 });
    await warm.startServer({ tag: Q38 });
    const fresh = readRecord(paths);
    if (!fresh) throw new Error('no record');
    const { templateKwargs: _dropped, ...old } = fresh;
    writeFileSync(paths.pidFile, JSON.stringify({ ...old, pid: 999_999_998 }));
    spawned = [];
    killed = [];
    up = true;
    const local = service();
    await local.startServer({ tag: Q38 });
    expect(killed).toEqual([999_999_998]);
    expect(spawned).toHaveLength(1);
    await local.startServer({ tag: Q38 });
    expect(spawned).toHaveLength(1);
  });

  it('шаблон в данных обновился, пока сервер шёл: панель после запуска перезапустит его, когда прогонов нет', async () => {
    seed(Q38);
    const paths = localPaths(root, ENV());
    const warm = service();
    await warm.startServer({ tag: Q38 });
    await warm.startServer({ tag: Q38 });
    const fresh = readRecord(paths);
    if (!fresh?.templateHash) throw new Error('no template hash in record');
    // Тот же сервер, но поднятый с прежним содержимым шаблона.
    writeFileSync(paths.pidFile, JSON.stringify({ ...fresh, templateHash: 'before-update' }));
    spawned = [];
    up = true;
    const local = service();
    expect(local.restartPending()).toBe(true);
    expect(local.upstream(Q38)?.deferredInline).toBe(false);
    expect(await local.applyPending()).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(readRecord(paths)?.templateHash).toBe(fresh.templateHash);
    expect(local.upstream(Q38)?.deferredInline).toBe(true);
    // Шаблон тот же — после следующего запуска панели ждать нечего.
    expect(service().restartPending()).toBe(false);
  });

  it('сервер шёл с прежним сроком простоя: панель после запуска перезапустит его, карточка до того показывает прежний', async () => {
    seed(Q38);
    const paths = localPaths(root, ENV());
    const warm = service();
    await warm.startServer({ tag: Q38 });
    await warm.startServer({ tag: Q38 });
    const fresh = readRecord(paths);
    if (!fresh) throw new Error('no record');
    writeFileSync(paths.pidFile, JSON.stringify({ ...fresh, idleSeconds: 600 }));
    spawned = [];
    up = true;
    const local = service();
    expect(local.restartPending()).toBe(true);
    expect((await local.describe()).server.idleSeconds).toBe(600);
    expect(await local.applyPending()).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(readRecord(paths)?.idleSeconds).toBe(IDLE_SLEEP_SECONDS);
    expect(service().restartPending()).toBe(false);
  });

  it('serverArgs: JSON отдельным аргументом, без него флага нет', () => {
    const shape = {
      tag: Q38,
      file: 'm.gguf',
      quant: 'UD-Q4_K_M',
      context: 65_536,
      kvCache: 'q8_0' as const,
      device: 'gpu' as const,
      mtp: true,
      offload: 'all' as const,
    };
    expect(
      after(serverArgs({ ...shape, templateKwargs: KWARGS }, PORT), '--chat-template-kwargs'),
    ).toBe(KWARGS);
    expect(serverArgs(shape, PORT)).not.toContain('--chat-template-kwargs');
  });
});
