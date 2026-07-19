import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolveWorkspace, permissionModeFor } from './ChatWorkspace.ts';

/**
 * Тесты выбора рабочей папки чата. Ключевое для мультипроектной среды: новый
 * разговор, открытый из проекта, ведётся в каталоге проекта (targetCwd), а не в
 * песочнице; при этом права по умолчанию — только чтение. Известная сессия
 * targetCwd игнорирует: её нельзя увести из родного каталога.
 * Тест-кейсы см. .agent/TEST-CASES.md → «Рабочая папка чата».
 *
 * create=false везде, где не нужна настоящая папка: иначе тест насорил бы в
 * ~/.claude-control.
 */
describe('resolveWorkspace', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('новый чат без проекта → папка песочницы, isSandbox', () => {
    const ws = resolveWorkspace(projectsDir, 'new-1', undefined, false);
    expect(ws.isSandbox).toBe(true);
    expect(ws.isMissing).toBe(false);
  });

  it('новый чат с существующим каталогом проекта → cwd проекта, не песочница', () => {
    const project = mkdtempSync(join(tmpdir(), 'cc-proj-'));
    try {
      const ws = resolveWorkspace(projectsDir, 'new-2', undefined, false, project);
      expect(ws.cwd).toBe(project);
      expect(ws.isSandbox).toBe(false);
      expect(ws.isMissing).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('новый чат с исчезнувшим каталогом проекта → isMissing', () => {
    const ws = resolveWorkspace(projectsDir, 'new-3', undefined, false, 'C:/nope/gone-project');
    expect(ws.isMissing).toBe(true);
  });

  it('targetCwd внутри песочницы всё равно опознаётся как песочница', () => {
    const sandbox = join(homedir(), '.claude-control', 'chats', 'new-x');
    const ws = resolveWorkspace(projectsDir, 'new-4', undefined, false, sandbox);
    expect(ws.isSandbox).toBe(true);
  });

  it('известная сессия ведётся в свой каталог и игнорирует targetCwd', () => {
    // Кладём транскрипт с cwd — по нему findSessionCwd восстановит папку.
    const realCwd = mkdtempSync(join(tmpdir(), 'cc-known-'));
    try {
      const dir = join(projectsDir, 'enc');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'sess.jsonl'),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-18T10:00:00.000Z',
          cwd: realCwd,
          message: { role: 'user', content: 'привет' },
        }) + '\n',
      );

      const ws = resolveWorkspace(projectsDir, 'sess', 'sess', false, 'C:/other/path');
      expect(ws.cwd).toBe(realCwd);
    } finally {
      rmSync(realCwd, { recursive: true, force: true });
    }
  });

  describe('permissionModeFor', () => {
    it('песочница → acceptEdits (её файлы и есть результат)', () => {
      expect(permissionModeFor({ cwd: 'x', isSandbox: true, isMissing: false })).toBe(
        'acceptEdits',
      );
    });

    it('проект без разрешения → default (только чтение)', () => {
      expect(permissionModeFor({ cwd: 'x', isSandbox: false, isMissing: false })).toBe('default');
    });

    it('проект с разрешением правок → acceptEdits', () => {
      expect(permissionModeFor({ cwd: 'x', isSandbox: false, isMissing: false }, true)).toBe(
        'acceptEdits',
      );
    });
  });
});
