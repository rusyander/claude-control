import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ProjectFileError,
  StaleFileError,
  collectAgentEdits,
  listProjectDir,
  readProjectChanges,
  readProjectFile,
  readProjectMedia,
  rebuildBaseline,
  relativeToProject,
  saveProjectFile,
  type AgentEdit,
} from './project-files.ts';

/**
 * Файлы проекта: дерево, восстановление текста «до» по правкам агента и запись.
 *
 * Проверяется на НАСТОЯЩИХ файлах во временном каталоге — здесь речь о записи в
 * чужой проект, и подделка файловой системы ничего бы не доказала. Отдельно
 * закреплены три честных ограничения диффа (перезапись, потерянный фрагмент,
 * удаление): именно они отличают «дифф неполон, и мы об этом говорим» от
 * молчаливого вранья.
 */

let root = '';

/** Правка в форме, которую собирает `collectAgentEdits`. */
function edit(path: string, before: string, after: string, replaceAll = false): AgentEdit {
  return { path, before, after, replaceAll, whole: false };
}

/** Запись транскрипта с одним вызовом инструмента. */
function call(name: string, input: unknown) {
  return { message: { content: [{ type: 'tool_use', name, input }] } };
}

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-project-files-'));
});

afterEach(() => {
  dropTemp(root);
});

