import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OwnRouteOptions } from '../own.ts';
import { fakeGpu, GIB, RUNNER_BYTES } from './fake-gpu.ts';

// Настройка `local:own` над подставным маршрутизатором — одна для тестов и подставного ядра:
// перезапущенное ядро обязано видеть тот же каталог аренд, ту же память и тот же сервер.

export const ROUTER = fileURLToPath(new URL('./fake-router.mjs', import.meta.url));

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
