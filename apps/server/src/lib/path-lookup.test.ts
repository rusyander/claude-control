import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posixPathMatches } from './path-lookup.mjs';

/**
 * Поиск команды на macOS и Linux без внешнего `which`: в базовом Arch и образах
 * Fedora его нет, и прежний поиск отвечал «не найдено» на любой CLI. Разбор
 * PATH — на подменённой проверке файла; права и ссылки — на настоящей ФС POSIX
 * (CI на Linux), на Windows их не проверить: там у файлов нет бита исполнения.
 */
describe('posixPathMatches: разбор PATH', () => {
  const onDisk =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it('все копии по порядку PATH, как `which -a`', () => {
    const exec = onDisk('/home/u/.local/bin/claude', '/usr/bin/claude');
    expect(posixPathMatches('claude', '/home/u/.local/bin:/usr/local/bin:/usr/bin', exec)).toEqual([
      '/home/u/.local/bin/claude',
      '/usr/bin/claude',
    ]);
  });

  it('пустые элементы PATH не значат «текущий каталог», повтор каталога — одна копия', () => {
    const seen: string[] = [];
    const exec = (path: string) => {
      seen.push(path);
      return path === '/usr/bin/qwen';
    };
    expect(posixPathMatches('qwen', ':/usr/bin::/usr/bin/:', exec)).toEqual(['/usr/bin/qwen']);
    expect(seen.every((path) => path.startsWith('/'))).toBe(true);
  });

  it('имя с косой — путь: PATH не нужен', () => {
    expect(
      posixPathMatches('/opt/codex/bin/codex', '/usr/bin', onDisk('/opt/codex/bin/codex')),
    ).toEqual(['/opt/codex/bin/codex']);
    expect(posixPathMatches('./codex', '/usr/bin', onDisk())).toEqual([]);
  });

  it('нет нигде, пустое имя, пустой PATH — пусто', () => {
    expect(posixPathMatches('gemini', '/usr/bin:/bin', onDisk())).toEqual([]);
    expect(posixPathMatches('', '/usr/bin', () => true)).toEqual([]);
    expect(posixPathMatches('gemini', '', () => true)).toEqual([]);
  });
});

describe.runIf(process.platform !== 'win32')('posixPathMatches: настоящая ФС POSIX', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('исполняемый файл и ссылка на него — да; файл без +x и каталог с тем же именем — нет', () => {
    const root = mkdtempSync(join(tmpdir(), 'path-lookup-'));
    dirs.push(root);
    const [exe, plain, folder, link] = ['exe', 'plain', 'folder', 'link'].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      return dir;
    });
    writeFileSync(join(exe!, 'tool'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(exe!, 'tool'), 0o755);
    writeFileSync(join(plain!, 'tool'), 'not a program\n');
    chmodSync(join(plain!, 'tool'), 0o644);
    mkdirSync(join(folder!, 'tool'));
    symlinkSync(join(exe!, 'tool'), join(link!, 'tool'));

    expect(posixPathMatches('tool', [plain, folder, link, exe].join(':'))).toEqual([
      join(link!, 'tool'),
      join(exe!, 'tool'),
    ]);
    expect(posixPathMatches('tool', [plain, folder].join(':'))).toEqual([]);
  });
});
