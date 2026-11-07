import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalModels } from './service.ts';
import { localPaths } from './paths.ts';
import type { ServerRecord } from './server.ts';

/**
 * «Что делает локальная модель» (`activity()`) судит застой по пределу тишины ЭТОГО сервера:
 * процессор законно молчит дольше видеокарты. Устройство сервис берёт из записи запущенного
 * сервера — без него процессорный сервер судился бы пределом карты и показывался «застрял»
 * раньше времени. Сервис настоящий; запись сервера лежит в файле, как её пишет запуск.
 */

let root: string;
const ENV = (): NodeJS.ProcessEnv => ({
  AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
  PATH: '',
  HOME: root,
  USERPROFILE: root,
});

function seedRecord(device: 'cpu' | 'gpu'): void {
  const paths = localPaths(root, ENV());
  const record: ServerRecord = {
    tag: 'qwen3.6:27b-coding',
    file: join(root, 'model.gguf'),
    quant: 'IQ4_XS',
    context: 65_536,
    kvCache: 'q8_0',
    device,
    mtp: false,
    offload: 'all',
    idleSeconds: 0,
    pid: 4_242,
    port: 11_498,
    binary: join(root, 'llama-server'),
    startedAt: 1,
  };
  mkdirSync(dirname(paths.pidFile), { recursive: true });
  writeFileSync(paths.pidFile, JSON.stringify(record));
}

function service() {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    run: async (cmd) => {
      throw new Error(`no ${cmd}`);
    },
    supervise: { pidAlive: () => true },
    coreEvents: () => undefined,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-activity-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('предел тишины локального сервера по его устройству', () => {
  it('сервер на процессоре — 10 минут тишины, а не 2 минуты карты', async () => {
    seedRecord('cpu');
    const activity = await service().activity();
    expect(activity.model).toBe('qwen3.6:27b-coding');
    // Предел процессора по контракту ленты звена (`HOP_STALL_CPU_MS`) — 600 000 мс.
    expect(activity.stallMs).toBe(600_000);
  });

  it('сервер на видеокарте — предел карты, 2 минуты', async () => {
    seedRecord('gpu');
    const activity = await service().activity();
    expect(activity.stallMs).toBe(120_000);
  });
});
