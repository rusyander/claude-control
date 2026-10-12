import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PackageJsonShape, PackageManager } from '../project-runner.types.ts';

/**
 * package.json цели: имя, скрипт запуска и пакетный менеджер. Отдельно от
 * `stack.ts`, потому что их читают и детектор Node, и список целей.
 */

/** Содержимое package.json каталога; при отсутствии/битом файле — undefined. */
export function readPackageJson(dir: string): PackageJsonShape | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

/**
 * Пакетный менеджер проекта.
 *
 * Сначала поле `packageManager` (`"pnpm@9.1.0"`) — это corepack, то есть прямое
 * указание автора проекта, и оно точнее любой догадки. Дальше lock-файл. В
 * монорепе и то и другое лежит в КОРНЕ, а запускаем мы из подпапки, поэтому от
 * каталога цели поднимаемся вверх до `stopAt` включительно — иначе у любого
 * пакета монорепы получался бы npm независимо от того, чем проект живёт.
 * Ничего не нашли — npm: он есть везде, где есть Node.
 */
export function detectPackageManager(dir: string, stopAt?: string): PackageManager {
  const top = resolve(stopAt ?? dir);
  let current = resolve(dir);
  for (;;) {
    const declared = readPackageJson(current)?.packageManager;
    if (typeof declared === 'string') {
      const name = declared.split('@')[0]?.trim();
      if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name;
    }
    // pnpm-workspace.yaml бывает в git, а lock-файл — далеко не всегда, поэтому
    // он тоже считается признаком: без этого монорепа на pnpm запускалась бы npm.
    if (
      existsSync(join(current, 'pnpm-lock.yaml')) ||
      existsSync(join(current, 'pnpm-workspace.yaml')) ||
      existsSync(join(current, 'pnpm-workspace.yml'))
    ) {
      return 'pnpm';
    }
    if (existsSync(join(current, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(current, 'package-lock.json'))) return 'npm';
    if (current === top) break;
    const up = dirname(current);
    if (up === current) break;
    current = up;
  }
  return 'npm';
}

/** Скрипт запуска: `dev`, иначе `start`, иначе ничего. */
export function detectRunScript(dir: string): 'dev' | 'start' | undefined {
  const scripts = readPackageJson(dir)?.scripts ?? {};
  if (scripts.dev) return 'dev';
  if (scripts.start) return 'start';
  return undefined;
}
