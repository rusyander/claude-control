import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENT_MIN_CONTEXT,
  fitModel,
  recommendModel,
  type HardwareGpu,
} from '@agentdeck/contracts/local-models';
import { LocalJobs } from './jobs.ts';
import { localError } from './errors.ts';
import { blobPathOf, importStoredModel, listStoredModels, manifestPathOf, tagOf } from './store.ts';
import { benchOf, loadCatalog, pullPhase, pullProgress } from './service.ts';
import { countFetches, npmCliPath } from './qwen-code.ts';
import { assetsFor, compareVersions, parseSha256Sums, pickRuntime } from './runtime.ts';
import { parseNvidiaSmi } from './hardware.ts';
import { connectLocal, localPlatformSettings, LOCAL_PLATFORM_ID } from './connect.ts';
import { platformSchema } from '../../providers/settings-validation.ts';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-local-models-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RTX_4090: HardwareGpu = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  freeGb: 20.2,
  bandwidthGbs: 1008,
  bandwidthFrom: 'table',
};

describe('подбор модели под карту', () => {
  const catalog = loadCatalog().models;

  it('на 4090 агенту рекомендуется Qwen3.6 27B Coding целиком в видеопамяти', () => {
    const best = recommendModel(catalog, RTX_4090, 95);
    expect(best?.model.tag).toBe('qwen3.6:27b-coding');
    expect(best?.fit.level).toBe('gpu');
    expect(best?.fit.context).toBeGreaterThanOrEqual(AGENT_MIN_CONTEXT);
    // Оценка — диапазон, нижняя граница меньше верхней и обе разумны для 27B.
    const [low, high] = best?.fit.tokensPerSec ?? [0, 0];
    expect(low).toBeGreaterThan(20);
    expect(high).toBeGreaterThan(low);
  });

  it('модель, которая не зовёт инструменты, агенту не рекомендуется ни на какой карте', () => {
    const coder = catalog.find((model) => model.tag === 'qwen2.5-coder:7b');
    expect(coder).toBeDefined();
    if (!coder) return;
    const fit = fitModel(coder, RTX_4090, 95);
    expect(fit.agentReady).toBe(false);
    expect(fit.reason).toBe('no-tools');
  });

  it('на 4 ГБ годного агенту нет — подсказка промолчит, а не пообещает', () => {
    const small = { ...RTX_4090, vramGb: 4, freeGb: 3.2, bandwidthGbs: 224 };
    expect(recommendModel(catalog, small, 16)).toBeUndefined();
  });

  it('не влезающая в карту, но влезающая с оперативной памятью — «частично», с медленной оценкой', () => {
    const next = catalog.find((model) => model.tag === 'qwen3-coder-next:latest');
    if (!next) throw new Error('no qwen3-coder-next in catalog');
    const fit = fitModel(next, RTX_4090, 95);
    expect(fit.level).toBe('partial');
    expect(fit.offloadGb).toBeGreaterThan(0);
    expect(fit.agentReady).toBe(false);
  });
});

describe('хранилище моделей по файлам', () => {
  it('тег и путь манифеста переводятся туда и обратно', () => {
    const dir = temp();
    const path = manifestPathOf(dir, 'qwen3-coder:30b');
    expect(path).toBe(
      join(dir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3-coder', '30b'),
    );
    expect(manifestPathOf(dir, 'qwen3.5')).toMatch(/qwen3\.5[\\/]latest$/);
    expect(tagOf('registry.ollama.ai', ['library', 'qwen3-coder'], '30b')).toBe('qwen3-coder:30b');
    expect(tagOf('registry.ollama.ai', ['user', 'm'], 't')).toBe('user/m:t');
    expect(tagOf('hf.co', ['org', 'repo'], 'q4')).toBe('hf.co/org/repo:q4');
  });

  it('список читается без сервера; битый манифест пропускается', async () => {
    const dir = temp();
    const good = manifestPathOf(dir, 'qwen3.5:9b');
    mkdirSync(join(good, '..'), { recursive: true });
    writeFileSync(
      good,
      JSON.stringify({
        config: { digest: 'sha256:a', size: 10 },
        layers: [{ digest: 'sha256:b', size: 90 }],
      }),
    );
    const bad = manifestPathOf(dir, 'broken:x');
    mkdirSync(join(bad, '..'), { recursive: true });
    writeFileSync(bad, '{not json');
    const models = await listStoredModels(dir);
    expect(models.map((model) => [model.tag, model.sizeBytes])).toEqual([['qwen3.5:9b', 100]]);
  });

  it('перенос из системного Ollama — жёсткой ссылкой, без второй копии, манифест последним', async () => {
    const from = temp();
    const to = temp();
    const manifest = manifestPathOf(from, 'qwen3.5:4b');
    mkdirSync(join(manifest, '..'), { recursive: true });
    mkdirSync(join(from, 'blobs'), { recursive: true });
    writeFileSync(blobPathOf(from, 'sha256:c1'), 'config');
    writeFileSync(blobPathOf(from, 'sha256:w1'), 'weights!');
    writeFileSync(
      manifest,
      JSON.stringify({
        config: { digest: 'sha256:c1', size: 6 },
        layers: [{ digest: 'sha256:w1', size: 8 }],
      }),
    );
    const jobs = new LocalJobs();
    const job = jobs.start('model', 'qwen3.5:4b', (handle) =>
      importStoredModel({ fromDir: from, toDir: to, tag: 'qwen3.5:4b', handle }),
    );
    await waitFor(() => job.state !== 'running');
    expect(job.state).toBe('done');
    expect(job.doneBytes).toBe(14);
    expect((await listStoredModels(to)).map((model) => model.tag)).toEqual(['qwen3.5:4b']);
    // Та же запись на диске: у файла две ссылки, а не два файла.
    expect(statSync(blobPathOf(to, 'sha256:w1')).nlink).toBeGreaterThanOrEqual(2);
  });

  it('перенос модели без слоя падает с кодом и манифеста не оставляет', async () => {
    const from = temp();
    const to = temp();
    const manifest = manifestPathOf(from, 'qwen3.5:4b');
    mkdirSync(join(manifest, '..'), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ layers: [{ digest: 'sha256:gone', size: 8 }] }));
    const jobs = new LocalJobs();
    const job = jobs.start('model', 'qwen3.5:4b', (handle) =>
      importStoredModel({ fromDir: from, toDir: to, tag: 'qwen3.5:4b', handle }),
    );
    await waitFor(() => job.state !== 'running');
    expect(job.state).toBe('failed');
    expect(job.errorCode).toBe('local-import-failed');
    expect(existsSync(manifestPathOf(to, 'qwen3.5:4b'))).toBe(false);
  });
});

