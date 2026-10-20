import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fitModel, modelNeedGb, type HardwareGpu } from '@agentdeck/contracts/local-models';
import { LocalJobs, type JobHandle } from './jobs.ts';
import { localPaths } from './paths.ts';
import { loadCatalog, createLocalModels } from './service.ts';
import { dirSize, manifestPathOf, blobPathOf } from './store.ts';
import { isGguf, quantNameOf, readGgufFacts, readGgufWeightType } from './gguf.ts';
import { downloadModelFile, listRepoFiles, quantIdOf, quantsOf } from './hf.ts';
import { assetsFor, fetchRelease, installPanelRuntime, loadRelease } from './runtime.ts';
import { extractArchive } from './download.ts';
import { importFileName, importOllamaModel } from './ollama-import.ts';
import {
  CPU_ONLY_ENV,
  serverArgs,
  serverEnv,
  sameShape,
  testLoadModel,
  type ServerShape,
} from './server.ts';
import { llamaClient } from './llama-client.ts';

interface Stubs {
  ggufBuffer: (options?: Record<string, unknown>) => Buffer;
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
  zipBuffer: (files: Record<string, Buffer>) => Buffer;
  sha256Of: (data: Buffer) => string;
  fakeNet: (spec: Record<string, unknown>) => {
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
    requests: { url: string; range?: string }[];
  };
  startStubLlama: (options?: Record<string, unknown>) => Promise<{
    port: number;
    calls: { path: string }[];
    close: () => Promise<void>;
  }>;
}

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-local-llama-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Прогнать работу с настоящим дескриптором прогресса и дождаться конца. */
async function runJob(work: (handle: JobHandle) => Promise<unknown>) {
  const jobs = new LocalJobs();
  const job = jobs.start('model', 'x', async (handle) => {
    await work(handle);
  });
  const deadline = Date.now() + 10_000;
  while (job.state === 'running') {
    if (Date.now() > deadline) throw new Error('job still running');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return job;
}

const SHAPE: ServerShape = {
  tag: 'qwen3.6:27b-coding',
  file: '/m/model.gguf',
  quant: 'Q4_K_M',
  context: 65_536,
  kvCache: 'q8_0',
  device: 'gpu',
  mtp: true,
  offload: 'all',
};

describe('квантования репозитория', () => {
  it('метка — из имени файла; проекторы, части и чужие файлы — не веса', () => {
    expect(quantIdOf('Qwen3.6-27B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantIdOf('Qwen3.6-27B-UD-Q4_K_M.gguf')).toBe('UD-Q4_K_M');
    expect(quantIdOf('Qwen3.6-27B-IQ3_XXS.gguf')).toBe('IQ3_XXS');
    expect(quantIdOf('Qwen3.6-27B-BF16.gguf')).toBe('BF16');
    expect(quantIdOf('Qwen3.6-27B-Q8_0.gguf')).toBe('Q8_0');
    expect(quantIdOf('mmproj-F16.gguf')).toBeUndefined();
    expect(quantIdOf('imatrix-Q4_K_M.gguf')).toBeUndefined();
    expect(quantIdOf('Qwen3.6-27B-Q4_K_M-00001-of-00002.gguf')).toBeUndefined();
    expect(quantIdOf('README.md')).toBeUndefined();
  });

  it('список — по дереву репозитория, от меньшего к большему, без пустых и не-GGUF', async () => {
    const net = stubs.fakeNet({
      repos: {
        'o/m': {
          'M-Q8_0.gguf': Buffer.alloc(900, 1),
          'M-Q4_K_M.gguf': Buffer.alloc(500, 1),
          'mmproj-F16.gguf': Buffer.alloc(100, 1),
          'README.md': Buffer.from('x'),
        },
      },
    });
    const quants = quantsOf(await listRepoFiles('o/m', net.fetchImpl));
    expect(quants.map((quant) => [quant.id, quant.sizeBytes])).toEqual([
      ['Q4_K_M', 500],
      ['Q8_0', 900],
    ]);
    expect(quants[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('репозиторий назван неверно — отказ до запроса; HTTP-ошибка — с кодом', async () => {
    const net = stubs.fakeNet({ status: { 'o/gone': 500 } });
    await expect(listRepoFiles('../etc', net.fetchImpl)).rejects.toMatchObject({
      messageCode: 'local-model-unknown',
    });
    expect(net.requests).toHaveLength(0);
    await expect(listRepoFiles('o/gone', net.fetchImpl)).rejects.toMatchObject({
      messageCode: 'local-download-http',
    });
  });
});

describe('скачивание файла модели', () => {
  const data = stubs.ggufBuffer({ padBytes: 4096 });

  it('файл ложится на место, сумма сошлась, повторный вызов ничего не качает', async () => {
    const paths = localPaths(temp(), {});
    const net = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': data } } });
    const job = await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q4_K_M.gguf',
        handle,
        fetchImpl: net.fetchImpl,
      }),
    );
    expect(job.state).toBe('done');
    const dest = join(paths.models, 'o', 'm', 'M-Q4_K_M.gguf');
    expect(readFileSync(dest).equals(data)).toBe(true);
    const before = net.requests.length;
    await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q4_K_M.gguf',
        handle,
        fetchImpl: net.fetchImpl,
      }),
    );
    // Дерево репозитория спрашивается (сумма живая), сам файл — нет.
    expect(
      net.requests.slice(before).filter((request) => request.url.includes('/resolve/')),
    ).toEqual([]);
  });

  it('обрыв докачивается с места обрыва, а не с нуля', async () => {
    const paths = localPaths(temp(), {});
    const cut = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': data } }, cutAfter: 1000 });
    const first = await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q4_K_M.gguf',
        handle,
        fetchImpl: cut.fetchImpl,
      }),
    );
    expect(first).toMatchObject({ state: 'failed', errorCode: 'local-download-cut' });
    const whole = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': data } } });
    const second = await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q4_K_M.gguf',
        handle,
        fetchImpl: whole.fetchImpl,
      }),
    );
    expect(second.state).toBe('done');
    expect(whole.requests.find((request) => request.url.includes('/resolve/'))?.range).toBe(
      'bytes=1000-',
    );
    expect(readFileSync(join(paths.models, 'o', 'm', 'M-Q4_K_M.gguf')).equals(data)).toBe(true);
  });

  it('сервер не понял Range — файл качается заново целиком, а не дописывается в хвост', async () => {
    const paths = localPaths(temp(), {});
    const cut = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': data } }, cutAfter: 1000 });
    await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q4_K_M.gguf',
        handle,
        fetchImpl: cut.fetchImpl,
      }),
    );
    const blind = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': data } }, ignoreRange: true });
    const done = await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q4_K_M.gguf',
        handle,
        fetchImpl: blind.fetchImpl,
      }),
    );
    expect(done.state).toBe('done');
    expect(readFileSync(join(paths.models, 'o', 'm', 'M-Q4_K_M.gguf')).equals(data)).toBe(true);
  });

  it('сумма не сошлась — файл удалён, код называет файл', async () => {
    const paths = localPaths(temp(), {});
    const good = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': data } } });
    // Дерево отдаёт сумму настоящего файла, а качается испорченный того же размера.
    const tampered = Buffer.from(data);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const bad = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': tampered } } });
    const fetchImpl = (url: string, init?: RequestInit) =>
      (url.includes('/resolve/') ? bad : good).fetchImpl(url, init);
    const job = await runJob((handle) =>
      downloadModelFile({ paths, repo: 'o/m', file: 'M-Q4_K_M.gguf', handle, fetchImpl }),
    );
    expect(job).toMatchObject({ state: 'failed', errorCode: 'local-checksum-mismatch' });
    expect(existsSync(join(paths.models, 'o', 'm', 'M-Q4_K_M.gguf'))).toBe(false);
  });

  it('у файла нет суммы в дереве или самого файла нет — отказ с кодом, не загрузка вслепую', async () => {
    const paths = localPaths(temp(), {});
    const net = stubs.fakeNet({ repos: { 'o/m': { 'M-Q4_K_M.gguf': { data, noLfs: true } } } });
    const noSum = await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q4_K_M.gguf',
        handle,
        fetchImpl: net.fetchImpl,
      }),
    );
    expect(noSum.errorCode).toBe('local-checksum-missing');
    const missing = await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: 'M-Q8_0.gguf',
        handle,
        fetchImpl: net.fetchImpl,
      }),
    );
    expect(missing.errorCode).toBe('local-asset-missing');
    const evil = await runJob((handle) =>
      downloadModelFile({
        paths,
        repo: 'o/m',
        file: '../x.gguf',
        handle,
        fetchImpl: net.fetchImpl,
      }),
    );
    expect(evil.errorCode).toBe('local-model-unknown');
  });
});

