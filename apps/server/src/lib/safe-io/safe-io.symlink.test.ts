import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  statSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTextFile, writeBinaryFile } from './safe-io.ts';

/**
 * Запись СКВОЗЬ символическую ссылку (#69).
 *
 * Атомарная запись — это rename поверх цели, а rename поверх ссылки заменяет её
 * обычным файлом: `~/.claude/CLAUDE.md`, заведённый ссылкой в dotfiles-репозиторий,
 * после первой же правки из панели переставал бы быть ссылкой, и репозиторий молча
 * расходился бы с тем, что читает Claude Code.
 *
 * Только POSIX: под Windows создание ссылки требует прав/режима разработчика, а
 * chmod там no-op — тесты пропускаются, а не удаляются.
 */
describe('safe-io: запись сквозь символическую ссылку', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-symlink-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const posix = process.platform !== 'win32';

  it.skipIf(!posix)('ссылка остаётся ссылкой, а меняется её цель', () => {
    const store = join(dir, 'dotfiles');
    mkdirSync(store);
    const real = join(store, 'CLAUDE.md');
    writeFileSync(real, 'старое\n', 'utf8');
    const link = join(dir, 'CLAUDE.md');
    symlinkSync(real, link);

    writeTextFile(link, 'новое\n');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('новое\n');
    expect(readFileSync(link, 'utf8')).toBe('новое\n');
    // Временный файл не остался ни рядом со ссылкой, ни рядом с целью.
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toHaveLength(0);
    expect(readdirSync(store).filter((name) => name.includes('.tmp-'))).toHaveLength(0);
  });

  it.skipIf(!posix)('права цели сохраняются: секрет-ссылка остаётся 0600', () => {
    const store = join(dir, 'dotfiles');
    mkdirSync(store);
    const real = join(store, 'secrets.env');
    writeFileSync(real, 'TOKEN=1\n', 'utf8');
    chmodSync(real, 0o600);
    const link = join(dir, '.mcp-secrets.env');
    symlinkSync(real, link);

    writeTextFile(link, 'TOKEN=2\n');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readFileSync(real, 'utf8')).toBe('TOKEN=2\n');
  });

  it.skipIf(!posix)('битая ссылка: файл создаётся там, куда она ведёт', () => {
    const store = join(dir, 'dotfiles');
    mkdirSync(store);
    const real = join(store, 'settings.json');
    const link = join(dir, 'settings.json');
    symlinkSync(real, link); // цели ещё нет

    writeTextFile(link, '{"a":1}\n');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('{"a":1}\n');
  });

  it.skipIf(!posix)('двоичная запись тоже идёт в цель ссылки', () => {
    const store = join(dir, 'dotfiles');
    mkdirSync(store);
    const real = join(store, 'image.png');
    writeFileSync(real, Buffer.from([0x00, 0x01]));
    const link = join(dir, 'image.png');
    symlinkSync(real, link);

    writeBinaryFile(link, Buffer.from([0x02, 0x03]));

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect([...readFileSync(real)]).toEqual([0x02, 0x03]);
  });

  it('обычный файл (не ссылка) пишется как прежде', () => {
    const path = join(dir, 'plain.json');
    writeFileSync(path, '{}', 'utf8');
    writeTextFile(path, '{"b":2}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"b":2}\n');
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
  });
});
