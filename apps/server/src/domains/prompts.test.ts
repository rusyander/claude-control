import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROMPT_IDS, PROMPT_MAX_BYTES } from '@agentdeck/contracts/prompts';
import {
  exportPromptOverrides,
  listPrompts,
  promptsDir,
  promptText,
  readPromptRecord,
  resetPrompt,
  savePrompt,
} from './prompts.ts';
import { builtinPromptSha, builtinPromptText, PROMPT_CATALOG } from './prompts/catalog.ts';
import { PromptTooLongError } from './prompts/errors.ts';
import { buildPanelPrompts, panelPromptsFile, planPanelPrompts } from './env-transfer/prompts.ts';

/**
 * Каталог промптов: два слоя и ни одного больше.
 *
 * Проверяется не «функция вернула строку», а то, ради чего раздел заведён:
 * встроенный текст приезжает из репозитория, правка человека живёт отдельно и
 * переживает обновление панели, «Сбросить» возвращает ровно текст репозитория, а
 * правка знает, что встроенный текст с тех пор переписали.
 */

let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'prompts-'));
});

afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

describe('каталог', () => {
  it('описывает ровно те промпты, что объявлены в контракте', () => {
    expect(PROMPT_CATALOG.map((entry) => entry.id)).toEqual([...PROMPT_IDS]);
  });

  it('у каждого промпта есть непустой встроенный текст', () => {
    for (const id of PROMPT_IDS) {
      expect(builtinPromptText(id).trim().length).toBeGreaterThan(100);
    }
  });

  it('без правки работает встроенный текст', () => {
    expect(promptText(appData, 'image')).toBe(builtinPromptText('image'));
    expect(listPrompts(appData).every((item) => !item.overridden)).toBe(true);
  });
});

describe('правка человека', () => {
  it('сохраняется, читается и становится рабочим текстом', () => {
    const record = savePrompt(appData, 'image', 'мой текст', '2026-09-11T10:00:00.000Z');

    expect(record.overridden).toBe(true);
    expect(record.text).toBe('мой текст');
    expect(record.updatedAt).toBe('2026-09-11T10:00:00.000Z');
    expect(promptText(appData, 'image')).toBe('мой текст');
    // Встроенный текст приезжает вместе с правкой: кнопка «Сбросить» должна
    // показывать, к чему вернёт, ДО нажатия.
    expect(record.builtinText).toBe(builtinPromptText('image'));
  });

  it('лежит отдельным файлом в каталоге данных, а не в состоянии панели', () => {
    savePrompt(appData, 'image', 'мой текст');
    const path = join(promptsDir(appData), 'image.md');

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('мой текст');
  });

  it('не трогает встроенный текст соседнего промпта', () => {
    savePrompt(appData, 'image', 'мой текст');

    expect(promptText(appData, 'presentation')).toBe(builtinPromptText('presentation'));
  });

  it('текст, совпавший со встроенным, правкой не становится', () => {
    savePrompt(appData, 'image', 'мой текст');
    const record = savePrompt(appData, 'image', builtinPromptText('image'));

    expect(record.overridden).toBe(false);
    expect(existsSync(join(promptsDir(appData), 'image.md'))).toBe(false);
  });

  it('«Сбросить» возвращает текст репозитория', () => {
    savePrompt(appData, 'image', 'мой текст');
    const record = resetPrompt(appData, 'image');

    expect(record.overridden).toBe(false);
    expect(record.text).toBe(builtinPromptText('image'));
    expect(promptText(appData, 'image')).toBe(builtinPromptText('image'));
  });

  it('сброс несуществующей правки — не ошибка', () => {
    expect(() => resetPrompt(appData, 'image')).not.toThrow();
  });

  it('потолок длины держит сама дверь записи, а не маршрут', () => {
    // Писателей у правок двое: `PUT /api/prompts/:id` и разворот архива. Правило
    // в маршруте означало бы, что мегабайтный промпт въезжает снимком и уезжает
    // потом в КАЖДЫЙ запрос режима.
    const huge = 'я'.repeat(PROMPT_MAX_BYTES);

    expect(() => savePrompt(appData, 'image', huge)).toThrow(PromptTooLongError);
    expect(existsSync(join(promptsDir(appData), 'image.md'))).toBe(false);
    expect(promptText(appData, 'image')).toBe(builtinPromptText('image'));
  });

  it('копия перед перезаписью и перед сбросом — правка не исчезает бесследно', () => {
    const backupDir = join(appData, 'backups');
    savePrompt(appData, 'image', 'первый текст', undefined, backupDir);
    // Первая запись копировать нечего: файла ещё не было.
    savePrompt(appData, 'image', 'второй текст', undefined, backupDir);
    resetPrompt(appData, 'image', backupDir);

    const copies = readdirSync(backupDir, { recursive: true }) as string[];
    const texts = copies
      .map((name) => join(backupDir, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, 'utf8'));

    expect(texts).toContain('первый текст');
    expect(texts).toContain('второй текст');
  });
});

