import { SECRET_MASK } from '@agentdeck/dlp/secret-mask';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type {
  ActOutcome,
  ActRefusal,
  BrowserAct,
  BrowserDriver,
  BrowserDriverOptions,
  NavigationGate,
  OriginVerdict,
} from './browser.types.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { locatorOf, targetText } from './locate.ts';
import { isMissingBrowser, noBrowserMessage } from './no-browser.ts';
import {
  blankOf,
  checksOf,
  MUTATION_SCRIPT,
  mutationsOf,
  watchPage,
  type PageWatch,
} from './page-watch.ts';

/**
 * Браузер ядра (D23): один Chromium на процесс ядра (запуск — первым действием), своя страница и
 * свой контекст на сессию — куки и вход одной сессии другой не видны. Действия сессии идут по
 * очереди: модель может прислать два вызова подряд, а страница — одна. Страница без вызовов дольше
 * срока закрывается сама; остановка ядра закрывает всё.
 */

const ACTION_TIMEOUT_MS = 5_000;
const SETTLE_MS = 600;
const IDLE_MS = 15 * 60_000;
const POLL_MS = 50;
/** Тишина после отклика: запросы, начатые кликом, успевают кончиться и попасть в проверки. */
const QUIET_MS = 150;
const SNAPSHOT_MAX = 12_000;

type Refusal = Extract<OriginVerdict, { ok: false }>;

interface SessionPage {
  context: BrowserContext;
  page: Page;
  watch: PageWatch;
  chain: Promise<unknown>;
  idle?: NodeJS.Timeout;
  filePick: boolean;
  /** Ворота перехода сессии (последние переданные); нет — переходы не судятся. */
  gate?: NavigationGate;
  /** Переходы, остановленные воротами с прошлого исхода. */
  blocked: Refusal[];
}

/** Ключ Chromium: всплывающие окна и `window.open` не создаются. */
const BLOCK_NEW_WINDOWS = '--block-new-web-contents';

/** Сколько ждать страницу ошибки Chromium после остановленного перехода, мс. */
const BLOCKED_COMMIT_MS = 1_000;

/**
 * Ворота перехода на уровне протокола (CDP `Fetch`, этап запроса, только документы): Playwright
 * `route` не видит шаги перенаправления — по нему запрос на чужой хост уже ушёл бы, и судить
 * пришлось бы адрес, куда страница пришла. Здесь каждый шаг верхнего документа судится до сети.
 */
