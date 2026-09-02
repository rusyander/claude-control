import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerContext } from './context.ts';

/**
 * Переезд каталога конфигурации — всё или ничего, а ручной путь запоминается
 * там, откуда его прочитает следующий запуск.
 *
 * До правки: `location` менялся до создания хранилища (файл вместо каталога →
 * 500 и панель в разобранном состоянии), а `claudeDirOverride` писался в
 * хранилище НОВОГО каталога — при старте его никто не читал, и панель после
 * перезапуска молча возвращалась в домашний каталог.
 */
describe('ServerContext.relocate', () => {
  let root: string;
  let bootDir: string;
  let otherDir: string;
  const previousEnv = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-context-'));
    bootDir = join(root, 'boot');
    otherDir = join(root, 'other');
    mkdirSync(bootDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = bootDir;
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const bootState = (): Record<string, unknown> => {
    const path = join(bootDir, 'claude-control', 'state.json');
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
  };

  it('невалидный путь ничего не меняет', () => {
    const ctx = new ServerContext();
    const before = ctx.location.paths.root;
    const result = ctx.relocate(join(root, 'missing'));
    expect(result.isValid).toBe(false);
    expect(ctx.location.paths.root).toBe(before);
  });

  it('файл вместо каталога отклоняется до смены расположения', () => {
    const ctx = new ServerContext();
    const file = join(root, 'not-a-dir');
    writeFileSync(file, 'x');
    const store = ctx.store;
    const result = ctx.relocate(file);
    expect(result.isValid).toBe(false);
    expect(result.problem).toBeTruthy();
    expect(ctx.location.paths.root).toBe(ctx.location.paths.root);
    expect(ctx.store).toBe(store);
    expect(existsSync(join(file, 'claude-control'))).toBe(false);
  });

  it('валидный путь переезжает; ручной путь запоминается в каталоге старта', () => {
    const ctx = new ServerContext();
    const result = ctx.relocate(otherDir);
    expect(result.isValid).toBe(true);
    expect(ctx.location.paths.root).toBe(otherDir);
    expect(ctx.location.source).toBe('manual');

    ctx.rememberDirOverride(otherDir);
    const settings = bootState().settings as { claudeDirOverride?: string } | undefined;
    expect(settings?.claudeDirOverride).toBe(otherDir);
    // …и НЕ в хранилище нового каталога.
    expect(ctx.store.getSettings().claudeDirOverride).toBe('');

    // Новый контекст стартует с того же CLAUDE_CONFIG_DIR и должен оказаться в otherDir.
    const restarted = new ServerContext();
    expect(restarted.location.paths.root).toBe(otherDir);

    // Сброс — тоже в каталог старта, даже когда мы уже переехали.
    restarted.rememberDirOverride('');
    const reset = bootState().settings as { claudeDirOverride?: string } | undefined;
    expect(reset?.claudeDirOverride).toBe('');
  });

  it('возврат в каталог старта переиспользует хранилище, и настройки согласованы', () => {
    const ctx = new ServerContext();
    const bootStore = ctx.store;
    ctx.relocate(otherDir);
    ctx.rememberDirOverride(otherDir);
    // Клиент видит ручной путь в настройках, хотя текущее хранилище — чужое.
    expect(ctx.effectiveSettings().claudeDirOverride).toBe(otherDir);

    ctx.relocate('');
    ctx.rememberDirOverride('');
    expect(ctx.store).toBe(bootStore);
    expect(ctx.location.paths.root).toBe(bootDir);
    expect(ctx.effectiveSettings().claudeDirOverride).toBe('');
    expect(bootState().settings).toMatchObject({ claudeDirOverride: '' });
  });

  it('свежий каталог наследует политику удалённого доступа', () => {
    const ctx = new ServerContext();
    ctx.store.updateSettings({
      remoteAccess: { enabled: true, publicUrl: 'https://panel.example', notify: true },
    });
    ctx.relocate(otherDir);
    expect(ctx.store.getSettings().remoteAccess).toEqual({
      enabled: true,
      publicUrl: 'https://panel.example',
      notify: true,
    });
  });
});