describe('обновление панели', () => {
  it('правка знает отпечаток встроенного текста, с которым она сделана', () => {
    savePrompt(appData, 'image', 'мой текст');

    expect(exportPromptOverrides(appData)[0]?.baseSha).toBe(builtinPromptSha('image'));
    expect(readPromptRecord(appData, 'image').builtinChanged).toBe(false);
  });

  it('переписанный встроенный текст виден человеку как «встроенный изменился»', () => {
    savePrompt(appData, 'image', 'мой текст');
    // Панель обновилась: встроенный текст другой, отпечаток в правке — прежний.
    stampBase(appData, 'image', 'отпечаток прежней версии панели');

    expect(readPromptRecord(appData, 'image').builtinChanged).toBe(true);
    // Рабочим при этом остаётся текст человека: обновление панели его не трогает.
    expect(promptText(appData, 'image')).toBe('мой текст');
  });

  it('правка без отметки ничего не утверждает про встроенный текст', () => {
    mkdirSync(promptsDir(appData), { recursive: true });
    writeFileSync(join(promptsDir(appData), 'image.md'), 'файл пережил index.json', 'utf8');

    const record = readPromptRecord(appData, 'image');
    expect(record.overridden).toBe(true);
    expect(record.builtinChanged).toBe(false);
  });

  it('битый index.json не роняет каталог', () => {
    mkdirSync(promptsDir(appData), { recursive: true });
    writeFileSync(join(promptsDir(appData), 'index.json'), '{не json', 'utf8');

    expect(() => listPrompts(appData)).not.toThrow();
    expect(listPrompts(appData)).toHaveLength(PROMPT_IDS.length);
  });

  it('отметка чужой формы не поднимает ложную тревогу и не выключает перенос', () => {
    // Ревью Т4, MINOR-8: записи `index.json` приводились к типу, а не читались.
    // Числовой `baseSha` давал «встроенный изменился» на нетронутом тексте, а
    // на другой машине одна такая запись отбрасывала секцию правок ЦЕЛИКОМ.
    mkdirSync(promptsDir(appData), { recursive: true });
    writeFileSync(join(promptsDir(appData), 'image.md'), 'мой текст', 'utf8');
    writeFileSync(join(promptsDir(appData), 'presentation.md'), 'мои слайды', 'utf8');
    writeFileSync(
      join(promptsDir(appData), 'index.json'),
      JSON.stringify({
        version: 1,
        entries: {
          image: { baseSha: 12345, updatedAt: '2026-09-11T10:00:00.000Z' },
          presentation: 'не запись',
        },
      }),
      'utf8',
    );

    expect(readPromptRecord(appData, 'image').builtinChanged).toBe(false);
    const section = panelPromptsFile(buildPanelPrompts(exportPromptOverrides(appData)));
    const plan = planPanelPrompts({ data: section, current: [] });
    expect(plan.problem).toBeUndefined();
    expect(plan.entries.map((entry) => entry.id)).toEqual(['image', 'presentation']);
  });

  it('отметка без файла правкой не считается', () => {
    savePrompt(appData, 'image', 'мой текст');
    rmSync(join(promptsDir(appData), 'image.md'), { force: true });

    expect(readPromptRecord(appData, 'image').overridden).toBe(false);
    expect(promptText(appData, 'image')).toBe(builtinPromptText('image'));
  });
});

describe('список для экрана', () => {
  it('считает размер рабочего текста, а не встроенного', () => {
    savePrompt(appData, 'image', 'коротко');
    const row = listPrompts(appData).find((item) => item.id === 'image');

    expect(row?.bytes).toBe(Buffer.byteLength('коротко', 'utf8'));
    expect(row?.overridden).toBe(true);
  });

  it('идёт в порядке каталога', () => {
    expect(listPrompts(appData).map((item) => item.id)).toEqual([...PROMPT_IDS]);
  });
});

/** Подменяет отпечаток базы в отметке — так выглядит правка, пережившая обновление панели. */
function stampBase(dir: string, id: string, baseSha: string): void {
  const path = join(promptsDir(dir), 'index.json');
  const index: {
    version: number;
    entries: Record<string, { baseSha: string; updatedAt: string }>;
  } = JSON.parse(readFileSync(path, 'utf8'));
  index.entries[id] = {
    ...index.entries[id],
    baseSha,
    updatedAt: index.entries[id]?.updatedAt ?? '',
  };
  writeFileSync(path, JSON.stringify(index, null, 2), 'utf8');
}