async function guardNavigations(context: BrowserContext, entry: SessionPage): Promise<void> {
  const cdp = await context.newCDPSession(entry.page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const mainFrame = frameTree.frame.id;
  cdp.on('Fetch.requestPaused', (event) => {
    const verdict: OriginVerdict =
      event.frameId === mainFrame && entry.gate ? entry.gate(event.request.url) : { ok: true };
    if (!verdict.ok) entry.blocked.push(verdict);
    const sent = verdict.ok
      ? cdp.send('Fetch.continueRequest', { requestId: event.requestId })
      : cdp.send('Fetch.failRequest', {
          requestId: event.requestId,
          errorReason: 'BlockedByClient',
        });
    // Страница закрылась посреди перехода — запрос умер вместе с ней.
    sent.catch(() => undefined);
  });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Короче — маска по значению съела бы обычные слова причины (как `WALK_SECRET_MIN` прохода). */
const HIDE_MIN = 4;

/**
 * Причина отказа одной строкой. `hide` — набранное значение (может быть секретом стенда): Playwright
 * повторяет его в своей ошибке (`fill("…")`), и оно прячется ДО обрезки — не только потому, что
 * сейчас эхо стоит не в первой строке.
 */
export function errorLine(error: unknown, hide?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text =
    hide !== undefined && hide.length >= HIDE_MIN ? raw.split(hide).join(SECRET_MASK) : raw;
  // Первая строка ошибки Playwright — суть; дальше идёт журнал вызова с селекторами.
  const first = text.split('\n')[0] ?? text;
  return first.length > 300 ? `${first.slice(0, 299)}…` : first;
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Ждать, пока условие не станет истинным, но не дольше срока; последняя ошибка — причина. */
async function until(ok: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      if (await ok()) return;
    } catch (error) {
      last = errorLine(error);
    }
    if (Date.now() >= deadline) throw new Error(last || `${what} not met in ${timeoutMs} ms`);
    await sleep(100);
  }
}

function originOfPage(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function urlMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (!expected.startsWith('/')) return false;
  try {
    const u = new URL(actual);
    return `${u.pathname}${u.search}${u.hash}` === expected || u.pathname === expected;
  } catch {
    return false;
  }
}

export function createBrowserDriver(options: BrowserDriverOptions = {}): BrowserDriver {
  const timeout = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const platform = options.platform ?? currentOs();
  const pages = new Map<string, SessionPage>();
  const opening = new Map<string, Promise<SessionPage | ActRefusal>>();
  let browser: Promise<Browser> | undefined;
  let closed = false;

  const launch = (): Promise<Browser> => {
    if (!browser) {
      browser = chromium.launch({
        headless: true,
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        // Новых окон нет вовсе: проход видит одну страницу сессии, а окно `target=_blank` или
        // `window.open` ходило бы мимо ворот перехода (они стоят на странице сессии).
        args: [BLOCK_NEW_WINDOWS, ...(options.args ?? [])],
      });
      // Неудачный запуск не кешируется: человек ставит браузер — следующий вызов уже идёт.
      browser.catch(() => {
        browser = undefined;
      });
    }
    return browser;
  };

  const release = async (sessionId: string): Promise<void> => {
    // Страница ещё заводится — закрыть ту, что заведётся, а не оставить её без хозяина.
    await opening.get(sessionId)?.catch(() => undefined);
    const entry = pages.get(sessionId);
    if (!entry) return;
    pages.delete(sessionId);
    if (entry.idle) clearTimeout(entry.idle);
    await entry.context.close().catch(() => undefined);
  };

  const touch = (sessionId: string, entry: SessionPage): void => {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => void release(sessionId), idleMs);
    entry.idle.unref();
  };

  /**
   * Страница сессии; заводится один раз. Два первых вызова сессии разом ждут одно заведение: иначе
   * каждый завёл бы свой контекст — второе действие шло бы на пустой странице, а первый контекст
   * жил бы без хозяина до остановки ядра.
   */
  const pageOf = (sessionId: string): Promise<SessionPage | ActRefusal> => {
    const known = pages.get(sessionId);
    if (known) return Promise.resolve(known);
    const pending = opening.get(sessionId);
    if (pending) return pending;
    const made = openPage(sessionId).finally(() => opening.delete(sessionId));
    opening.set(sessionId, made);
    return made;
  };

  const openPage = async (sessionId: string): Promise<SessionPage | ActRefusal> => {
    let b: Browser;
    try {
      b = await launch();
    } catch (error) {
      if (isMissingBrowser(error))
        return { refused: 'no-browser', message: noBrowserMessage(platform) };
      throw error;
    }
    const context = await b.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.addInitScript(MUTATION_SCRIPT);
    context.setDefaultTimeout(timeout);
    const page = await context.newPage();
    const entry: SessionPage = {
      context,
      page,
      watch: watchPage(page),
      chain: Promise.resolve(),
      filePick: false,
      blocked: [],
    };
    // Выбор файла ядро не делает (P177): событие перехвачено, окно не открывается, клик — пробел.
    page.on('filechooser', () => {
      entry.filePick = true;
    });
    // Ворота ставятся до первого перехода: без них страница сессии не отдаётся вовсе.
    try {
      await guardNavigations(context, entry);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
    pages.set(sessionId, entry);
    return entry;
  };

  /** Откликнулась ли страница после клика/клавиши, и дождаться хвоста запросов отклика. */
  const settle = async (
    entry: SessionPage,
    before: number,
    urlBefore: string,
    mark: ReturnType<PageWatch['mark']>,
    react: boolean,
  ): Promise<boolean> => {
    const deadline = Date.now() + settleMs;
    let responded = !react;
    let quietSince = 0;
    for (;;) {
      if (!responded) {
        const slice = entry.watch.since(mark);
        const moved = entry.page.url() !== urlBefore;
        const mutated = (await mutationsOf(entry.page)) !== before;
        responded =
          moved || mutated || slice.requests > 0 || slice.navigations > 0 || slice.dialogs > 0;
      }
      if (responded) {
        if (entry.watch.pending() > 0) quietSince = 0;
        else if (quietSince === 0) quietSince = Date.now();
        else if (Date.now() - quietSince >= QUIET_MS) return true;
      }
      if (Date.now() >= deadline) return responded;
      await sleep(POLL_MS);
    }
  };

  const perform = async (entry: SessionPage, act: BrowserAct): Promise<ActOutcome> => {
    const { page } = entry;
    const mark = entry.watch.mark();
    const before = await mutationsOf(page);
    const urlBefore = page.url();
    const problems: string[] = [];
    let ok = true;
    let snapshot: string | undefined;
    entry.filePick = false;
    try {
      switch (act.action) {
        case 'open':
          await page.goto(act.url, { waitUntil: 'load', timeout });
          break;
        case 'click':
          await locatorOf(page, act.target).click({ timeout });
          break;
        case 'fill':
          // Секрет судился по адресу страницы при чтении; действия сессии идут очередью, и
          // открытие перед вводом могло увести страницу на другой стенд — ввод судится заново.
          if (act.origin !== undefined && originOfPage(page.url()) !== act.origin)
            throw new Error(
              `secret-not-for-this-page: the page left ${act.origin} before the secret was typed; nothing typed`,
            );
          await locatorOf(page, act.target).fill(act.value, { timeout });
          break;
        case 'press':
          if (act.target) await locatorOf(page, act.target).press(act.key, { timeout });
          else await page.keyboard.press(act.key);
          break;
        case 'select':
          await locatorOf(page, act.target).selectOption(act.value, { timeout });
          break;
        case 'expect':
          await expectOn(page, act, timeout);
          break;
        case 'snapshot': {
          const tree = await (
            act.target ? locatorOf(page, act.target) : page.locator('body')
          ).ariaSnapshot({ timeout });
          snapshot = tree.length > SNAPSHOT_MAX ? `${tree.slice(0, SNAPSHOT_MAX)}\n… (cut)` : tree;
          break;
        }
      }
    } catch (error) {
      ok = false;
      const where = 'target' in act && act.target ? ` (${targetText(act.target)})` : '';
      const hide = act.action === 'fill' ? act.value : undefined;
      problems.push(`${act.action} failed${where}: ${errorLine(error, hide)}`);
    }
    const react = ok && (act.action === 'click' || act.action === 'press');
    const responded = await settle(entry, before, urlBefore, mark, react);
    const blocked = entry.blocked.splice(0)[0];
    // Остановленный переход дорисовывает страницу ошибки Chromium: следующее действие (сброс на
    // пустую) не должно наткнуться на этот переход посреди своего.
    if (blocked) {
      await page
        .waitForURL((u) => u.protocol === 'chrome-error:', {
          waitUntil: 'commit',
          timeout: BLOCKED_COMMIT_MS,
        })
        .catch(() => undefined);
    }
    const stale = react && !responded && !entry.filePick;
    const url = page.url();
    const blank = await blankOf(page);
    const { checks, lines } = checksOf(entry.watch.since(mark), url, blank, stale);
    problems.push(...lines);
    if (blank) problems.push('blank page: no text, image, field or button');
    if (stale) problems.push(`no UI response to the ${act.action} within ${settleMs} ms`);
    return {
      action: act.action,
      ok,
      url,
      checks,
      problems: problems.slice(0, 20),
      ...(snapshot !== undefined ? { snapshot } : {}),
      ...(entry.filePick ? { filePick: true as const } : {}),
      ...(blocked ? { blocked } : {}),
    };
  };

  return {
    async act(sessionId, act, gate) {
      if (closed) return { refused: 'closed', message: 'the core browser is stopping' };
      const got = await pageOf(sessionId);
      if ('refused' in got) return got;
      if (gate) got.gate = gate;
      touch(sessionId, got);
      const run = got.chain.then(() => perform(got, act));
      got.chain = run.catch(() => undefined);
      return run;
    },
    urlOf(sessionId) {
      return pages.get(sessionId)?.page.url() ?? null;
    },
    release,
    async close() {
      closed = true;
      await Promise.all([...pages.keys()].map((id) => release(id)));
      const b = browser;
      browser = undefined;
      if (b) await b.then((x) => x.close()).catch(() => undefined);
    },
  };
}

async function expectOn(
  page: Page,
  act: Extract<BrowserAct, { action: 'expect' }>,
  timeout: number,
): Promise<void> {
  const value = act.value ?? '';
  if (act.expect === 'url') {
    await until(async () => urlMatches(page.url(), value), timeout, `url ${value}`);
    return;
  }
  if (!act.target) throw new Error(`expect ${act.expect} needs a target`);
  const locator = locatorOf(page, act.target);
  switch (act.expect) {
    case 'visible':
      await locator.waitFor({ state: 'visible', timeout });
      return;
    case 'hidden':
      await locator.waitFor({ state: 'hidden', timeout });
      return;
    case 'text':
      // Как `toContainText` спека: пробелы схлопнуты, ожидаемое — часть текста элемента.
      await until(
        async () => norm(await locator.innerText({ timeout })).includes(norm(value)),
        timeout,
        `text "${value}"`,
      );
      return;
    case 'value':
      await until(async () => (await locator.inputValue({ timeout })) === value, timeout, `value`);
      return;
  }
}
