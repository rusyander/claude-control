import { describe, it, expect } from 'vitest';
import {
  SCRIPT_TEMPLATES,
  NEW_SCRIPT_TEMPLATE,
  GENERIC_SCRIPT_TEMPLATE,
  GENERIC_SCRIPT_TEMPLATES,
  scriptTemplatesFor,
  newScriptTemplateFor,
} from './ScriptTemplate';

/**
 * Заготовки скриптов хуков.
 *
 * Сами по себе это константы, и тестировать в них нечего — кроме одного:
 * содержимое лежит в шаблонной строке, а внутри неё обратный слеш имеет своё
 * значение. Из-за этого шаблон «Страж команды» однажды уже собирал нерабочую
 * защиту: `\s` превращался в `s`, и созданный пользователем скрипт искал
 * буквально «rms+-rf» вместо `rm\s+-rf`, то есть пропускал ровно то, ради
 * чего его заводили. Ошибка тихая — файл создаётся, выглядит правильно и не
 * срабатывает. Поэтому регулярки из заготовок проверяются в деле.
 */

/** Достаёт из текста скрипта регулярку, на которой он принимает решение. */
function regexpFrom(content: string): RegExp {
  const line = content.split('\n').find((item) => item.includes('.test('));
  if (!line) throw new Error('в заготовке нет проверки .test()');

  const match = /\/(.+?)\/([a-z]*)\.test/.exec(line);
  if (!match?.[1]) throw new Error(`не удалось разобрать регулярку: ${line.trim()}`);

  return new RegExp(match[1], match[2]);
}

function templateBy(id: string): string {
  const template = SCRIPT_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error(`нет заготовки ${id}`);
  return template.content;
}

describe('заготовка «Страж команды»', () => {
  it('ловит рекурсивное удаление', () => {
    expect(regexpFrom(templateBy('guard')).test('rm -rf /data')).toBe(true);
  });

  it('ловит удаление таблицы', () => {
    expect(regexpFrom(templateBy('guard')).test('DROP TABLE users')).toBe(true);
  });

  it('срабатывает независимо от регистра', () => {
    expect(regexpFrom(templateBy('guard')).test('Rm  -rf /tmp')).toBe(true);
  });

  it('пропускает безобидную команду', () => {
    expect(regexpFrom(templateBy('guard')).test('ls -la')).toBe(false);
  });

  it('в тексте скрипта сохранён именно \\s, а не съеденный слеш', () => {
    // Прямая проверка того, что ломалось: в файл должно уйти `rm\s+-rf`.
    expect(templateBy('guard')).toContain(String.raw`rm\s+-rf`);
    expect(templateBy('guard')).not.toContain('rms+-rf');
  });
});

describe('заготовка «Форматирование после правки»', () => {
  it('ловит файлы поддерживаемых типов', () => {
    const pattern = regexpFrom(templateBy('format'));
    expect(pattern.test('src/app/a.tsx')).toBe(true);
    expect(pattern.test('style.scss')).toBe(true);
    expect(pattern.test('data.json')).toBe(true);
  });

  it('не трогает файл постороннего типа', () => {
    // Точка должна остаться экранированной, иначе правило поймает и `axtxt`.
    expect(regexpFrom(templateBy('format')).test('notes.txt')).toBe(false);
  });

  it('в тексте скрипта сохранена экранированная точка', () => {
    expect(templateBy('format')).toContain(String.raw`/\.(ts|tsx`);
  });
});

describe('набор заготовок', () => {
  it('идентификаторы уникальны', () => {
    const ids = SCRIPT_TEMPLATES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('у каждой заготовки есть имя файла, заголовок и содержимое', () => {
    for (const template of SCRIPT_TEMPLATES) {
      expect(template.fileName, `${template.id}: имя файла`).toMatch(/\.\w+$/);
      expect(template.title.trim(), `${template.id}: заголовок`).not.toBe('');
      expect(template.content.trim(), `${template.id}: содержимое`).not.toBe('');
    }
  });

  it('каждая заготовка начинается с шебанга', () => {
    // Скрипт запускается как файл — без шебанга он не самодостаточен.
    for (const template of SCRIPT_TEMPLATES) {
      expect(template.content.startsWith('#!'), `${template.id}`).toBe(true);
    }
  });

  it('заготовка пустого скрипта тоже готова к запуску', () => {
    expect(NEW_SCRIPT_TEMPLATE.startsWith('#!')).toBe(true);
  });
});

/**
 * COMMON-1: раздел скриптов открыт всем провайдерам, а заготовки выше говорят на
 * языке хуков Claude Code. Там, где хуков нет, подсовывать их нельзя — набор
 * подменяется общим.
 */
describe('заготовки без хуков', () => {
  it('в общих заготовках нет ничего claude-специфичного', () => {
    for (const template of [
      GENERIC_SCRIPT_TEMPLATE,
      ...GENERIC_SCRIPT_TEMPLATES.map((i) => i.content),
    ]) {
      expect(template).not.toContain('hookSpecificOutput');
      expect(template).not.toContain('tool_input');
      expect(template).not.toContain('Claude');
    }
  });

  it('общие заготовки самодостаточны: шебанг, уникальные id, имя и содержимое', () => {
    const ids = GENERIC_SCRIPT_TEMPLATES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of GENERIC_SCRIPT_TEMPLATES) {
      expect(template.content.startsWith('#!'), template.id).toBe(true);
      expect(template.fileName, template.id).toMatch(/\.\w+$/);
      expect(template.title.trim(), template.id).not.toBe('');
    }
  });

  it('выбор набора: с хуками — каркасы хуков, без хуков — общие', () => {
    expect(scriptTemplatesFor(true)).toBe(SCRIPT_TEMPLATES);
    expect(scriptTemplatesFor(false)).toBe(GENERIC_SCRIPT_TEMPLATES);
    expect(newScriptTemplateFor(true)).toBe(NEW_SCRIPT_TEMPLATE);
    expect(newScriptTemplateFor(false)).toBe(GENERIC_SCRIPT_TEMPLATE);
  });
});
