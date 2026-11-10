import type { BrowseChecks } from '@agentdeck/contracts/core/browse';
import type { Page, Request } from 'playwright-core';

/**
 * Проверки ядра вокруг действия (P177): ошибки консоли и страницы, упавшие запросы своего
 * источника (сеть или ответ ≥ 400), пустая страница, страница не откликнулась на клик или
 * клавишу. Слушатели вешаются на страницу один раз; действие берёт срез «с метки до конца».
 * Отклик — любое из: изменение DOM (счётчик наблюдателя мутаций из скрипта контекста), переход
 * главного кадра, новый запрос, диалог. Фокус и наведение откликом не считаются: кнопка,
 * которая ничего не делает, — и есть находка «не откликнулась».
 */

/** Скрипт контекста: счётчик мутаций документа, общий для всех кадров верхнего уровня. */
export const MUTATION_SCRIPT = `(() => {
  const w = window;
  if (w.__agentdeckWalk) return;
  const s = { m: 0 };
  w.__agentdeckWalk = s;
  new MutationObserver((list) => { s.m += list.length; }).observe(document, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
})()`;

interface Seen {
  url: string;
  line: string;
}

export interface PageWatch {
  mark(): WatchMark;
  /** Запросы в полёте (не кончились и не упали). */
  pending(): number;
  /** Что случилось после метки: ошибки консоли, упавшие запросы (все источники), отклик. */
  since(mark: WatchMark): WatchSlice;
}

export interface WatchMark {
  console: number;
  failed: number;
  requests: number;
  navigations: number;
  dialogs: number;
}

export interface WatchSlice {
  console: string[];
  failed: Seen[];
  requests: number;
  navigations: number;
  dialogs: number;
}

const NETWORK_ECHO = /^Failed to load resource:/;

const cut = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function watchPage(page: Page): PageWatch {
  const consoleLines: string[] = [];
  const failed: Seen[] = [];
  const inFlight = new Set<Request>();
  let requests = 0;
  let navigations = 0;
  let dialogs = 0;
  page.on('console', (msg) => {
    // «Failed to load resource» пишет сам браузер на каждый упавший запрос: его считает `failed`
    // (только свой источник), а в консоли он удвоил бы счёт и протащил чужие CDN.
    if (msg.type() !== 'error' || NETWORK_ECHO.test(msg.text())) return;
    consoleLines.push(cut(`console error: ${msg.text()}`));
  });
  page.on('pageerror', (error) => consoleLines.push(cut(`page error: ${error.message}`)));
  page.on('request', (request) => {
    requests += 1;
    inFlight.add(request);
  });
  page.on('requestfinished', (request) => inFlight.delete(request));
  page.on('requestfailed', (request) => {
    inFlight.delete(request);
    const why = request.failure()?.errorText ?? 'failed';
    failed.push({
      url: request.url(),
      line: cut(`failed request: ${request.method()} ${request.url()} → ${why}`),
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    failed.push({
      url: response.url(),
      line: cut(`failed request: ${request.method()} ${response.url()} → ${response.status()}`),
    });
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  // Диалог страницы (alert/confirm) закрывается сам: модель его не видит, а ждать его некому.
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss().catch(() => undefined);
  });
  return {
    mark: () => ({
      console: consoleLines.length,
      failed: failed.length,
      requests,
      navigations,
      dialogs,
    }),
    pending: () => inFlight.size,
    since: (m) => ({
      console: consoleLines.slice(m.console),
      failed: failed.slice(m.failed),
      requests: requests - m.requests,
      navigations: navigations - m.navigations,
      dialogs: dialogs - m.dialogs,
    }),
  };
}

/** Счётчик мутаций страницы; документа ещё нет или он закрыт — `-1`. */
export async function mutationsOf(page: Page): Promise<number> {
  try {
    // Строкой, а не функцией: ядро собирается без DOM-типов, выражение исполняет страница.
    const count: unknown = await page.evaluate(
      '(window.__agentdeckWalk && window.__agentdeckWalk.m) ?? -1',
    );
    return typeof count === 'number' ? count : -1;
  } catch {
    return -1;
  }
}

const BLANK_EXPRESSION = `(() => {
  const body = document.body;
  if (!body) return true;
  if ((body.innerText || '').trim() !== '') return false;
  return !body.querySelector('img,svg,canvas,video,input,textarea,select,iframe,button');
})()`;

/**
 * Пустая страница: ни текста, ни картинки, ни поля, ни кнопки в `body`. Документа нет —
 * пустая; страница уходит посреди чтения — не пустая (судить нечего, находки нет).
 */
export async function blankOf(page: Page): Promise<boolean> {
  try {
    return (await page.evaluate(BLANK_EXPRESSION)) === true;
  } catch {
    return false;
  }
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Упавшие запросы того же источника, что страница после действия: чужие CDN — не находка стенда. */
export function sameOrigin(failed: readonly Seen[], pageUrl: string): string[] {
  const own = originOf(pageUrl);
  if (!own) return [];
  return failed.filter((f) => originOf(f.url) === own).map((f) => f.line);
}

export function checksOf(slice: WatchSlice, pageUrl: string, blank: boolean, stale: boolean) {
  const failedLines = sameOrigin(slice.failed, pageUrl);
  const checks: BrowseChecks = {
    console: slice.console.length,
    failed: failedLines.length,
    blank,
    stale,
  };
  return { checks, lines: [...slice.console, ...failedLines] };
}