describe('сборка llama.cpp', () => {
  it('какие архивы нужны: CUDA по драйверу, Vulkan, Metal, процессор', () => {
    const tag = 'b11583';
    const nvidia = [{ vendor: 'nvidia' as const }];
    expect(assetsFor(tag, 'win32', 'x64', nvidia, [13, 4]).map((a) => a.name)).toEqual([
      'llama-b11583-bin-win-cuda-13.4-x64.zip',
      'cudart-llama-bin-win-cuda-13.4-x64.zip',
    ]);
    expect(assetsFor(tag, 'win32', 'x64', nvidia, [12, 8]).map((a) => a.name)).toEqual([
      'llama-b11583-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
    ]);
    expect(assetsFor(tag, 'win32', 'x64', nvidia).map((a) => a.role)).toEqual(['server', 'cudart']);
    expect(assetsFor(tag, 'win32', 'x64', [{ vendor: 'amd' }])).toEqual([
      { name: 'llama-b11583-bin-win-vulkan-x64.zip', role: 'server' },
    ]);
    expect(assetsFor(tag, 'win32', 'x64', [])[0]?.name).toBe('llama-b11583-bin-win-cpu-x64.zip');
    expect(assetsFor(tag, 'darwin', 'arm64', [])[0]?.name).toBe(
      'llama-b11583-bin-macos-arm64.tar.gz',
    );
    expect(assetsFor(tag, 'linux', 'x64', [])[0]?.name).toBe('llama-b11583-bin-ubuntu-x64.tar.gz');
    expect(assetsFor(tag, 'linux', 'x64', nvidia, [13, 4]).map((a) => a.role)).toEqual([
      'server',
      'cudart',
    ]);
  });

  it('сумма берётся из digest ассета GitHub; ассет без digest получает пустую', async () => {
    const release = loadRelease();
    const assets = { 'a.zip': Buffer.from('aaa') };
    const withSum = stubs.fakeNet({ release: { ...release, assets } });
    const info = await fetchRelease(release, withSum.fetchImpl);
    expect(info.assets[0]).toMatchObject({
      name: 'a.zip',
      size: 3,
      sha256: stubs.sha256Of(assets['a.zip']),
    });
    const without = stubs.fakeNet({ release: { ...release, assets, noDigest: true } });
    expect((await fetchRelease(release, without.fetchImpl)).assets[0]?.sha256).toBe('');
    const down = stubs.fakeNet({ status: { 'api.github.com': 403 } });
    await expect(fetchRelease(release, down.fetchImpl)).rejects.toMatchObject({
      messageCode: 'local-release-http',
    });
  });

  const gpus = [{ vendor: 'nvidia' as const }];
  const exe = 'llama-server.exe';
  const archives = () => ({
    'llama-b11583-bin-win-cuda-13.4-x64.zip': Buffer.from('server-archive'),
    'cudart-llama-bin-win-cuda-13.4-x64.zip': Buffer.from('cudart-archive'),
  });
  // Распаковка подменена: настоящая — отдельным тестом ниже.
  const fakeExtract = async (_archive: string, dest: string): Promise<void> => {
    mkdirSync(dest, { recursive: true });
    if (_archive.includes('cudart')) writeFileSync(join(dest, 'cudart64_13.dll'), 'dll');
    else writeFileSync(join(dest, exe), 'binary');
  };

  it('установка: оба архива скачаны, сверены, распакованы в один каталог, паспорт записан, архивы убраны', async () => {
    const paths = localPaths(temp(), {});
    const release = loadRelease();
    const net = stubs.fakeNet({ release: { ...release, assets: archives() } });
    let binary = '';
    const job = await runJob(async (handle) => {
      binary = await installPanelRuntime({
        paths,
        os: 'win32',
        cpu: 'x64',
        gpus,
        cuda: [13, 4],
        release,
        handle,
        fetchImpl: net.fetchImpl,
        extract: fakeExtract,
      });
    });
    expect(job.state).toBe('done');
    expect(binary).toBe(join(paths.runtime, 'llama-b11583', exe));
    expect(existsSync(join(paths.runtime, 'llama-b11583', 'cudart64_13.dll'))).toBe(true);
    expect(existsSync(join(paths.runtime, 'llama-b11583.tmp'))).toBe(false);
    expect(existsSync(join(paths.downloads, 'cudart-llama-bin-win-cuda-13.4-x64.zip'))).toBe(false);
  });

  // Linux NVIDIA: у каждого tar свой верхний каталог; libcublas вне каталога сервера не грузилась.
  it('Linux: библиотеки CUDA ложатся рядом с llama-server, а не в соседний каталог', async () => {
    const paths = localPaths(temp(), {});
    const release = loadRelease();
    const linux = {
      'llama-b11583-bin-ubuntu-cuda-13.4-x64.tar.gz': Buffer.from('server-archive'),
      'cudart-llama-b11583-bin-ubuntu-cuda-13.4-x64.tar.gz': Buffer.from('cudart-archive'),
    };
    const net = stubs.fakeNet({ release: { ...release, assets: linux } });
    // Раскладка настоящих архивов b11583: верхний каталог в каждом.
    const tarLayout = async (archive: string, dest: string): Promise<void> => {
      if (archive.includes('cudart')) {
        const top = join(dest, 'cudart-llama-b11583-bin-ubuntu-cuda-13.4-x64');
        mkdirSync(top, { recursive: true });
        writeFileSync(join(top, 'libcublas.so.13'), 'so');
      } else {
        mkdirSync(join(dest, 'llama-b11583'), { recursive: true });
        writeFileSync(join(dest, 'llama-b11583', 'llama-server'), 'binary');
      }
    };
    let binary = '';
    const job = await runJob(async (handle) => {
      binary = await installPanelRuntime({
        paths,
        os: 'linux',
        cpu: 'x64',
        gpus,
        cuda: [13, 4],
        release,
        handle,
        fetchImpl: net.fetchImpl,
        extract: tarLayout,
      });
    });
    expect(job.state).toBe('done');
    expect(existsSync(join(dirname(binary), 'libcublas.so.13'))).toBe(true);
    expect(existsSync(join(paths.runtime, 'llama-b11583', '.cudart'))).toBe(false);
  });

  it('архив с чужим содержимым — сумма не сошлась, готового каталога нет', async () => {
    const paths = localPaths(temp(), {});
    const release = loadRelease();
    const good = stubs.fakeNet({ release: { ...release, assets: archives() } });
    const tamperedAssets = archives();
    tamperedAssets['llama-b11583-bin-win-cuda-13.4-x64.zip'] = Buffer.from('server-archivX');
    const bad = stubs.fakeNet({ release: { ...release, assets: tamperedAssets } });
    const fetchImpl = (url: string, init?: RequestInit) =>
      (url.includes('github.example') ? bad : good).fetchImpl(url, init);
    const job = await runJob((handle) =>
      installPanelRuntime({
        paths,
        os: 'win32',
        cpu: 'x64',
        gpus,
        cuda: [13, 4],
        release,
        handle,
        fetchImpl,
        extract: fakeExtract,
      }),
    );
    expect(job).toMatchObject({ state: 'failed', errorCode: 'local-checksum-mismatch' });
    expect(existsSync(join(paths.runtime, 'llama-b11583'))).toBe(false);
  });

  it('выпуск без нужного файла или без суммы — отказ с кодом до загрузки', async () => {
    const paths = localPaths(temp(), {});
    const release = loadRelease();
    const missing = stubs.fakeNet({
      release: { ...release, assets: { 'other.zip': Buffer.from('x') } },
    });
    const noFile = await runJob((handle) =>
      installPanelRuntime({
        paths,
        os: 'win32',
        cpu: 'x64',
        gpus,
        cuda: [13, 4],
        release,
        handle,
        fetchImpl: missing.fetchImpl,
        extract: fakeExtract,
      }),
    );
    expect(noFile.errorCode).toBe('local-asset-missing');
    const noSums = stubs.fakeNet({ release: { ...release, assets: archives(), noDigest: true } });
    const noDigest = await runJob((handle) =>
      installPanelRuntime({
        paths,
        os: 'win32',
        cpu: 'x64',
        gpus,
        cuda: [13, 4],
        release,
        handle,
        fetchImpl: noSums.fetchImpl,
        extract: fakeExtract,
      }),
    );
    expect(noDigest.errorCode).toBe('local-sums-missing');
    expect(noSums.requests.some((request) => request.url.includes('github.example'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'распаковка zip настоящим tar системы: файл на месте',
    async () => {
      const dir = temp();
      const archive = join(dir, 'a.zip');
      writeFileSync(
        archive,
        stubs.zipBuffer({
          'llama-server.exe': Buffer.from('binary'),
          'ggml.dll': Buffer.from('lib'),
        }),
      );
      await extractArchive(archive, join(dir, 'out'), 'win32');
      expect(readFileSync(join(dir, 'out', 'llama-server.exe'), 'utf8')).toBe('binary');
      expect(readFileSync(join(dir, 'out', 'ggml.dll'), 'utf8')).toBe('lib');
    },
  );
});

describe('заголовок GGUF', () => {
  it('ключи модели читаются до словаря токенов; слой MTP виден', () => {
    const dir = temp();
    const file = join(dir, 'm.gguf');
    stubs.writeGguf(file, {
      arch: 'qwen35',
      layers: 64,
      kvHeads: 4,
      headDim: 256,
      nextn: 1,
      fullAttentionInterval: 4,
      contextLength: 262_144,
    });
    expect(isGguf(file)).toBe(true);
    expect(readGgufFacts(file)).toEqual({
      architecture: 'qwen35',
      blockCount: 64,
      contextLength: 262_144,
      headCountKv: 4,
      keyLength: 256,
      nextn: 1,
      fullAttentionInterval: 4,
      // Гибрид: сдвиг кеша невозможен (L4, `--cache-reuse` не ставится).
      recurrent: true,
      embeddingLength: 0,
      headCount: 0,
      expertCount: 0,
      expertUsed: 0,
    });
  });

  it('квантование файла читается из general.file_type и называется как в llama.cpp', () => {
    const dir = temp();
    const q4 = join(dir, 'q4.gguf');
    stubs.writeGguf(q4, { fileType: 15 });
    expect(readGgufFacts(q4)?.fileType).toBe(15);
    expect(quantNameOf(15)).toBe('Q4_K_M');
    expect(quantNameOf(7)).toBe('Q8_0');
    expect(quantNameOf(18)).toBe('Q6_K');
    expect(quantNameOf(9999)).toBeUndefined();
    const none = join(dir, 'none.gguf');
    stubs.writeGguf(none, {});
    expect(readGgufFacts(none)?.fileType).toBeUndefined();
    expect(quantNameOf(undefined)).toBeUndefined();
  });

  it('нет general.file_type (Ollama его выбрасывает) — основной тип весов по таблице тензоров', () => {
    const dir = temp();
    const file = join(dir, 'w.gguf');
    // Матрицы в основном Q4_K, немного Q6_K; одномерные нормы в F32 не считаются.
    stubs.writeGguf(file, {
      tensors: [
        { name: 'blk.0.attn_q.weight', dims: [4096, 4096], type: 12 },
        { name: 'blk.0.ffn_down.weight', dims: [4096, 1024], type: 14 },
        { name: 'blk.0.attn_norm.weight', dims: [100_000_000], type: 0 },
      ],
    });
    expect(readGgufFacts(file)?.fileType).toBeUndefined();
    expect(readGgufWeightType(file)).toBe('Q4_K');
    const q8 = join(dir, 'q8.gguf');
    stubs.writeGguf(q8, { tensors: [{ name: 'a.weight', dims: [64, 64], type: 8 }] });
    expect(readGgufWeightType(q8)).toBe('Q8_0');
    // Нет таблицы / не GGUF / неизвестный тип — «неизвестно», а не выдумка.
    const none = join(dir, 'none.gguf');
    stubs.writeGguf(none, {});
    expect(readGgufWeightType(none)).toBeUndefined();
    const odd = join(dir, 'odd.gguf');
    stubs.writeGguf(odd, { tensors: [{ name: 'a.weight', dims: [8, 8], type: 99 }] });
    expect(readGgufWeightType(odd)).toBeUndefined();
    expect(readGgufWeightType(join(dir, 'нет.gguf'))).toBeUndefined();
  });

  it('чтение останавливается на словаре токенов: то, что после него, не разбирается', () => {
    const file = join(temp(), 'v.gguf');
    stubs.writeGguf(file, { nextn: 1, brokenVocabulary: true });
    expect(readGgufFacts(file)).toMatchObject({ architecture: 'qwen35', nextn: 1 });
  });

  it('без слоя MTP — ноль; не GGUF и оборванный файл — не модель', () => {
    const dir = temp();
    const plain = join(dir, 'p.gguf');
    stubs.writeGguf(plain, { arch: 'qwen3' });
    expect(readGgufFacts(plain)?.nextn).toBe(0);
    const text = join(dir, 't.gguf');
    writeFileSync(text, 'это не модель');
    expect(isGguf(text)).toBe(false);
    expect(readGgufFacts(text)).toBeUndefined();
    const cut = join(dir, 'c.gguf');
    writeFileSync(cut, stubs.ggufBuffer().subarray(0, 40));
    expect(readGgufFacts(cut)).toBeUndefined();
    expect(readGgufFacts(join(dir, 'нет-такого.gguf'))).toBeUndefined();
  });
});

describe('запуск llama-server', () => {
  const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];

  it('все слои на карте: -ngl 999 и --fit off; кеш и окно из запуска; MTP звёздочкой не подмешивается', () => {
    const args = serverArgs({ ...SHAPE, mtp: false }, 11435);
    expect(flag(args, '-m')).toBe('/m/model.gguf');
    expect(flag(args, '--alias')).toBe('qwen3.6:27b-coding');
    expect(flag(args, '--host')).toBe('127.0.0.1');
    expect(flag(args, '--port')).toBe('11435');
    expect(flag(args, '-c')).toBe('65536');
    expect(flag(args, '-ngl')).toBe('999');
    expect(flag(args, '--fit')).toBe('off');
    expect(flag(args, '-ctk')).toBe('q8_0');
    expect(flag(args, '-ctv')).toBe('q8_0');
    expect(flag(args, '-fa')).toBe('on');
    expect(flag(args, '-np')).toBe('1');
    expect(args).toEqual(expect.arrayContaining(['--jinja', '--metrics', '--no-webui']));
    expect(args).not.toContain('--spec-type');
  });

  it('слой MTP в файле — спекулятивное декодирование; слоёв больше карты — --fit on; процессор — -ngl 0', () => {
    const mtp = serverArgs(SHAPE, 1);
    expect(flag(mtp, '--spec-type')).toBe('draft-mtp');
    expect(flag(mtp, '--spec-draft-n-max')).toBe('3');
    const fit = serverArgs({ ...SHAPE, offload: 'fit' }, 1);
    expect(flag(fit, '--fit')).toBe('on');
    expect(fit).not.toContain('-ngl');
    const cpu = serverArgs({ ...SHAPE, offload: 'none', device: 'cpu' }, 1);
    expect(flag(cpu, '-ngl')).toBe('0');
  });

  it('тот же запуск — только когда совпали модель, файл, окно, кеш, устройство, MTP и раскладка', () => {
    expect(sameShape(SHAPE, { ...SHAPE })).toBe(true);
    const changes: Partial<ServerShape>[] = [
      { tag: 'qwen3.5:9b' },
      { file: '/m/other.gguf' },
      { context: 32_768 },
      { kvCache: 'q4_0' },
      { device: 'cpu' },
      { mtp: false },
      { offload: 'fit' },
    ];
    for (const change of changes) expect(sameShape(SHAPE, { ...SHAPE, ...change })).toBe(false);
    // Метка квантования — подпись для человека: файл тот же, запуск тот же.
    expect(sameShape(SHAPE, { ...SHAPE, quant: 'renamed' })).toBe(true);
  });

  it('окружение: LLAMA_ARG_* снимаются, на процессоре карты спрятаны', () => {
    const base = { PATH: 'p', LLAMA_ARG_CTX_SIZE: '1', LLAMA_ARG_N_GPU_LAYERS: '5' };
    expect(serverEnv('gpu', base)).toEqual({ PATH: 'p' });
    expect(serverEnv('cpu', base)).toEqual({ PATH: 'p', ...CPU_ONLY_ENV });
    expect(CPU_ONLY_ENV.CUDA_VISIBLE_DEVICES).toBe('-1');
  });
});

describe('пробная загрузка GGUF', () => {
  /** Подмена процесса: при `listen` поднимает заглушку на порту из аргументов, при `crash` — выходит с текстом ошибки. */
  function fakeSpawn(mode: 'listen' | 'crash') {
    const opened: { close: () => Promise<void> }[] = [];
    const seen: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const spawnImpl = ((_bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      seen.push({ args, env: options.env });
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        unref: () => void;
      };
      child.pid = 4321;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => undefined;
      if (mode === 'listen') {
        void stubs
          .startStubLlama({ port: Number(args[args.indexOf('--port') + 1]) })
          .then((stub) => opened.push(stub));
      } else {
        setTimeout(() => {
          child.stderr.emit(
            'data',
            Buffer.from(
              "llama_model_load: error loading model: unknown model architecture: 'foo'\n",
            ),
          );
          child.emit('exit', 1);
        }, 30);
      }
      return child;
    }) as unknown as Parameters<typeof testLoadModel>[0]['spawnImpl'];
    return { spawnImpl, opened, seen };
  }

  it('файл открылся — сервер ответил на /health: на процессоре, с малым окном, без видеокарты', async () => {
    const fake = fakeSpawn('listen');
    const killed: number[] = [];
    const result = await testLoadModel({
      binary: 'llama-server',
      file: '/m/x.gguf',
      spawnImpl: fake.spawnImpl,
      kill: (child) => killed.push(child.pid ?? 0),
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true });
    const args = fake.seen[0]?.args ?? [];
    expect(args[args.indexOf('-ngl') + 1]).toBe('0');
    expect(args[args.indexOf('-c') + 1]).toBe('512');
    expect(fake.seen[0]?.env?.CUDA_VISIBLE_DEVICES).toBe('-1');
    expect(killed).toEqual([4321]);
    await Promise.all(fake.opened.map((stub) => stub.close()));
  });

  it('сервер вышел, не открыв файл — причина берётся из его же журнала', async () => {
    const fake = fakeSpawn('crash');
    const result = await testLoadModel({
      binary: 'llama-server',
      file: '/m/x.gguf',
      spawnImpl: fake.spawnImpl,
      kill: () => undefined,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain("unknown model architecture: 'foo'");
  });

  // Linux/macOS: бинарь без права на исполнение или стёртый — ошибка запуска ронял сервер панели.
  it('бинарь не запускается — причина в ответе, процесс панели жив', async () => {
    const missing = join(tmpdir(), `no-llama-server-${process.pid}`);
    const started = Date.now();
    const result = await testLoadModel({ binary: missing, file: '/m/x.gguf', timeoutMs: 20_000 });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('ENOENT');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('импорт моделей Ollama', () => {
  const TAG = 'qwen3.6:27b-coding';

  /** Хранилище Ollama с одной моделью: манифест и слой-GGUF под именем sha256-<хеш>. */
  function ollamaStore(blob: Buffer | string, tag = TAG): string {
    const store = temp();
    const manifest = manifestPathOf(store, tag);
    mkdirSync(join(manifest, '..'), { recursive: true });
    mkdirSync(join(store, 'blobs'), { recursive: true });
    writeFileSync(blobPathOf(store, 'sha256:cfg'), '{}');
    writeFileSync(blobPathOf(store, 'sha256:w'), blob);
    writeFileSync(
      manifest,
      JSON.stringify({
        config: { digest: 'sha256:cfg', size: 2 },
        layers: [
          {
            mediaType: 'application/vnd.ollama.image.model',
            digest: 'sha256:w',
            size: Buffer.byteLength(blob),
          },
        ],
      }),
    );
    return store;
  }

  it('имя файла по тегу', () => {
    expect(importFileName('qwen3.6:27b-coding')).toBe('qwen3.6-27b-coding.gguf');
    expect(importFileName('hf.co/org/repo:q4')).toBe('hf.co-org-repo-q4.gguf');
  });

  it('открылся — жёсткая ссылка на слой (одни байты, nlink 2), MTP из заголовка, слой не тронут', async () => {
    const paths = localPaths(temp(), {});
    const blob = stubs.ggufBuffer({ nextn: 1, padBytes: 512 });
    const store = ollamaStore(blob);
    const loaded: string[] = [];
    let entry;
    const job = await runJob(async (handle) => {
      entry = await importOllamaModel({
        paths,
        stores: [store],
        tag: TAG,
        handle,
        testLoad: async (file) => {
          loaded.push(file);
          return { ok: true };
        },
      });
    });
    expect(job.state).toBe('done');
    expect(entry).toMatchObject({
      file: 'ollama-import/qwen3.6-27b-coding.gguf',
      mtp: true,
      sizeBytes: blob.length,
    });
    const target = join(paths.ollamaImport, 'qwen3.6-27b-coding.gguf');
    expect(loaded).toEqual([target]);
    expect(statSync(target).nlink).toBeGreaterThanOrEqual(2);
    expect(readFileSync(blobPathOf(store, 'sha256:w')).equals(blob)).toBe(true);
    // Две ссылки — одно место на диске.
    expect(await dirSize(join(paths.ollamaImport, '..'))).toBe(blob.length);
  });

  it('llama.cpp не открыл — ссылка убрана, слой Ollama цел, код называет причину', async () => {
    const paths = localPaths(temp(), {});
    const blob = stubs.ggufBuffer({ arch: 'exotic' });
    const store = ollamaStore(blob);
    const job = await runJob((handle) =>
      importOllamaModel({
        paths,
        stores: [store],
        tag: TAG,
        handle,
        testLoad: async () => ({ ok: false, reason: 'unknown model architecture' }),
      }),
    );
    expect(job).toMatchObject({ state: 'failed', errorCode: 'local-load-failed' });
    expect(job.errorParams).toMatchObject({ reason: 'unknown model architecture' });
    expect(existsSync(join(paths.ollamaImport, 'qwen3.6-27b-coding.gguf'))).toBe(false);
    expect(readFileSync(blobPathOf(store, 'sha256:w')).equals(blob)).toBe(true);
  });

  it('слой не GGUF и тега нет в хранилище — отказ до ссылки и до пробной загрузки', async () => {
    const paths = localPaths(temp(), {});
    let tried = 0;
    const testLoad = async () => {
      tried += 1;
      return { ok: true } as const;
    };
    const notGguf = await runJob((handle) =>
      importOllamaModel({ paths, stores: [ollamaStore('plain text')], tag: TAG, handle, testLoad }),
    );
    expect(notGguf).toMatchObject({ state: 'failed', errorCode: 'local-import-failed' });
    const absent = await runJob((handle) =>
      importOllamaModel({ paths, stores: [temp()], tag: TAG, handle, testLoad }),
    );
    expect(absent).toMatchObject({ state: 'failed', errorCode: 'local-import-failed' });
    expect(tried).toBe(0);
    expect(existsSync(paths.ollamaImport) ? readdirSync(paths.ollamaImport) : []).toEqual([]);
  });

  describe('через сервис', () => {
    async function service(
      store: string,
      testLoad: Parameters<typeof createLocalModels>[0]['testLoad'],
    ) {
      const root = temp();
      const env = {
        AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
        OLLAMA_MODELS: store,
        PATH: '',
        LOCALAPPDATA: join(root, 'appdata'),
        ProgramFiles: join(root, 'programs'),
        HOME: root,
        USERPROFILE: root,
      };
      const paths = localPaths(root, env);
      const runtime = join(paths.runtime, 'llama-b11583');
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
        '',
      );
      const local = createLocalModels({
        appRoot: root,
        env,
        port: 11_498,
        run: async (cmd) => {
          if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
          throw new Error(`no ${cmd}`);
        },
        testLoad,
      });
      return { local, paths };
    }

    async function settle(local: Awaited<ReturnType<typeof service>>['local'], id: string) {
      for (let i = 0; i < 200; i += 1) {
        const job = (await local.describe()).jobs.find((item) => item.id === id);
        if (job && job.state !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('job still running');
    }

    it('системная модель предлагается, после импорта — установлена с меткой Ollama и MTP', async () => {
      const { local } = await service(ollamaStore(stubs.ggufBuffer({ nextn: 1 })), async () => ({
        ok: true,
      }));
      expect((await local.describe()).importable.map((item) => item.tag)).toEqual([TAG]);
      const job = local.importFromSystem(TAG);
      expect((await settle(local, job.id)).state).toBe('done');
      const info = await local.describe();
      expect(info.importable).toEqual([]);
      expect(info.installed.find((item) => item.tag === TAG)).toMatchObject({
        quant: 'Ollama',
        source: 'ollama',
      });
      // Ни ключа, ни таблицы тензоров — квантование неизвестно, и метки нет: экран напишет это словами,
      // а служебное «Ollama» квантованием не называется.
      expect(info.installed.find((item) => item.tag === TAG)).not.toHaveProperty('quantLabel');
      local.shutdown();
    });

    it('у файла без general.file_type квантование — тип весов по таблице тензоров', async () => {
      const { local } = await service(
        ollamaStore(
          stubs.ggufBuffer({
            nextn: 1,
            tensors: [{ name: 'blk.0.attn_q.weight', dims: [64, 64], type: 12 }],
          }),
        ),
        async () => ({ ok: true }),
      );
      const job = local.importFromSystem(TAG);
      expect((await settle(local, job.id)).state).toBe('done');
      const info = await local.describe();
      expect(info.installed.find((item) => item.tag === TAG)).toMatchObject({
        quant: 'Ollama',
        quantLabel: 'Q4_K',
      });
      local.shutdown();
    });

    it('настоящее квантование забранного файла — из заголовка GGUF', async () => {
      const { local } = await service(
        ollamaStore(stubs.ggufBuffer({ nextn: 1, fileType: 15 })),
        async () => ({ ok: true }),
      );
      const job = local.importFromSystem(TAG);
      expect((await settle(local, job.id)).state).toBe('done');
      const info = await local.describe();
      expect(info.installed.find((item) => item.tag === TAG)).toMatchObject({
        quant: 'Ollama',
        quantLabel: 'Q4_K_M',
        source: 'ollama',
      });
      local.shutdown();
    });

    it('не открылась — не в списке установленных, не предлагается повторно, причина показана', async () => {
      const { local } = await service(ollamaStore(stubs.ggufBuffer()), async () => ({
        ok: false,
        reason: 'unknown model architecture',
      }));
      const job = local.importFromSystem(TAG);
      expect((await settle(local, job.id)).state).toBe('failed');
      const info = await local.describe();
      expect(info.installed).toEqual([]);
      expect(info.importable).toEqual([]);
      expect(info.importFailed).toEqual([
        { tag: TAG, reason: expect.stringContaining('unknown model architecture') },
      ]);
      local.shutdown();
    });
  });
});

describe('место на диске', () => {
  it('файл и его жёсткая ссылка считаются один раз', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(1000));
    linkSync(join(dir, 'a.bin'), join(dir, 'b.bin'));
    writeFileSync(join(dir, 'c.bin'), Buffer.alloc(10));
    expect(await dirSize(dir)).toBe(1010);
  });
});

describe('выбор квантования в подборе', () => {
  const catalog = loadCatalog().models;
  const gpu: HardwareGpu = {
    vendor: 'nvidia',
    name: 'NVIDIA GeForce RTX 4090',
    vramGb: 24,
    freeGb: 22,
    bandwidthGbs: 1008,
    bandwidthFrom: 'table',
  };

  it('крупное квантование требует больше памяти, чем умолчание; метка не из каталога — отказ подбора', () => {
    const model = catalog.find((item) => item.tag === 'qwen3.6:27b-coding');
    if (!model) throw new Error('no 27b in catalog');
    const sorted = [...model.quants].sort((a, b) => a.sizeBytes - b.sizeBytes);
    const smallest = sorted[0];
    const largest = sorted[sorted.length - 1];
    if (!smallest || !largest) throw new Error('no quants');
    expect(largest.sizeBytes).toBeGreaterThan(smallest.sizeBytes);
    expect(modelNeedGb(model, 65_536, 'q8_0', largest.id)).toBeGreaterThan(
      modelNeedGb(model, 65_536, 'q8_0', smallest.id),
    );
    // По умолчанию — квантование каталога.
    expect(modelNeedGb(model, 65_536, 'q8_0')).toBe(
      modelNeedGb(model, 65_536, 'q8_0', model.defaultQuant),
    );
    expect(fitModel(model, gpu, 64, smallest.id).level).toBe('gpu');
    expect(fitModel(model, gpu, 64, largest.id).level).not.toBe('gpu');
  });

  it('импорт Ollama без метки в каталоге считается по умолчанию, а не падает', () => {
    const model = catalog[0];
    if (!model) throw new Error('empty catalog');
    expect(() => fitModel(model, gpu, 64, 'Ollama')).not.toThrow();
  });
});

describe('клиент llama-server на настоящем сокете', () => {
  it('health: готов, грузится (503), не слушает; замер — из timings; счёт токенов — родной', async () => {
    const stub = await stubs.startStubLlama({ tokensPerSec: 64, inputTokens: 7768 });
    const loading = await stubs.startStubLlama({ loadingMs: 60_000 });
    try {
      const client = llamaClient(`http://127.0.0.1:${stub.port}`);
      expect(await client.health()).toBe('ok');
      expect(await llamaClient(`http://127.0.0.1:${loading.port}`).health()).toBe('loading');
      const bench = await client.bench('m');
      expect(bench.evalCount / (bench.evalDurationNs / 1e9)).toBeCloseTo(64, 5);
      expect(await client.countTokens({ model: 'm', messages: [] })).toBe(7768);
      expect(await client.props()).toMatchObject({ nCtx: 65_536 });
    } finally {
      await stub.close();
      await loading.close();
    }
    expect(await llamaClient(`http://127.0.0.1:${stub.port}`).health()).toBeUndefined();
  });
});
