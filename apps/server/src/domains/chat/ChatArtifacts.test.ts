import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  readArtifacts,
  readArtifactText,
  readArtifactBinary,
  deleteArtifact,
  chatDirectory,
  sandboxRoot,
  isSandboxPath,
} from './ChatArtifacts.ts';
import type { ArtifactKind } from './ChatArtifacts.ts';

/**
 * Тесты артефактов чата. Проверяем определение типа превью по расширению,
 * сохранение/чтение содержимого (текст и бинарь) и — отдельно — защиту от
 * обхода пути: имя файла берётся из запроса, поэтому `../` не должно давать
 * доступ к файлам за пределами папки чата.
 *
 * Каждый тест поднимает свой временный каталог в роли папки чата и убирает его
 * за собой. Функции `chatDirectory` вызываем только с `create = false`, чтобы
 * не создавать реальных папок в домашнем каталоге пользователя.
 */
describe('ChatArtifacts', () => {
  let root: string;
  let chatDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-artifacts-'));
    chatDir = join(root, 'chat');
    mkdirSync(chatDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Ищет артефакт по имени в результате readArtifacts. */
  const kindOf = (name: string): ArtifactKind | undefined =>
    readArtifacts(chatDir).find((a) => a.name === name)?.kind;

  describe('чтение списка', () => {
    it('несуществующая папка даёт пустой список', () => {
      expect(readArtifacts(join(root, 'no-such-dir'))).toEqual([]);
    });

    it('пустая папка даёт пустой список', () => {
      expect(readArtifacts(chatDir)).toEqual([]);
    });

    it('перечисляет только файлы, вложенные папки пропускаются', () => {
      writeFileSync(join(chatDir, 'page.html'), '<h1>hi</h1>');
      mkdirSync(join(chatDir, 'assets'));
      const names = readArtifacts(chatDir).map((a) => a.name);
      expect(names).toContain('page.html');
      expect(names).not.toContain('assets');
    });

    it('сортирует по времени изменения: новые сверху', () => {
      writeFileSync(join(chatDir, 'old.md'), 'старый');
      writeFileSync(join(chatDir, 'new.md'), 'новый');
      // Задаём заведомо разное время изменения, чтобы порядок был детерминирован.
      utimesSync(join(chatDir, 'old.md'), new Date('2020-01-01'), new Date('2020-01-01'));
      utimesSync(join(chatDir, 'new.md'), new Date('2025-01-01'), new Date('2025-01-01'));
      const names = readArtifacts(chatDir).map((a) => a.name);
      expect(names).toEqual(['new.md', 'old.md']);
    });

    it('заполняет размер и время изменения', () => {
      writeFileSync(join(chatDir, 'data.json'), '{"a":1}');
      const artifact = readArtifacts(chatDir).find((a) => a.name === 'data.json');
      expect(artifact?.sizeBytes).toBe(Buffer.byteLength('{"a":1}'));
      // ISO-строка времени модификации разбирается обратно в валидную дату.
      expect(Number.isNaN(Date.parse(artifact?.modifiedAt ?? ''))).toBe(false);
    });
  });

  describe('определение типа артефакта', () => {
    it('размётка и страницы распознаются по расширению', () => {
      writeFileSync(join(chatDir, 'page.html'), '');
      writeFileSync(join(chatDir, 'doc.md'), '');
      writeFileSync(join(chatDir, 'report.pdf'), '');
      expect(kindOf('page.html')).toBe('html');
      expect(kindOf('doc.md')).toBe('markdown');
      expect(kindOf('report.pdf')).toBe('pdf');
    });

    it('картинки и данные распознаются по расширению', () => {
      writeFileSync(join(chatDir, 'shot.png'), '');
      writeFileSync(join(chatDir, 'table.csv'), '');
      writeFileSync(join(chatDir, 'conf.yaml'), '');
      expect(kindOf('shot.png')).toBe('image');
      expect(kindOf('table.csv')).toBe('data');
      expect(kindOf('conf.yaml')).toBe('data');
    });

    it('исходники кода распознаются как code', () => {
      writeFileSync(join(chatDir, 'app.ts'), '');
      writeFileSync(join(chatDir, 'style.css'), '');
      writeFileSync(join(chatDir, 'query.sql'), '');
      expect(kindOf('app.ts')).toBe('code');
      expect(kindOf('style.css')).toBe('code');
      expect(kindOf('query.sql')).toBe('code');
    });

    it('неизвестное расширение — other', () => {
      writeFileSync(join(chatDir, 'blob.xyz'), '');
      expect(kindOf('blob.xyz')).toBe('other');
    });

    it('расширение распознаётся без учёта регистра', () => {
      writeFileSync(join(chatDir, 'PAGE.HTML'), '');
      expect(kindOf('PAGE.HTML')).toBe('html');
    });

    it('у картинок и PDF нет вкладки исходника, у разметки и кода — есть', () => {
      writeFileSync(join(chatDir, 'shot.png'), '');
      writeFileSync(join(chatDir, 'report.pdf'), '');
      writeFileSync(join(chatDir, 'doc.md'), '');
      writeFileSync(join(chatDir, 'app.ts'), '');
      const byName = Object.fromEntries(readArtifacts(chatDir).map((a) => [a.name, a.hasSource]));
      expect(byName['shot.png']).toBe(false);
      expect(byName['report.pdf']).toBe(false);
      expect(byName['doc.md']).toBe(true);
      expect(byName['app.ts']).toBe(true);
    });
  });

  describe('чтение текста артефакта', () => {
    it('возвращает записанное содержимое', () => {
      writeFileSync(join(chatDir, 'note.md'), '# Заголовок');
      expect(readArtifactText(chatDir, 'note.md')).toBe('# Заголовок');
    });

    it('для несуществующего файла возвращает пустую строку', () => {
      expect(readArtifactText(chatDir, 'ghost.md')).toBe('');
    });

    it('слишком большой файл (> 2 МБ) не отдаётся', () => {
      // Порог MAX_INLINE_BYTES = 2 МБ; файл чуть больше — браузеру он не нужен.
      writeFileSync(join(chatDir, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      expect(readArtifactText(chatDir, 'huge.txt')).toBe('');
    });

    it('файл ровно на границе отдаётся', () => {
      writeFileSync(join(chatDir, 'edge.txt'), Buffer.alloc(2 * 1024 * 1024, 0x61));
      expect(readArtifactText(chatDir, 'edge.txt')).toHaveLength(2 * 1024 * 1024);
    });
  });

  describe('чтение бинарного артефакта', () => {
    it('возвращает записанные байты как есть', () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // сигнатура PNG
      writeFileSync(join(chatDir, 'img.png'), bytes);
      expect(readArtifactBinary(chatDir, 'img.png')?.equals(bytes)).toBe(true);
    });

    it('для несуществующего файла возвращает undefined', () => {
      expect(readArtifactBinary(chatDir, 'ghost.png')).toBeUndefined();
    });
  });

  // ── Безопасность: обход пути через имя файла ──
  describe('безопасность имени файла', () => {
    it('текстовый обход ../ не даёт прочитать файл за пределами папки чата', () => {
      // Секрет кладём в родителя папки чата.
      writeFileSync(join(root, 'secret.txt'), 'СЕКРЕТ');
      const leaked = readArtifactText(chatDir, '../secret.txt');
      // Имя схлопывается до basename → ищется secret.txt внутри chatDir, где его
      // нет: содержимое родителя не утекает.
      expect(leaked).toBe('');
      expect(leaked).not.toContain('СЕКРЕТ');
    });

    it('бинарный обход ../ не даёт прочитать файл за пределами папки чата', () => {
      writeFileSync(join(root, 'secret.bin'), Buffer.from([1, 2, 3]));
      expect(readArtifactBinary(chatDir, '../secret.bin')).toBeUndefined();
    });

    it('вложенный обход ../../ тоже усекается до имени', () => {
      writeFileSync(join(root, 'deep.txt'), 'НАРУЖУ');
      expect(readArtifactText(chatDir, '../../deep.txt')).toBe('');
    });
  });

  // ── Удаление артефакта ──
  describe('удаление артефакта', () => {
    it('удаляет файл из папки чата и возвращает true', () => {
      writeFileSync(join(chatDir, 'draft.md'), 'черновик');
      expect(deleteArtifact(chatDir, 'draft.md')).toBe(true);
      expect(existsSync(join(chatDir, 'draft.md'))).toBe(false);
    });

    it('для несуществующего файла возвращает false', () => {
      expect(deleteArtifact(chatDir, 'ghost.md')).toBe(false);
    });

    it('папку не удаляет', () => {
      mkdirSync(join(chatDir, 'assets'));
      expect(deleteArtifact(chatDir, 'assets')).toBe(false);
      expect(existsSync(join(chatDir, 'assets'))).toBe(true);
    });

    it('обход ../ не даёт удалить файл за пределами папки чата', () => {
      // Секрет — в родителе папки чата. Имя схлопывается до basename, поэтому
      // удаление ищет secret.txt внутри chatDir (где его нет) и родителя не трогает.
      writeFileSync(join(root, 'secret.txt'), 'СЕКРЕТ');
      expect(deleteArtifact(chatDir, '../secret.txt')).toBe(false);
      expect(existsSync(join(root, 'secret.txt'))).toBe(true);
    });

    it('вложенный обход ../../ тоже усекается до имени', () => {
      writeFileSync(join(root, 'deep.txt'), 'НАРУЖУ');
      expect(deleteArtifact(chatDir, '../../deep.txt')).toBe(false);
      expect(existsSync(join(root, 'deep.txt'))).toBe(true);
    });
  });

  // ── Песочница и папка чата ──
  describe('песочница', () => {
    it('sandboxRoot лежит под .claude-control/chats', () => {
      const rootPath = sandboxRoot();
      expect(rootPath.includes(join('.claude-control', 'chats'))).toBe(true);
    });

    it('isSandboxPath: сам корень и вложенные пути распознаются', () => {
      expect(isSandboxPath(sandboxRoot())).toBe(true);
      expect(isSandboxPath(join(sandboxRoot(), 'abc', 'page.html'))).toBe(true);
    });

    it('isSandboxPath: путь вне песочницы отклоняется', () => {
      expect(isSandboxPath(tmpdir())).toBe(false);
      expect(isSandboxPath(chatDir)).toBe(false);
    });

    it.runIf(process.platform === 'win32')(
      'isSandboxPath на Windows нечувствителен к регистру',
      () => {
        // Один и тот же каталог в транскрипте пишется с разным регистром буквы
        // диска — свою папку всё равно надо опознавать как песочницу.
        expect(isSandboxPath(join(sandboxRoot(), 'x').toUpperCase())).toBe(true);
      },
    );

    it('chatDirectory(create=false) не создаёт папку и остаётся внутри песочницы', () => {
      const dir = chatDirectory('my-chat-123', false);
      expect(dir).toBe(join(sandboxRoot(), 'my-chat-123'));
      expect(isSandboxPath(dir)).toBe(true);
    });

    it('chatDirectory вычищает из id всё, кроме [a-zA-Z0-9-] — обход невозможен', () => {
      // «../../evil» после чистки превращается в «evil», внутри песочницы.
      const dir = chatDirectory('../../evil', false);
      expect(dir).toBe(join(sandboxRoot(), 'evil'));
      expect(isSandboxPath(dir)).toBe(true);
      // Разделителей пути в хвосте не осталось.
      expect(dir.slice(sandboxRoot().length + 1).includes(sep)).toBe(false);
    });
  });
});
