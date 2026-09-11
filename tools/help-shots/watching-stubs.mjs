/**
 * Заглушки съёмки «наблюдательных» разделов.
 *
 * Их здесь НАМЕРЕННО мало. Обзор, поиск, аналитика, история и сравнение читают
 * файлы, и файлы для них собирает `watching-fixture.mjs`: счётчики, отчёт, лента
 * и таблица сравнения в кадре посчитаны настоящим сервером по настоящему диску.
 * Подменяются ровно три вещи, каждая по своей причине.
 *
 *  1. `/api/settings` — только `onboardingDone`, иначе одноразовая панель
 *     встречает съёмку мастером первого запуска.
 *  2. `/api/location` — путь каталога. На кадре он был бы временной папкой этой
 *     машины; человеку нужен обычный `~/.claude`, а «тревожный» кадр требует
 *     каталога, заданного руками, и недостающих файлов — состояния, которого на
 *     исправном стенде не бывает.
 *  3. `/api/analytics/live` — запущенные процессы Claude Code. Их на стенде
 *     съёмки нет и быть не должно: поднимать настоящие CLI ради двух строк с
 *     номерами процессов — это запускать агентов на чужой машине.
 */

/** Каталог, который человек видит у себя. Временной папки в кадре быть не должно. */
export const HOME_ROOT = 'C:/Users/user/.claude';

/** Пути внутри каталога — те же, что строит сервер, только от подменённого корня. */
function pathsFor(root) {
  return {
    root,
    settings: `${root}/settings.json`,
    settingsLocal: `${root}/settings.local.json`,
    claudeMd: `${root}/CLAUDE.md`,
    secretsEnv: `${root}/.mcp-secrets.env`,
    skills: `${root}/skills`,
    hooks: `${root}/hooks`,
    mcpConfig: 'C:/Users/user/.claude.json',
    appData: `${root}/agentdeck`,
  };
}

/**
 * Мастер первого запуска обходится одним перехватом настроек: двумя маршрутами
 * нельзя — Playwright отдаёт запрос последнему подходящему обработчику.
 */
export async function settings(page, patch = {}) {
  await page.route('**/api/settings', async (route) => {
    try {
      if (route.request().method() !== 'GET') return await route.continue();
      const response = await route.fetch();
      const body = await response.json();
      return await route.fulfill({
        response,
        json: { ...body, provider: 'claude', ...patch, onboardingDone: true },
      });
    } catch {
      /* контекст закрыт — отвечать уже некому */
    }
  });
}

/**
 * Карточка расположения. Ответ сервера настоящий — подменяются корень, источник
 * и список недостающих файлов, то есть ровно то, что на кадре должно читаться
 * как обычная машина человека.
 */
export async function location(page, override = {}) {
  const { root = HOME_ROOT, source = 'home', missing = [], problem } = override;
  await page.route('**/api/location', async (route) => {
    try {
      const response = await route.fetch();
      const body = await response.json();
      return await route.fulfill({
        response,
        json: {
          ...body,
          paths: pathsFor(root),
          source,
          missing,
          ...(problem ? { problem, isValid: false } : {}),
        },
      });
    } catch {
      /* контекст закрыт */
    }
  });
}

/**
 * Пустой каталог: все счётчики в нулях, лента и копии пусты.
 *
 * Нужен ровно одному кадру — «панель смотрит не туда». На стенде съёмки каталог
 * настоящий и полный, а симптом состоит именно в том, что числа не сходятся с
 * путём: рассказывать про «везде нули» кадром, где плитки полны, значило бы
 * иллюстрировать текст картинкой, которая ему противоречит.
 */
export async function emptyConfig(page) {
  await page.route('**/api/overview', (route) =>
    route.fulfill({
      json: {
        rules: { total: 0, enabled: 0 },
        hooks: { total: 0, enabled: 0, broken: 0 },
        skills: { total: 0, enabled: 0 },
        scripts: { total: 0, unused: 0 },
        mcp: { total: 0, enabled: 0, connected: 0, failed: 0 },
        permissions: { allow: 0, ask: 0, deny: 0 },
        groups: { total: 0 },
      },
    }),
  );
  await page.route('**/api/history', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/backups', (route) => route.fulfill({ json: { items: [] } }));
}

/** Живой срез процессов: на стенде съёмки их нет, а раздел про них рассказывает. */
export async function liveAgents(page, agents = []) {
  await page.route('**/api/analytics/live', (route) =>
    route.fulfill({ json: { runningAgents: agents, at: new Date().toISOString() } }),
  );
}

/**
 * Переселить пути кадра из одноразового каталога в домашний.
 *
 * Пути к файлам на странице сравнения пишет СЕРВЕР, и на стенде съёмки это
 * каталог фикстуры. Показывать его человеку бессмысленно: он читает кадр, чтобы
 * узнать, ГДЕ лежит конфигурация каждой стороны, а видел бы временную папку.
 * Подменяется только корень, и только в тексте — сами имена файлов, их порядок
 * и всё остальное на кадре настоящие. Фикстура для того и устроена как обычный
 * домашний каталог (`.claude`, `.claude.json`, `.codex`), чтобы после подмены
 * получался ровно тот путь, который человек увидит у себя.
 */
export async function rehome(page) {
  const root = process.env.GUIDE_FIXTURE_HOME ?? '';
  if (!root) return;

  await page.evaluate(
    ([from, to]) => {
      const variants = [
        [from.replace(/\//g, '\\'), to.replace(/\//g, '\\')],
        [from.replace(/\\/g, '/'), to.replace(/\\/g, '/')],
      ];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        let text = node.textContent ?? '';
        for (const [a, b] of variants) text = text.split(a).join(b);
        if (text !== node.textContent) node.textContent = text;
      }
      // Полный путь живёт ещё и в подсказке обрезанной строки.
      for (const element of document.querySelectorAll('[title]')) {
        let text = element.getAttribute('title') ?? '';
        for (const [a, b] of variants) text = text.split(a).join(b);
        element.setAttribute('title', text);
      }
    },
    [root, 'C:/Users/user'],
  );
}

/** Снять кадр, предварительно переселив пути. Один вход для всех сценариев. */
export async function frame(scenario, page, id, options) {
  await rehome(page);
  await scenario.shot(page, id, options);
}

/** Открыть страницу и дождаться, пока уедут скелеты. */
export async function open(page, web, path, settle = 1500) {
  await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(settle);
}