describe('дерево проекта', () => {
  it('каталоги идут первыми, сборочный мусор не показывается', () => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, '.gitignore'), 'dist\n');

    const tree = listProjectDir(root, '');

    expect(tree.entries.map((entry) => entry.name)).toEqual(['src', '.gitignore', 'package.json']);
    expect(tree.truncated).toBe(false);
  });

  it('вложенный каталог читается по относительному пути', () => {
    mkdirSync(join(root, 'src', 'ui'), { recursive: true });
    writeFileSync(join(root, 'src', 'ui', 'Button.tsx'), 'export const Button = 1;\n');

    const tree = listProjectDir(root, 'src/ui');

    expect(tree.dir).toBe('src/ui');
    expect(tree.entries[0]).toMatchObject({ name: 'Button.tsx', isDir: false });
    expect(tree.entries[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('выход за каталог проекта отклоняется', () => {
    expect(() => listProjectDir(root, '../..')).toThrow(ProjectFileError);
    expect(() => listProjectDir(root, 'src/../../etc')).toThrow(ProjectFileError);
  });
});

describe('правки агента из транскрипта', () => {
  it('Edit, MultiEdit и Write собираются по файлам в порядке разговора', () => {
    const target = join(root, 'src', 'app.ts');
    mkdirSync(join(root, 'src'), { recursive: true });

    const collected = collectAgentEdits(root, [
      call('Edit', { file_path: target, old_string: 'a', new_string: 'b' }),
      call('MultiEdit', {
        file_path: target,
        edits: [
          { old_string: 'c', new_string: 'd' },
          { old_string: 'e', new_string: 'f', replace_all: true },
        ],
      }),
      call('Write', { file_path: join(root, 'new.txt'), content: 'hello' }),
    ]);

    expect([...collected.byFile.keys()].sort()).toEqual(['new.txt', 'src/app.ts']);
    expect(collected.byFile.get('src/app.ts')).toHaveLength(3);
    expect(collected.byFile.get('src/app.ts')?.[2]).toMatchObject({ replaceAll: true });
    expect(collected.byFile.get('new.txt')?.[0]).toMatchObject({ whole: true, after: 'hello' });
    expect(collected.skipped).toBe(0);
  });

  it('файл вне проекта и блокнот идут в «пропущено», а не в дифф', () => {
    const collected = collectAgentEdits(root, [
      call('Edit', {
        file_path: join(tmpdir(), 'somewhere-else.ts'),
        old_string: 'a',
        new_string: 'b',
      }),
      call('NotebookEdit', { notebook_path: join(root, 'a.ipynb'), new_source: 'x' }),
      call('Read', { file_path: join(root, 'a.ts') }),
    ]);

    expect(collected.byFile.size).toBe(0);
    // Чтение вообще не файловая правка — его в счётчике быть не должно.
    expect(collected.skipped).toBe(2);
  });

  it('путь считается от корня проекта без учёта регистра диска', () => {
    const inside = join(root, 'src', 'app.ts');
    expect(relativeToProject(root, inside)).toBe('src/app.ts');
    expect(relativeToProject(root, join(root, '..', 'other.ts'))).toBeUndefined();
  });
});

describe('восстановление текста «до»', () => {
  it('обратная прокрутка возвращает исходный текст', () => {
    const before = 'const a = 1;\nconst b = 2;\n';
    const after = 'const a = 10;\nconst b = 20;\n';

    const result = rebuildBaseline(after, [
      edit('f.ts', 'const a = 1;', 'const a = 10;'),
      edit('f.ts', 'const b = 2;', 'const b = 20;'),
    ]);

    expect(result.text).toBe(before);
    expect(result.kind).toBe('exact');
    expect(result.unmatched).toBe(0);
  });

  it('replace_all откатывает все вхождения', () => {
    const result = rebuildBaseline('new new new\n', [edit('f.ts', 'old', 'new', true)]);
    expect(result.text).toBe('old old old\n');
  });

  it('перезапись файла обрывает базу: весь файл новый', () => {
    const result = rebuildBaseline('всё содержимое\n', [
      { path: 'f.ts', after: 'всё содержимое\n', replaceAll: false, whole: true },
    ]);

    expect(result.text).toBe('');
    expect(result.kind).toBe('whole-file');
  });

  it('фрагмент переписали мимо чата — правка считается несопоставленной', () => {
    const result = rebuildBaseline('совсем другой текст\n', [
      edit('f.ts', 'было', 'стало'),
      edit('f.ts', 'тоже было', 'тоже стало'),
    ]);

    expect(result.unmatched).toBe(2);
    expect(result.kind).toBe('exact');
  });

  it('удаление привязать не к чему — оно тоже несопоставлено, а не выдумано', () => {
    const result = rebuildBaseline('осталось\n', [edit('f.ts', 'убрали это\n', '')]);

    expect(result.text).toBe('осталось\n');
    expect(result.unmatched).toBe(1);
  });

  it('правок нет — сравнивать не с чем', () => {
    expect(rebuildBaseline('текст', [])).toEqual({ kind: 'none', unmatched: 0 });
  });
});

describe('чтение файла с диффом', () => {
  it('текущий текст, база и счётчики строк приходят одним ответом', () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 10;\n');

    const file = readProjectFile(root, 'a.ts', [edit('a.ts', 'const a = 1;', 'const a = 10;')]);

    expect(file.content).toBe('const a = 10;\n');
    expect(file.baseline).toBe('const a = 1;\n');
    expect(file.kind).toBe('exact');
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    expect(file.mtimeMs).toBeGreaterThan(0);
  });

  it('двоичный файл отдаётся признаком, а не текстом', () => {
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

    const file = readProjectFile(root, 'logo.png');

    expect(file.isBinary).toBe(true);
    expect(file.content).toBe('');
  });

  it('несуществующий файл — ошибка ENOENT, её маршрут превращает в 404', () => {
    expect(() => readProjectFile(root, 'nope.ts')).toThrow();
  });
});

/**
 * Показ файла не текстом. Формат определяет расширение, и проверяется тут
 * именно это: единственный способ ошибиться дорого — отдать браузеру тип
 * содержимого, которого файл не заслуживает.
 */
describe('форматы, показываемые не текстом', () => {
  it('картинка не идёт текстовым путём: пустое содержимое и признак показа', () => {
    writeFileSync(join(root, 'shot.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const file = readProjectFile(root, 'shot.PNG');

    expect(file.preview).toBe('image');
    expect(file.isBinary).toBe(true);
    expect(file.content).toBe('');
    expect(file.tooBig).toBe(false);
  });

  it('SVG и Markdown остаются текстом — их правят там же, где смотрят', () => {
    writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />');
    writeFileSync(join(root, 'README.md'), '# Заголовок\n');

    expect(readProjectFile(root, 'icon.svg')).toMatchObject({
      preview: 'svg',
      isBinary: false,
      content: '<svg xmlns="http://www.w3.org/2000/svg" />',
    });
    expect(readProjectFile(root, 'README.md')).toMatchObject({ preview: 'markdown' });
  });

  it('у обычного кода показа нет', () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
    expect(readProjectFile(root, 'a.ts').preview).toBeUndefined();
  });

  it('SVG с двоичным содержимым теряет обещание показа, а не показывает мусор', () => {
    writeFileSync(join(root, 'broken.svg'), Buffer.from([0x3c, 0x00, 0x3e]));

    const file = readProjectFile(root, 'broken.svg');

    expect(file.preview).toBeUndefined();
    expect(file.isBinary).toBe(true);
  });

  it('байты отдаются только с типом из списка, и SVG в него не входит', () => {
    writeFileSync(join(root, 'shot.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(join(root, 'doc.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    writeFileSync(join(root, 'icon.svg'), '<svg />');
    writeFileSync(join(root, 'page.html'), '<script>alert(1)</script>');

    expect(readProjectMedia(root, 'shot.png').mediaType).toBe('image/png');
    expect(readProjectMedia(root, 'doc.pdf').mediaType).toBe('application/pdf');
    expect(readProjectMedia(root, 'shot.png').bytes.length).toBe(2);

    // Оба выполняются в браузере, а адрес у панели общий — наружу не уходят.
    expect(() => readProjectMedia(root, 'icon.svg')).toThrow(ProjectFileError);
    expect(() => readProjectMedia(root, 'page.html')).toThrow(ProjectFileError);
  });

  it('выход за каталог проекта не открывается и через показ', () => {
    expect(() => readProjectMedia(root, '../secret.png')).toThrow(ProjectFileError);
  });
});

describe('сводка изменённых файлов', () => {
  it('считает строки по каждому файлу и помечает исчезнувшие', () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 10;\n');

    const changes = readProjectChanges(root, {
      byFile: new Map([
        ['a.ts', [edit('a.ts', 'const a = 1;', 'const a = 10;')]],
        ['gone.ts', [edit('gone.ts', 'x', 'y')]],
      ]),
      skipped: 1,
    });

    expect(changes.files).toEqual([
      { path: 'a.ts', added: 1, removed: 1, missing: false },
      { path: 'gone.ts', added: 0, removed: 0, missing: true },
    ]);
    expect(changes.skipped).toBe(1);
  });
});

describe('запись правки человека', () => {
  it('сохраняет содержимое и отдаёт новое время записи', () => {
    const path = join(root, 'a.ts');
    writeFileSync(path, 'было\n');
    const { mtimeMs } = statSync(path);

    const result = saveProjectFile(root, 'a.ts', 'стало\n', mtimeMs);

    expect(readFileSync(path, 'utf8')).toBe('стало\n');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('файл изменился на диске — запись отклонена, чужая работа цела', () => {
    const path = join(root, 'a.ts');
    writeFileSync(path, 'было\n');

    expect(() => saveProjectFile(root, 'a.ts', 'моё\n', 1)).toThrow(StaleFileError);
    expect(readFileSync(path, 'utf8')).toBe('было\n');
  });

  it('прежняя версия уходит в копии', () => {
    const path = join(root, 'a.ts');
    const backups = join(root, '.backups');
    writeFileSync(path, 'было\n');
    const { mtimeMs } = statSync(path);

    const result = saveProjectFile(root, 'a.ts', 'стало\n', mtimeMs, backups);

    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe('было\n');
  });

  it('запись за пределы проекта отклоняется', () => {
    expect(() => saveProjectFile(root, '../escape.ts', 'x', 0)).toThrow(ProjectFileError);
  });
});