describe('работы с прогрессом', () => {
  it('вторая кнопка той же цели возвращает идущую работу, а не заводит вторую загрузку', () => {
    const jobs = new LocalJobs();
    let release: () => void = () => {};
    const work = () => new Promise<void>((done) => (release = done));
    const first = jobs.start('model', 'a', work);
    const second = jobs.start('model', 'a', work);
    expect(second.id).toBe(first.id);
    release();
  });

  it('скорость — по окну последних секунд, а не средняя с начала', () => {
    let now = 0;
    const jobs = new LocalJobs({ now: () => now });
    const job = jobs.start('model', 'b', (handle) => {
      handle.progress({ phase: 'pull', totalBytes: 1000, doneBytes: 0 });
      now = 1000;
      handle.progress({ doneBytes: 100 });
      now = 2000;
      handle.progress({ doneBytes: 300 });
      return new Promise(() => {});
    });
    expect(job.speed).toBe(150);
  });

  it('ошибка с кодом доезжает до работы кодом и параметрами', async () => {
    const jobs = new LocalJobs();
    const job = jobs.start('runtime', 'ollama', () =>
      Promise.reject(localError('local-checksum-mismatch', 'не сошлась', { name: 'x.zip' })),
    );
    await waitFor(() => job.state !== 'running');
    expect(job).toMatchObject({
      state: 'failed',
      error: 'не сошлась',
      errorCode: 'local-checksum-mismatch',
      errorParams: { name: 'x.zip' },
    });
  });

  it('отмена — состояние «отменено», а не «ошибка»', async () => {
    const jobs = new LocalJobs();
    const job = jobs.start(
      'model',
      'c',
      (handle) =>
        new Promise((_done, fail) =>
          handle.signal.addEventListener('abort', () => fail(new Error('aborted'))),
        ),
    );
    expect(jobs.cancel(job.id)).toBe(true);
    await waitFor(() => job.state !== 'running');
    expect(job.state).toBe('cancelled');
    expect(job.error).toBeUndefined();
  });
});

describe('поток загрузки и замер', () => {
  it('прогресс — сумма слоёв, этап — по строке Ollama', () => {
    const layers = new Map([
      ['a', { total: 100, completed: 50 }],
      ['b', { total: 300, completed: 0 }],
    ]);
    expect(pullProgress(layers)).toEqual({ doneBytes: 50, totalBytes: 400 });
    expect(pullPhase('pulling manifest')).toBe('manifest');
    expect(pullPhase('pulling 3ea3f9c1a1b2')).toBe('pull');
    expect(pullPhase('verifying sha256 digest')).toBe('verify');
    expect(pullPhase('success')).toBe('finish');
  });

  it('замер — токены, делённые на время генерации', () => {
    const bench = benchOf(
      { evalCount: 256, evalDurationNs: 4e9, promptCount: 100, promptDurationNs: 1e8 },
      'RTX 4090',
      new Date('2026-10-05T00:00:00Z'),
    );
    expect(bench).toEqual({
      tokensPerSec: 64,
      promptTokensPerSec: 1000,
      measuredAt: '2026-10-05T00:00:00.000Z',
      gpu: 'RTX 4090',
    });
  });
});

