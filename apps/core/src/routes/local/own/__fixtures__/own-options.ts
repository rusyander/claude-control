import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factReason, hasValue } from '../../../../platform/os-kind.ts';
import { identityOfPid } from '../../../../platform/process-identity.ts';
import type { OwnRouteOptions } from '../own.ts';
import { fakeGpu, GIB, RUNNER_BYTES } from './fake-gpu.ts';

// Настройка `local:own` над подставным маршрутизатором — одна для тестов и подставного ядра:
// перезапущенное ядро обязано видеть тот же каталог аренд, ту же память и тот же сервер.

export const ROUTER = fileURLToPath(new URL('./fake-router.mjs', import.meta.url));

/**
 * Токен старта настоящего вида для личности сервера в записи аренды на диске: старт этого
 * процесса теста (FILETIME, секунды `lstart`, тики загрузки). Сервер с ним и чужим номером —
 * мёртвый по личности, как у ядра в работе. Выдуманный токен (`'gone'`) не даёт порога поиску по
 * метке, и любой нечитаемый процесс пользователя (PowerToys) делал бы остановку недоказанной.
 */
export async function realStartToken(): Promise<string> {
  const self = await identityOfPid(process.pid);
  if (!hasValue(self)) throw new Error(`own identity unread: ${factReason(self)}`);
  return self.value.start;
}

export interface OwnDir {
  dir: string;
  vramDir: string;
  workRoot: string;
  modelPath: string;
}

export function ownDir(dir: string, create = true): OwnDir {
  const layout = {
    dir,
    vramDir: join(dir, 'vram'),
    workRoot: join(dir, 'leases'),
    modelPath: join(dir, 'model.gguf'),
  };
  if (create) {
    mkdirSync(layout.vramDir, { recursive: true });
    writeFileSync(layout.modelPath, 'GGUF fake model bytes');
  }
  return layout;
}

export function ownOptions(
  layout: OwnDir,
  mode = 'normal',
  seen?: (pid: number) => void,
): OwnRouteOptions {
  return {
    server: {
      command: process.execPath,
      leadArgs: [ROUTER],
      env: {
        FAKE_VRAM_DIR: layout.vramDir,
        FAKE_ROUTER_MODE: mode,
        FAKE_VRAM_BYTES: String(RUNNER_BYTES),
      },
    },
    models: [{ id: 'tiny-model', path: layout.modelPath, sizeBytes: 1 * GIB, contextTokens: 4096 }],
    workRoot: layout.workRoot,
    gpu: fakeGpu(layout.vramDir, seen),
    ram: () => ({ totalBytes: 32 * GIB, freeBytes: 16 * GIB }),
    settleMs: 2_000,
    loadTimeoutMs: 15_000,
  };
}
