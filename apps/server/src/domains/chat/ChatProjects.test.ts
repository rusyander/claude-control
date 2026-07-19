import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { listProjects } from './ChatProjects.ts';

/**
 * Тесты перечисления проектов. Ключевое: список выводится из истории чатов,
 * поэтому проекты и чаты не расходятся; песочницы панели и временные черновики
 * агента в список не попадают; один каталог не двоится; помечается, существует
 * ли он ещё на диске. Тест-кейсы см. .agent/TEST-CASES.md → «Проекты чата».
 */
describe('listProjects', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-projects-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  /** Пишет транскрипт (одна сессия) в каталог проекта Claude Code. */
  function writeTranscript(
    projectFolder: string,
    session: string,
    cwd: string,
    opts: { title?: string; mtime?: Date } = {},
  ): void {
    const dir = join(projectsDir, projectFolder);
    mkdirSync(dir, { recursive: true });
    const ts = '2026-07-18T10:00:00.000Z';
    const lines = [
      {
        type: 'user',
        uuid: `${session}-u`,
        timestamp: ts,
        cwd,
        message: { role: 'user', content: 'привет' },
      },
      opts.title
        ? { type: 'ai-title', uuid: `${session}-t`, timestamp: ts, cwd, aiTitle: opts.title }
        : null,
      {
        type: 'assistant',
        uuid: `${session}-a`,
        timestamp: ts,
        cwd,
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'ответ' }],
        },
      },
    ].filter(Boolean);

    const file = join(dir, `${session}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (opts.mtime) utimesSync(file, opts.mtime, opts.mtime);
  }

  it('группирует чаты по каталогу проекта без дублей', () => {
    // Существующий каталог используем как «настоящий проект».
    const real = mkdtempSync(join(tmpdir(), 'cc-realproj-'));
    try {
      writeTranscript('enc-real-1', 's1', real, { mtime: new Date('2026-07-18T10:00:00Z') });
      writeTranscript('enc-real-2', 's2', real, { mtime: new Date('2026-07-18T12:00:00Z') });

      const projects = listProjects(projectsDir);
      expect(projects).toHaveLength(1);
      expect(projects[0]?.path).toBe(real);
      expect(projects[0]?.chats.map((c) => c.id).sort()).toEqual(['s1', 's2']);
      // Последняя активность — максимум по чатам проекта.
      expect(projects[0]?.lastActivity).toBe(new Date('2026-07-18T12:00:00Z').toISOString());
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('помечает несуществующий каталог как отсутствующий', () => {
    writeTranscript('enc-gone', 'g1', 'C:/work/удалённый-проект');
    const projects = listProjects(projectsDir);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.exists).toBe(false);
  });

  it('песочницы панели в список проектов не попадают', () => {
    const sandboxCwd = join(homedir(), '.claude-control', 'chats', 'new-123');
    writeTranscript('enc-sandbox', 'sb1', sandboxCwd);
    expect(listProjects(projectsDir)).toEqual([]);
  });

  it('временные черновики агента отсеиваются', () => {
    const scratch = join(tmpdir(), 'claude', 'abc', 'scratchpad');
    writeTranscript('enc-temp', 't1', scratch);
    expect(listProjects(projectsDir)).toEqual([]);
  });

  it('устаревшая песочница под другим корнем тоже отсеивается', () => {
    // Каталог песочницы мог смениться — старый путь isSandboxPath уже не узнаёт,
    // но по устойчивому признаку claude-control/chats/new- он всё равно отсеивается.
    writeTranscript('enc-old-sb', 'osb', 'C:/Users/x/.claude/claude-control/chats/new-123');
    expect(listProjects(projectsDir)).toEqual([]);
  });

  it('служебные подкаталоги (.agent, скриншоты) проектами не считаются', () => {
    writeTranscript('enc-agent', 'a1', 'C:/work/app/.agent');
    writeTranscript('enc-shots', 'sh1', 'C:/work/app/e2e/screenshots/before-after/x');
    expect(listProjects(projectsDir)).toEqual([]);
  });

  it('несуществующая папка проектов → пустой список', () => {
    expect(listProjects(join(projectsDir, 'нет-такой'))).toEqual([]);
  });

  it('сортирует проекты по свежести последней активности', () => {
    const older = mkdtempSync(join(tmpdir(), 'cc-older-'));
    const newer = mkdtempSync(join(tmpdir(), 'cc-newer-'));
    try {
      writeTranscript('enc-older', 'o1', older, { mtime: new Date('2026-07-10T10:00:00Z') });
      writeTranscript('enc-newer', 'n1', newer, { mtime: new Date('2026-07-18T10:00:00Z') });

      const projects = listProjects(projectsDir);
      expect(projects.map((p) => p.path)).toEqual([newer, older]);
    } finally {
      rmSync(older, { recursive: true, force: true });
      rmSync(newer, { recursive: true, force: true });
    }
  });
});
