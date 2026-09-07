import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectTestsError, ProjectTestsUnavailableError } from './files.ts';
import { NO_BROWSER_MESSAGE, findChromium, renderPdf, type Renderer } from './pdf.ts';

/**
 * Печать отчёта. Настоящий браузер здесь не запускается — тогда проверка
 * зависела бы от того, что стоит на машине сборщика, а проверять нужно ровно
 * обратное: что панель ЧЕСТНО отвечает «нечем», не оставляет за собой мусора и
 * не выдаёт пустой файл за отчёт.
 */

/** Путь, в который браузеру велено печатать, — из аргументов запуска. */
function outputOf(args: string[]): string {
  const flag = args.find((arg) => arg.startsWith('--print-to-pdf='));
  return flag ? flag.slice('--print-to-pdf='.length) : '';
}

/** Браузер, который «напечатал» ровно то, что ему передали. */
const printing =
  (body = '%PDF-1.4 отчёт'): Renderer =>
  (_browser, args) => {
    writeFileSync(outputOf(args), body);
    return Promise.resolve({ code: 0, err: '' });
  };

/** Сколько временных папок печати лежит в системном temp прямо сейчас. */
function leftovers(): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('cc-report-')).length;
}

describe('project-tests pdf', () => {
  describe('поиск браузера', () => {
    it('имя в PATH важнее известных мест установки', () => {
      const browser = findChromium({
        detectCli: (command) => command === 'chromium' || command === 'msedge',
        exists: () => true,
        env: {},
      });

      // Первое подошедшее имя из списка предпочтения, а не первый попавшийся путь.
      expect(['chromium', 'msedge']).toContain(browser);
      expect(browser?.includes('/')).toBe(false);
    });

    it('в PATH пусто — берём установленный по известному пути', () => {
      const found = findChromium({
        detectCli: () => false,
        exists: (path) => path.toLowerCase().includes('chrom'),
        env: {},
      });

      expect(found).toBeTruthy();
      expect(found?.toLowerCase()).toContain('chrom');
    });

    it('свой путь в переменной окружения перебивает всё', () => {
      const own = '/opt/мой-хром/chrome';

      expect(
        findChromium({
          detectCli: () => true,
          exists: (path) => path === own,
          env: { AGENTDECK_CHROME: own },
        }),
      ).toBe(own);
    });

    it('указанный путь не существует — это ошибка настройки, а не повод искать дальше', () => {
      expect(
        findChromium({
          detectCli: () => true,
          exists: () => false,
          env: { AGENTDECK_CHROME: '/нет/такого/chrome' },
        }),
      ).toBeUndefined();
    });

    it('ничего не нашлось — молча, без падения в самом поиске', () => {
      expect(
        findChromium({ detectCli: () => false, exists: () => false, env: {} }),
      ).toBeUndefined();
    });

    it('места установки знает под каждую систему, а не только под свою', () => {
      const real = process.platform;
      const asPlatform = (platform: string): string | undefined => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        return findChromium({ detectCli: () => false, exists: () => true, env: {} });
      };

      try {
        expect(asPlatform('darwin')).toContain('/Applications/');
        expect(asPlatform('linux')).toContain('/usr/bin/');
        expect(asPlatform('win32')?.toLowerCase()).toContain('.exe');
      } finally {
        Object.defineProperty(process, 'platform', { value: real, configurable: true });
      }
    });
  });

  describe('печать', () => {
    const none = { detectCli: () => false, exists: () => false, env: {} };
    const chrome = { detectCli: (command: string) => command.includes('chrom'), env: {} };

    it('браузера нет — 501 с именами того, что поставить', async () => {
      const error = await renderPdf('<h1>Отчёт</h1>', none).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ProjectTestsUnavailableError);
      expect((error as ProjectTestsUnavailableError).statusCode).toBe(501);
      expect((error as Error).message).toBe(NO_BROWSER_MESSAGE);
      expect((error as Error).message).toContain('Chrome');
      expect((error as Error).message).toContain('AGENTDECK_CHROME');
    });

    it('печатает из файла в своём профиле — иначе команда уйдёт в открытое окно', async () => {
      let seen: string[] = [];
      const body = await renderPdf('<h1>Отчёт</h1>', {
        ...chrome,
        render: (browser, args) => {
          seen = args;
          return printing()(browser, args);
        },
      });

      expect(body.toString('utf8')).toBe('%PDF-1.4 отчёт');
      expect(seen.some((arg) => arg.startsWith('--headless'))).toBe(true);
      // Свой профиль — та самая причина, по которой печать раньше «проходила»
      // с нулевым кодом и без файла.
      expect(seen.some((arg) => arg.startsWith('--user-data-dir='))).toBe(true);
      // Страница отдаётся файлом: HTML отчёта длиннее любой командной строки.
      const page = seen.find((arg) => arg.startsWith('file://'));
      expect(page).toBeTruthy();
      // Файл страницы и файл отчёта — в одной временной папке, которую и убирают.
      expect(dirname((page ?? '').replace('file://', ''))).toBe(
        dirname(outputOf(seen)).replace(/\\/g, '/'),
      );
    });

    it('браузер отработал, а файла нет — названная ошибка с его же жалобой', async () => {
      const error = await renderPdf('<h1>Отчёт</h1>', {
        ...chrome,
        render: () => Promise.resolve({ code: 21, err: 'DevToolsActivePort file doesn’t exist' }),
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ProjectTestsError);
      expect((error as Error).message).toContain('21');
      expect((error as Error).message).toContain('DevToolsActivePort');
    });

    it('пустой файл отчётом не считается', async () => {
      const error = await renderPdf('<h1>Отчёт</h1>', {
        ...chrome,
        render: printing(''),
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ProjectTestsError);
      expect((error as Error).message).toContain('пустой');
    });

    it('временная папка убирается и после успеха, и после провала', async () => {
      const before = leftovers();
      let dir = '';

      await renderPdf('<h1>Отчёт</h1>', {
        ...chrome,
        render: (browser, args) => {
          dir = dirname(outputOf(args));
          return printing()(browser, args);
        },
      });
      expect(existsSync(dir)).toBe(false);

      await renderPdf('<h1>Отчёт</h1>', {
        ...chrome,
        render: () => Promise.resolve({ code: 1, err: '' }),
      }).catch(() => undefined);

      expect(leftovers()).toBe(before);
    });

    it('настоящий запуск чужой программы кончается разбором её жалобы', async () => {
      // Браузером назначается node: он гарантированно есть, честно ругается на
      // чужие ключи и умирает мгновенно. Так проверяется сам запуск —
      // подхват stderr и кода возврата, — не подменённый заглушкой.
      const before = leftovers();
      const error = await renderPdf('<h1>Отчёт</h1>', {
        detectCli: () => false,
        exists: (path) => path === process.execPath,
        env: { AGENTDECK_CHROME: process.execPath },
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ProjectTestsError);
      expect((error as Error).message).toContain('не напечатал');
      // Жалоба самой программы доходит до человека, а не теряется в коде возврата.
      expect((error as Error).message).toMatch(/headless|option|Error/i);
      expect(leftovers()).toBe(before);
    });
  });
});
