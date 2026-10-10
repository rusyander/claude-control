import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyProjectAccess, dropProjectAccess } from './copy-access.ts';
import { hasProjectAccess } from './copy-readiness.ts';

/**
 * Регистр в ключах `.claude.json`. На Windows `c:/work/x` и `C:/work/x` — один
 * каталог, и запись находится в любом написании. На Linux `/work/App` и
 * `/work/app` — два разных проекта: свёртка регистра там удаляла доступ соседа
 * вместе с копией и выдавала копии чужое доверие. Платформа подменяется на
 * время теста; файл `.claude.json` — настоящий, во временном каталоге.
 */
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let dir = '';
let claudeJson = '';

const onPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

const keys = (): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(claudeJson, 'utf8')) as { projects: Record<string, unknown> })
      .projects,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copy-access-'));
  claudeJson = join(dir, '.claude.json');
});

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  rmSync(dir, { recursive: true, force: true });
});

const seed = (projects: Record<string, unknown>): void =>
  writeFileSync(claudeJson, JSON.stringify({ projects }), 'utf8');

describe('регистр ключей проекта в .claude.json', () => {
  it('Linux: удаление копии не трогает проект, отличный одним регистром', () => {
    onPlatform('linux');
    seed({ '/work/app-copy': { trusted: true }, '/work/App-copy': { trusted: true } });

    expect(dropProjectAccess(claudeJson, '/work/app-copy')).toBe(true);

    expect(keys()).toEqual(['/work/App-copy']);
  });

  it('Windows: удаляются оба написания одного каталога', () => {
    onPlatform('win32');
    seed({ 'c:/work/x-copy': {}, 'C:/work/x-copy': {}, 'C:/work/other': {} });

    expect(dropProjectAccess(claudeJson, 'C:\\work\\x-copy')).toBe(true);

    expect(keys()).toEqual(['C:/work/other']);
  });

  it('Linux: доступ проверяется по точному написанию', () => {
    onPlatform('linux');
    seed({ '/work/App': { hasTrustDialogAccepted: true } });

    expect(hasProjectAccess(claudeJson, '/work/app')).toBe(false);
    expect(hasProjectAccess(claudeJson, '/work/App/')).toBe(true);
  });

  it('Windows: доступ находится в другом регистре и со слэшами Windows', () => {
    onPlatform('win32');
    seed({ 'c:/work/App': {} });

    expect(hasProjectAccess(claudeJson, 'C:\\work\\app')).toBe(true);
  });

  it('Linux: копия не берёт доверие проекта, отличного одним регистром', () => {
    onPlatform('linux');
    seed({ '/work/App': { hasTrustDialogAccepted: true } });

    const result = copyProjectAccess(claudeJson, '/work/app', '/work/app-copy');

    expect(result).toMatchObject({ copied: false, reasonCode: 'worktree-access-no-origin-entry' });
    expect(keys()).toEqual(['/work/App']);
  });
});