describe('мелочи разбора', () => {
  it('nvidia-smi: имя, объём и свободное в ГБ, пропускная способность из справочника', () => {
    const [gpu] = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564, 20684\n', [
      { name: 'RTX 4090', vendor: 'nvidia', vramGb: 24, bandwidthGbs: 1008 },
    ]);
    expect(gpu).toMatchObject({
      name: 'NVIDIA GeForce RTX 4090',
      vramGb: 24,
      freeGb: 20.2,
      bandwidthGbs: 1008,
      bandwidthFrom: 'table',
    });
  });

  it('версии, архивы выпуска и контрольные суммы', () => {
    expect(compareVersions('0.35.1', '0.32.12')).toBeGreaterThan(0);
    expect(compareVersions('v0.9.0', '0.10.0')).toBeLessThan(0);
    expect(assetsFor('win32', 'x64', [])).toEqual(['ollama-windows-amd64.zip']);
    expect(assetsFor('win32', 'x64', [{ ...RTX_4090, vendor: 'amd' }])).toContain(
      'ollama-windows-amd64-rocm.zip',
    );
    const sums = parseSha256Sums(`${'a'.repeat(64)}  ./ollama-windows-amd64.zip\n`);
    expect(sums.get('ollama-windows-amd64.zip')).toBe('a'.repeat(64));
  });

  it('системный Ollama берётся, пока человек не выбрал свою копию', () => {
    expect(pickRuntime('/sys/ollama', '/panel/ollama', false)).toEqual({
      source: 'system',
      binary: '/sys/ollama',
    });
    expect(pickRuntime('/sys/ollama', '/panel/ollama', true).source).toBe('panel');
    expect(pickRuntime('', '', false).source).toBe('none');
  });

  it('npm: путь к самому npm рядом с node; счёт пакетов по строкам журнала', () => {
    // Ответ не зависит от ОС прогона: тест идёт и на Linux, и на Windows.
    expect(npmCliPath('C:\\node\\node.exe', 'win32')).toBe(
      'C:\\node\\node_modules\\npm\\bin\\npm-cli.js',
    );
    expect(npmCliPath('/usr/local/bin/node', 'linux')).toBe(
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    );
    expect(
      countFetches(
        'npm http fetch GET 200 https://r/a 12ms\nnpm http fetch GET 304 https://r/b\nother',
      ),
    ).toBe(2);
  });

  it('контур локальной модели проходит ту же схему, что и маршрут сохранения контура', () => {
    // Схема сервера требует enabled/targets/projectPaths/caCertPath без умолчаний —
    // мастер их шлёт всегда, «Отдать агентам» не слал, и сохранение ловило 400.
    const parsed = platformSchema.safeParse(
      localPlatformSettings({
        baseUrl: 'http://127.0.0.1:11435',
        model: 'qwen3.6:27b-coding',
        title: 'Q',
        consumers: ['chat'],
      }),
    );
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      [],
    );
  });

  it('отказ маршрута контура показывается его текстом, а не голым кодом', async () => {
    const inject = async () => ({
      status: 400,
      body: { code: 'invalid_body', message: 'Запрос не принят: неверно задано enabled.' },
    });
    await expect(
      connectLocal(inject, { baseUrl: 'http://127.0.0.1:1', model: 'm', title: 't' }),
    ).rejects.toThrow('сохранение контура: Запрос не принят: неверно задано enabled.');
  });

  it('шлюз не поднялся — включение отдаёт свою красную проверку, а не 409 с кодом причины', async () => {
    const activation = { active: true, probe: { ok: false, message: 'шлюз не запущен' } };
    const inject = async (request: { method: string; url: string }) => {
      if (request.method === 'POST' && request.url.endsWith('/activate'))
        return { status: 200, body: activation };
      if (request.method === 'POST' && request.url.endsWith('/apply'))
        return {
          status: 200,
          body: { skipped: [{ targetId: 'assistant', reason: 'gateway_down' }] },
        };
      return { status: 200, body: {} };
    };
    await expect(
      connectLocal(inject, { baseUrl: 'http://127.0.0.1:1', model: 'm', title: 't' }),
    ).resolves.toEqual(activation);
  });

  it('цель ассистента пропущена по другой причине — отказ с этой причиной', async () => {
    const inject = async (request: { method: string; url: string }) =>
      request.method === 'POST' && request.url.endsWith('/apply')
        ? { status: 200, body: { skipped: [{ targetId: 'assistant', reason: 'no_token' }] } }
        : { status: 200, body: {} };
    await expect(
      connectLocal(inject, { baseUrl: 'http://127.0.0.1:1', model: 'm', title: 't' }),
    ).rejects.toThrow('no_token');
  });

  it('контур локальной модели — драйвер ollama, адрес с /v1, обязательный режим', () => {
    expect(
      localPlatformSettings({
        baseUrl: 'http://127.0.0.1:11435/',
        model: 'qwen3.5:9b',
        title: 'Q',
        consumers: ['chat'],
      }),
    ).toMatchObject({
      id: LOCAL_PLATFORM_ID,
      driver: 'ollama',
      baseUrl: 'http://127.0.0.1:11435/v1',
      mode: 'required',
      defaultModel: 'qwen3.5:9b',
      consumers: ['chat'],
    });
  });
});

async function waitFor(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
