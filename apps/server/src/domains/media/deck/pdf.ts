import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findSystemBrowser } from '../../../lib/system-browser.ts';
import { MediaError } from '../errors.ts';

/**
 * HTML колоды → PDF печатью системного браузера (решение В3).
 *
 * Печатает тот же файл, который человек видит в предпросмотре, поэтому PDF не
 * может разойтись с показом: размер страницы объявлен в самой странице (`@page`
 * 13.333in × 7.5in), браузеру остаётся только напечатать видимое.
 *
 * ДВЕ ОСТОРОЖНОСТИ, обе не косметические:
 *
 *  - профиль браузера человека НЕ ТРОГАЕТСЯ: печать идёт с одноразовым
 *    `--user-data-dir` во временном каталоге, который тут же удаляется. Иначе
 *    панель писала бы в профиль, где лежат его сессии и пароли, и делала бы это
 *    без спроса;
 *  - браузер печатает в ФАЙЛ, а не в поток, и молча выходит с нулём, если
 *    страница не открылась. Поэтому итог проверяется по подписи `%PDF-`: пустой
 *    или отсутствующий файл — это отказ с причиной, а не «PDF на ноль байт».
 *
 * ГЛАВНАЯ ЛОВУШКА, и она стоила живого прогона: ВЫХОД ПРОЦЕССА НЕ ЗНАЧИТ, ЧТО
 * ПЕЧАТЬ КОНЧИЛАСЬ. `msedge.exe` на Windows возвращает ноль сразу — печатает
 * отделившийся дочерний процесс, и PDF появляется секунды спустя. Код, который
 * верил коду выхода, находил пустое место и тут же удалял временный каталог
 * из-под работающего браузера: PDF не получался НИ РАЗУ, а причина читалась как
 * «браузер файла не оставил». Поэтому ждём здесь сам ФАЙЛ, а не процесс, и
 * считаем печать законченной только по дописанному до конца PDF.
 */

/** Сколько ждём печать. Колода в сорок слайдов печатается секунды. */
const PRINT_TIMEOUT_MS = 90_000;

/** Подпись формата: ею проверяется, что напечатался именно PDF. */
const PDF_SIGNATURE = '%PDF-';

/**
 * Конец файла PDF. Им отличается дописанный файл от растущего: браузер пишет
 * потоком, и «размер не изменился за такт» на медленном диске означало бы
 * обрезанный PDF, который открывается битым.
 */
const PDF_END = '%%EOF';

/** Как часто смотрим на файл. */
const POLL_MS = 200;

/** Есть ли чем печатать. Путь наружу не отдаётся — это деталь машины. */
export function canPrintPdf(env?: NodeJS.ProcessEnv): boolean {
  return Boolean(findSystemBrowser(env));
}

/**
 * Напечатать PDF из готовой разметки. Бросает `MediaError` с причиной, если
 * браузера нет или печать не удалась.
 */
export async function printDeckPdf(html: string, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  const browser = findSystemBrowser(env);
  if (!browser) {
    throw new MediaError(
      409,
      'PDF печатает системный браузер (Chrome, Edge или Chromium), а его на этой машине не нашлось. HTML и PPTX собираются без него.',
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'cc-deck-'));
  const source = join(dir, 'deck.html');
  const target = join(dir, 'deck.pdf');
  const profile = join(dir, 'profile');

  try {
    writeFileSync(source, html, 'utf8');
    return await run(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        // Свой каталог профиля: профиль человека печать не открывает.
        `--user-data-dir=${profile}`,
        // Ни колонтитулов, ни адреса страницы в углу: это колода, а не распечатка
        // веб-страницы.
        '--no-pdf-header-footer',
        `--print-to-pdf=${target}`,
        pathToFileURL(source).href,
      ],
      target,
    );
  } finally {
    // Настойчиво, но не в ущерб готовому файлу: отделившийся браузер держит свой
    // профиль ещё какое-то время, и падение на занятом файле отменило бы удачную
    // печать. Не вышло — каталог останется системе, PDF уже прочитан.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Временный каталог — не повод терять колоду.
    }
  }
}

/**
 * Запуск браузера и ожидание ДОПИСАННОГО файла. Отказ переводится в причину, а не
 * в стек вызовов.
 */
function run(browser: string, args: string[], target: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let done = false;
    /** Код выхода пригодится только как причина, если файла так и нет. */
    let exit: Error | undefined;
    let exited = false;

    const child = execFile(browser, args, { windowsHide: true }, (error) => {
      exited = true;
      exit = error ?? undefined;
    });

    const started = Date.now();
    const finish = (outcome: () => void): void => {
      if (done) return;
      done = true;
      outcome();
    };

    const tick = (): void => {
      if (done) return;

      const bytes = readWhole(target);
      if (bytes) return finish(() => resolve(bytes));

      if (exited && exit) {
        return finish(() =>
          reject(new MediaError(502, `Браузер не напечатал PDF: ${exit?.message ?? ''}`)),
        );
      }
      if (Date.now() - started > PRINT_TIMEOUT_MS) {
        // Убиваем ровно тот процесс, который запустили сами. Свои вспомогательные
        // процессы браузер плодит сам и закрывает их по уходу родителя — панель их
        // не ищет: гоняться за чужим деревом процессов она не вправе, а печать в
        // любом случае уже брошена.
        child.kill();
        return finish(() =>
          reject(
            new MediaError(
              504,
              exited
                ? 'Браузер закончил печать, но файла PDF не оставил.'
                : `Печать PDF не закончилась за ${PRINT_TIMEOUT_MS / 1_000} с — панель не ждёт дольше.`,
            ),
          ),
        );
      }
      setTimeout(tick, POLL_MS);
    };

    // Опрос НЕ снимается с учёта событийного цикла (`unref`), хотя соблазн есть:
    // печать в полёте — это работа, а не фон. Браузер выходит с кодом 0 сразу и
    // печатает отдельным процессом, поэтому после его ухода ждать файл больше
    // некому: снятый с учёта таймер давал процессу без других дел выйти с
    // неразрешённым обещанием — печать «висела» у любого запуска вне сервера
    // (проверено живым прогоном 13.09.2026). Потолок ожидания ограничен
    // `PRINT_TIMEOUT_MS`, так что задержка на остановке заведомо конечна.
    setTimeout(tick, POLL_MS);
  });
}

/** Файл целиком, если он уже дописан; иначе `undefined` — ждём дальше. */
function readWhole(target: string): Buffer | undefined {
  if (!existsSync(target)) return undefined;
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch {
    // Браузер держит файл на запись — на следующем такте прочитается.
    return undefined;
  }
  if (bytes.length === 0) return undefined;
  if (!bytes.subarray(0, PDF_SIGNATURE.length).toString('latin1').startsWith(PDF_SIGNATURE)) {
    return undefined;
  }
  // Хвост, а не весь файл: PDF бывает и на десятки мегабайт.
  return bytes.subarray(-64).toString('latin1').includes(PDF_END) ? bytes : undefined;
}
