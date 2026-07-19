import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isSupportedUpload, saveUpload, buildPromptWithFiles } from './ChatUploads.ts';
import type { UploadedFile } from './ChatUploads.ts';

/**
 * Тесты вложений чата. Главный упор — на безопасность имени файла: имя приходит
 * из запроса, поэтому попытка «выйти» из папки чата через `../` или абсолютный
 * путь не должна привести к записи за её пределы. Дополнительно закрываем
 * определение поддерживаемых типов и корректный подсчёт размера.
 *
 * Каждый тест поднимает свой временный каталог (роль рабочей папки чата) и
 * убирает его за собой — настоящая конфигурация пользователя не затрагивается.
 */
describe('ChatUploads', () => {
  let root: string;
  let chatDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-uploads-'));
    // Папку чата держим вложенной, чтобы у «..» было куда пытаться убежать.
    chatDir = join(root, 'chat');
    mkdirSync(chatDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

  describe('поддерживаемые типы', () => {
    it('PDF/PNG/MD принимаются', () => {
      expect(isSupportedUpload('report.pdf')).toBe(true);
      expect(isSupportedUpload('screenshot.png')).toBe(true);
      expect(isSupportedUpload('notes.md')).toBe(true);
    });

    it('расширение сверяется без учёта регистра', () => {
      expect(isSupportedUpload('SCAN.PDF')).toBe(true);
      expect(isSupportedUpload('Photo.PNG')).toBe(true);
    });

    it('запрещённые типы отклоняются', () => {
      // Исполняемые/архивы Claude Code читать не умеет — их быть не должно.
      expect(isSupportedUpload('virus.exe')).toBe(false);
      expect(isSupportedUpload('archive.zip')).toBe(false);
      expect(isSupportedUpload('installer.dmg')).toBe(false);
      expect(isSupportedUpload('script.bat')).toBe(false);
    });

    it('файл без расширения не поддерживается', () => {
      expect(isSupportedUpload('README')).toBe(false);
    });
  });

  describe('сохранение и чтение обратно', () => {
    it('содержимое из base64 пишется на диск и читается тем же', () => {
      const saved = saveUpload(chatDir, 'hello.md', b64('привет, мир'));
      expect(existsSync(saved.path)).toBe(true);
      expect(readFileSync(saved.path, 'utf8')).toBe('привет, мир');
    });

    it('размер отдаётся в реальных байтах декодированного содержимого', () => {
      const content = 'привет, мир'; // в UTF-8 больше символов из-за кириллицы
      const expectedBytes = Buffer.byteLength(content, 'utf8');
      const saved = saveUpload(chatDir, 'note.txt', b64(content));
      expect(saved.sizeBytes).toBe(expectedBytes);
      expect(statSync(saved.path).size).toBe(expectedBytes);
    });

    it('в имени остаются только безопасные символы', () => {
      // Спецсимволы (в т.ч. попытка инъекции команды) заменяются на «_»,
      // расширение при этом сохраняется.
      const saved = saveUpload(chatDir, 'evil name;$(rm -rf).png', b64('x'));
      expect(saved.name).toMatch(/^[a-zA-Z0-9._\- ]+$/);
      expect(saved.name.endsWith('.png')).toBe(true);
      expect(saved.name).not.toContain(';');
      expect(saved.name).not.toContain('$');
    });
  });

  // ── Безопасность имени файла (path traversal) ──
  describe('безопасность имени файла', () => {
    it('относительный обход ../../ остаётся внутри папки чата', () => {
      const saved = saveUpload(chatDir, '../../evil.txt', b64('pwned'));
      // Файл лёг ровно в папку чата, а не в её родителя.
      expect(saved.path).toBe(join(chatDir, 'evil.txt'));
      expect(existsSync(join(chatDir, 'evil.txt'))).toBe(true);
      // За пределами папки чата ничего не появилось.
      expect(existsSync(join(root, 'evil.txt'))).toBe(false);
    });

    it('POSIX-абсолютный путь усекается до имени файла', () => {
      const saved = saveUpload(chatDir, '/etc/passwd', b64('x'));
      expect(saved.path).toBe(join(chatDir, 'passwd'));
      expect(existsSync(join(chatDir, 'passwd'))).toBe(true);
    });

    it('Windows-абсолютный путь усекается до имени файла', () => {
      const saved = saveUpload(chatDir, 'C:\\Windows\\System32\\evil.dll', b64('x'));
      // Разделители пути в имени недопустимы — берётся только последний сегмент.
      expect(saved.path).toBe(join(chatDir, 'evil.dll'));
      expect(existsSync(join(chatDir, 'evil.dll'))).toBe(true);
    });

    it('имя, оканчивающееся на «..», не пишет файл в родительскую папку', () => {
      // basename тут вернул бы «..», что указывает на каталог; запись файла
      // туда невозможна. Проверяем, что родитель уцелел как каталог и что
      // никакого «сбежавшего» файла рядом с папкой чата не появилось.
      const before = new Set<string>(readdirSync(root));
      try {
        saveUpload(chatDir, 'sub/..', b64('x'));
      } catch {
        // EISDIR/EPERM — ожидаемо: писать в каталог нельзя.
      }
      expect(statSync(root).isDirectory()).toBe(true);
      const after = new Set<string>(readdirSync(root));
      // Никаких новых записей в родителе (кроме уже бывшей папки chat).
      expect([...after].filter((n) => !before.has(n))).toEqual([]);
    });
  });

  describe('buildPromptWithFiles', () => {
    it('без вложений возвращает исходный промпт как есть', () => {
      expect(buildPromptWithFiles('привет', [])).toBe('привет');
    });

    it('перечисляет пути приложенных файлов в промпте', () => {
      const files: UploadedFile[] = [
        { name: 'a.pdf', path: join(chatDir, 'a.pdf'), sizeBytes: 1 },
        { name: 'b.png', path: join(chatDir, 'b.png'), sizeBytes: 2 },
      ];
      const prompt = buildPromptWithFiles('опиши', files);
      expect(prompt).toContain('опиши');
      expect(prompt).toContain(join(chatDir, 'a.pdf'));
      expect(prompt).toContain(join(chatDir, 'b.png'));
    });
  });
});
