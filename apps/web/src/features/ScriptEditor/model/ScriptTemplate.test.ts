import { describe, it, expect } from 'vitest';
import {
  SCRIPT_TEMPLATES,
  NEW_SCRIPT_TEMPLATE,
  GENERIC_SCRIPT_TEMPLATE,
  GENERIC_SCRIPT_TEMPLATES,
  scriptTemplatesFor,
  newScriptTemplateFor,
} from './ScriptTemplate';
import {
  GENERIC_SCRIPT_TEMPLATE_EN,
  GENERIC_SCRIPT_TEMPLATES_EN,
  NEW_SCRIPT_TEMPLATE_EN,
  SCRIPT_TEMPLATES_EN,
} from './ScriptTemplate.en';
import type { ScriptTemplate } from './ScriptTemplate.types';

/**
 * Два набора — русский и английский (`ScriptTemplate.en.ts`). Всё, что ниже
 * проверяется в коде заготовок, проверяется в обоих: английская копия кода
 * ломается ровно так же, как русская.
 */
const LANGUAGES = [
  {
    language: 'ru',
    hooks: SCRIPT_TEMPLATES,
    blank: NEW_SCRIPT_TEMPLATE,
    generic: GENERIC_SCRIPT_TEMPLATES,
    genericBlank: GENERIC_SCRIPT_TEMPLATE,
  },
  {
    language: 'en',
    hooks: SCRIPT_TEMPLATES_EN,
    blank: NEW_SCRIPT_TEMPLATE_EN,
    generic: GENERIC_SCRIPT_TEMPLATES_EN,
    genericBlank: GENERIC_SCRIPT_TEMPLATE_EN,
  },
] as const;

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

function templateIn(set: readonly ScriptTemplate[], id: string): string {
  const template = set.find((item) => item.id === id);
  if (!template) throw new Error(`нет заготовки ${id}`);
  return template.content;
}

for (const { language, hooks, blank, generic, genericBlank } of LANGUAGES) {
  const templateBy = (id: string): string => templateIn(hooks, id);

  describe(`заготовки скриптов: ${language}`, () => {
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
        const ids = hooks.map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('у каждой заготовки есть имя файла, заголовок и содержимое', () => {
        for (const template of hooks) {
          expect(template.fileName, `${template.id}: имя файла`).toMatch(/\.\w+$/);
          expect(template.title.trim(), `${template.id}: заголовок`).not.toBe('');
          expect(template.content.trim(), `${template.id}: содержимое`).not.toBe('');
        }
      });

      it('каждая заготовка начинается с шебанга', () => {
        // Скрипт запускается как файл — без шебанга он не самодостаточен.
        for (const template of hooks) {
          expect(template.content.startsWith('#!'), `${template.id}`).toBe(true);
        }
      });

      it('заготовка пустого скрипта тоже готова к запуску', () => {
        expect(blank.startsWith('#!')).toBe(true);
      });
    });

    /**
     * COMMON-1: раздел скриптов открыт всем провайдерам, а заготовки выше говорят на
     * языке хуков Claude Code. Там, где хуков нет, подсовывать их нельзя — набор
     * подменяется общим.
     */
    describe('заготовки без хуков', () => {
      it('в общих заготовках нет ничего claude-специфичного', () => {
        for (const template of [genericBlank, ...generic.map((i) => i.content)]) {
          expect(template).not.toContain('hookSpecificOutput');
          expect(template).not.toContain('tool_input');
          expect(template).not.toContain('Claude');
        }
      });

      it('общие заготовки самодостаточны: шебанг, уникальные id, имя и содержимое', () => {
        const ids = generic.map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const template of generic) {
          expect(template.content.startsWith('#!'), template.id).toBe(true);
          expect(template.fileName, template.id).toMatch(/\.\w+$/);
          expect(template.title.trim(), template.id).not.toBe('');
        }
      });

      it('выбор набора: с хуками — каркасы хуков, без хуков — общие, на своём языке', () => {
        expect(scriptTemplatesFor(true, language)).toBe(hooks);
        expect(scriptTemplatesFor(false, language)).toBe(generic);
        expect(newScriptTemplateFor(true, language)).toBe(blank);
        expect(newScriptTemplateFor(false, language)).toBe(genericBlank);
      });
    });
  });
}

/** Код без комментариев и текста строк — то, что должно совпадать в двух копиях. */
function codeOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/`[^`]*`/g, '``')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Английская панель раньше создавала скрипт с русскими комментариями и
 * подписями (кадр справки scripts/new, 28.09). Английская копия — те же
 * заготовки: те же id, имена файлов и код, без единой буквы кириллицы.
 */
describe('английские заготовки', () => {
  const pairs = [
    ['hooks', SCRIPT_TEMPLATES, SCRIPT_TEMPLATES_EN],
    ['generic', GENERIC_SCRIPT_TEMPLATES, GENERIC_SCRIPT_TEMPLATES_EN],
  ] as const;

  for (const [name, ru, en] of pairs) {
    it(`${name}: те же id и имена файлов`, () => {
      expect(en.map((item) => [item.id, item.fileName])).toEqual(
        ru.map((item) => [item.id, item.fileName]),
      );
    });

    it(`${name}: код тот же, отличаются только комментарии и строки`, () => {
      for (const [index, template] of en.entries()) {
        expect(codeOnly(template.content), template.id).toBe(codeOnly(ru[index]!.content));
      }
    });

    it(`${name}: ни подписи, ни файл не по-русски`, () => {
      for (const template of en) {
        const text = [template.title, template.description, template.content].join('\n');
        expect(text, template.id).not.toMatch(/[А-Яа-яЁё]/);
      }
    });
  }

  it('каркасы нового скрипта: тот же код, без кириллицы', () => {
    expect(codeOnly(NEW_SCRIPT_TEMPLATE_EN)).toBe(codeOnly(NEW_SCRIPT_TEMPLATE));
    expect(codeOnly(GENERIC_SCRIPT_TEMPLATE_EN)).toBe(codeOnly(GENERIC_SCRIPT_TEMPLATE));
    expect(NEW_SCRIPT_TEMPLATE_EN + GENERIC_SCRIPT_TEMPLATE_EN).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('язык по умолчанию — русский', () => {
    expect(scriptTemplatesFor(true)).toBe(SCRIPT_TEMPLATES);
    expect(newScriptTemplateFor(false)).toBe(GENERIC_SCRIPT_TEMPLATE);
  });
});
