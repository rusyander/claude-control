/**
 * Обстановка для кадров пачки «Доступ и провайдеры» (`settings`, `providers`,
 * `endpoints`, `integrations`, `dlp`).
 *
 * Все пять разделов — про один вопрос: куда панель ходит, чем она при этом
 * представляется и что из этого остаётся на диске. Снимать их порознь значило
 * бы пять раз поднимать один и тот же стенд: профиль эндпоинта, который
 * показывает раздел «Свой эндпоинт», — это ровно тот адрес, который потом
 * выбирает прокси защиты данных, а провайдер, выбранный в настройках, решает,
 * можно ли вообще поставить гейт на промпте.
 *
 * СТЕНД ОДНОРАЗОВЫЙ И ЛЕЖИТ РЯДОМ С РЕПОЗИТОРИЕМ, а не во временной папке.
 * Причина та же, что у пачки «Доступы»: путь попадает в кадр. Карточка гейта
 * показывает путь до скрипта хука целиком, строка применения эндпоинта — путь
 * до файла чужого CLI, а `%TEMP%` на Windows начинается с имени пользователя.
 * В справку, которую читают чужие люди, не уезжает ни одно имя человека —
 * поэтому же панели подсовывается собственный домашний каталог.
 *
 * НАВЕРХ НИ ОДИН ЗАПРОС НЕ УХОДИТ. Всё, куда панель ходит по-настоящему —
 * проверка связи эндпоинта, определение диалекта Atlassian, «кто я» у форджа,
 * пробное событие вебхука и сам прокси защиты данных, — обслуживает выдуманный
 * сервер на петле (`fakeUpstream`). Ответы панель считает сама: маска токена —
 * её маска, «облако» в бейдже Atlassian — её живое определение диалекта,
 * счётчики прокси — её счётчики.
 *
 * Каталог помечается файлом-меткой и сносится в конце — метка не даёт снести
 * чужую папку, если имя совпало.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, DEFAULT_MASKS } from './kit.mjs';

/** Корень одноразового стенда: сосед репозитория, а не его подкаталог. */
export const STAND = join(dirname(REPO_ROOT), 'claude-demo-providers');

/** Каталог конфигурации панели — то, что уезжает в `CLAUDE_CONFIG_DIR`. */
export const CONFIG_DIR = join(STAND, '.claude');

/** Домашний каталог, который увидит панель: без имени человека. */
export const HOME_DIR = join(STAND, 'home');

/** Метка «каталог создан съёмкой» — без неё чужая папка не сносится. */
const MARK = '.help-shots-owned';

const SETTINGS = join(CONFIG_DIR, 'settings.json');
const STATE = join(CONFIG_DIR, 'agentdeck', 'state.json');

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Создать стенд. Настройки панели пишутся ДО старта сервера: состояние он
 * читает с диска один раз, на старте, и дальше живёт с ним в памяти — всё
 * последующее идёт через его же API (`patchSettings`), как это делает
 * интерфейс.
 */
export function makeStand(patch = {}) {
  if (existsSync(STAND) && !existsSync(join(STAND, MARK))) {
    throw new Error(`${STAND} уже существует и создан не съёмкой — выберите другой путь`);
  }
  mkdirSync(join(CONFIG_DIR, 'agentdeck'), { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(join(STAND, MARK), 'создан tools/help-shots/access-providers-panel.mjs\n', 'utf8');
  // Пустой settings.json: раздел «Переменные» в кадры этой пачки не попадает,
  // но без файла панель показывала бы состояние «конфигурации нет».
  writeFileSync(SETTINGS, json({}), 'utf8');
  writeFileSync(
    STATE,
    json({
      projects: [],
      settings: {
        onboardingDone: true,
        theme: 'light',
        language: 'ru',
        ...patch,
      },
    }),
    'utf8',
  );
  return STAND;
}

/** Снести стенд — но только тот, который создали мы. */
export function dropStand() {
  if (existsSync(join(STAND, MARK))) rmSync(STAND, { recursive: true, force: true });
}

/**
 * Настройки панели — её же ручкой, как это делает интерфейс и телефон.
 * Прямая запись в state.json бесполезна: сервер прочитал его на старте.
 */
export async function patchSettings(panel, patch) {
  const response = await fetch(`${panel}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`PATCH /api/settings: ${response.status}`);
  return response.json();
}

/** Открыть раздел панели по адресу и дождаться, пока он дорисуется. */
export async function openSection(page, web, path, pause = 1500) {
  await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(pause);
}

/** Вкладка настроек адресуется ссылкой — так же, как на неё приходят из справки. */
export async function openSettingsTab(page, web, tab, pause = 1800) {
  await openSection(page, web, `/settings?tab=${tab}`, pause);
}

/**
 * Заголовки карточек этой пачки: русский → английский, взято из `en.ts` по тем
 * же ключам, что рендерит компонент. `card()` матчит ОБА варианта сразу, чтобы
 * все сценарии — русские и английские — звали его одинаково, не зная, какой
 * прогон сейчас идёт.
 */
const TITLE_EN = {
  'Каталог .claude': '.claude directory',
  'Доступ Claude Code': 'Claude Code access',
  'Удалённый доступ': 'Remote access',
  'Безопасность правок': 'Edit safety',
  'Резервные копии': 'Backups',
  Расход: 'Spend',
  'Перенос настроек панели': 'Transfer panel settings',
  'Промпты приложения': 'Application prompts',
  'Провайдер конфигурации': 'Configuration provider',
  'API-ключи провайдеров': 'Provider API keys',
  'Сверка форматов со схемами': 'Format check against schemas',
  'Свой эндпоинт': 'Custom endpoint',
  'Jira и Confluence': 'Jira and Confluence',
  'Фордж по токену': 'Forge by token',
  Вебхук: 'Webhook',
  'Куда применить': 'Apply to',
  Прокси: 'Proxy',
  'Гейт на промпте': 'Prompt gate',
  'Проверка на пробном тексте': 'Check against a sample text',
  'Журнал срабатываний': 'Match journal',
};

/**
 * Карточка как область кадра. Классы модулей CSS собираются сборщиком, но
 * `padding-md` живёт ровно в одном модуле — `shared/ui/card` — и по нему
 * карточка отличается от любого другого блока надёжнее, чем по глубине вложения.
 */
export const card = (title) => {
  const en = TITLE_EN[title];
  const test = en
    ? `normalize-space(text())=${xpathLiteral(title)} or normalize-space(text())=${xpathLiteral(en)}`
    : `normalize-space(text())=${xpathLiteral(title)}`;
  return `xpath=//*[${test}]/ancestor::div[contains(@class,"padding-md")][1]`;
};

/** Строка XPath с кавычками внутри: `concat` — единственный способ их внести. */
function xpathLiteral(value) {
  if (!value.includes('"')) return `"${value}"`;
  return `concat("${value.split('"').join('", \'"\', "')}")`;
}

/**
 * Поставить карточку под кадр: подвести её верх к верху окна.
 *
 * `scrollIntoViewIfNeeded` ставит элемент по центру, и у высокой карточки её
 * низ уходит за границу окна — снимок по области тогда отказывает целиком
 * («clipped area is outside the resulting image»), а не обрезается. Поэтому
 * прокручиваем сами, и ровно на столько, чтобы область начиналась в окне.
 */
export async function bringIntoView(page, selector, offset = 24) {
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const box = await element.boundingBox();
  if (!box) throw new Error(`область ${selector} не найдена`);
  await page.evaluate((dy) => window.scrollBy(0, dy), box.y - offset);
  await page.waitForTimeout(400);
}

/** Кадр по карточке: сначала подвести её под кадр, потом снять. */
export async function shotCard(scenario, page, id, selector, padding = 20) {
  await bringIntoView(page, selector, padding + 8);
  await scenario.shot(page, id, { clip: selector, padding });
}

/**
 * Закрыть модальное окно. Escape закрывает его штатно, но подложка успевает
 * перехватить следующий клик — ждём, пока она уйдёт из разметки.
 */
export async function closeModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
}

/**
 * Выдуманные домены закрываются в кадрах ЭТОЙ пачки дополнительно к общему
 * списку. Не потому, что они секрет, а потому, что проверка каталога снимков
 * (`tools/qa/check-help-shots.mjs`) краснеет на любом чужом домене в тексте
 * кадра — так она ловит кадр, переснятый не на стенде, а на живой системе
 * заказчика. Подсказки полей интеграций содержат адреса из документации
 * (`…atlassian.net`, `github.com`), и единственный честный способ оставить
 * проверку строгой — закрыть их, а не смягчать правило под весь каталог.
 */
export const DOC_HOSTS = [
  '[A-Za-z0-9\\u0400-\\u04FF-]+\\.atlassian\\.(?:net|com)',
  '(?:api\\.)?github\\.com',
  'gitlab\\.com',
  'models\\.dev',
];

/**
 * Любой адрес НЕ на петле. Правило шире, чем кажется, и это осознанно: карточка
 * удалённого доступа показывает адрес, который панель узнала у настоящего
 * `tailscale serve` на машине съёмки, — а в нём стоит имя владельца машины.
 * Подменить его нечем (это ответ системы, а не настройка), поэтому он
 * закрывается по ВИДУ. Петлевые адреса (`http://127.0.0.1:5297`) правилу не
 * подходят: у них нет буквенного домена, и в кадре они остаются как есть.
 */
export const EXTERNAL_URL = 'https?://[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}(?::\\d+)?[^\\s]*';

/**
 * Путь к УСТАНОВКЕ самой панели на машине съёмки. Появляется там, где команда
 * запуска собрана панелью из собственного расположения: MCP-прокси Atlassian
 * стоит в списке серверов строкой `<node> <репозиторий>/tools/mcp/atlassian.mjs`.
 * Пути стенда (`C:\work\claude-demo-*`) закрывать не нужно и вредно — они и
 * есть предмет кадра; закрывается ровно то, что принадлежит машине владельца.
 */
export const INSTALL_PATH = [
  // Папка клона — нынешнее имя или прежнее (оно собрано задом наперёд: литерала
  // в дереве нет, историю переписывают заменой слова).
  `[A-Za-z]:\\\\[^\\s]*?(?:agentdeck|${[...'lortnoc-edualc'].reverse().join('')})\\\\tools\\\\[^\\s]+`,
  '[A-Za-z]:\\\\[^\\s]*?node\\.exe',
];

/** Полный список замазываний для кадров этой пачки. */
export const PACK_MASKS = [...DEFAULT_MASKS, EXTERNAL_URL, ...DOC_HOSTS, ...INSTALL_PATH];

/**
 * Опись с общим для пачки списком замазываний. Правило кадра задаётся ОДИН раз
 * на всю съёмку, а не повторяется у каждого вызова: забытый на одном кадре
 * список — это и есть утечка, а забыть его в сорока местах проще, чем в одном.
 */
export function maskedScenario(scenario) {
  return {
    ...scenario,
    shot: (page, id, options = {}) => scenario.shot(page, id, { maskText: PACK_MASKS, ...options }),
  };
}

/**
 * Выдуманный верх: то, во что панель упирается вместо облака вендора.
 *
 * Один процесс отвечает за всех, кого эта пачка проверяет по-настоящему:
 *
 *   GET  /v1/models              — список моделей для «Проверить связь»;
 *   POST /v1/messages            — модель в диалекте Anthropic (для прокси);
 *   POST /v1/chat/completions    — она же в диалекте OpenAI;
 *   GET  /rest/api/3/myself      — Jira в облаке (Basic: почта и токен);
 *   GET  /rest/api/2/myself      — Jira своей установки (Bearer);
 *   GET  /api/v4/user            — GitLab «кто я»;
 *   POST /hooks/qa               — приёмник вебхука.
 *
 * Модель отвечает ЭХОМ: прокси защиты данных подставляет в ответ настоящие
 * значения вместо меток, и без эха эту подстановку нечем было бы показать.
 */
export function fakeUpstream(port) {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
        });
        response.end(text);
      };

      if (path === '/v1/models') {
        return send(200, {
          object: 'list',
          data: [
            { id: 'qa-mini', object: 'model' },
            { id: 'qa-standard', object: 'model' },
            { id: 'qa-long', object: 'model' },
          ],
        });
      }

      if (path === '/v1/messages') {
        return send(200, {
          id: 'msg_demo',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: `Принято: ${firstText(body)}` }],
        });
      }

      if (path === '/v1/chat/completions') {
        return send(200, {
          id: 'chatcmpl-demo',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: `Принято: ${firstText(body)}` } },
          ],
        });
      }

      // Облако Jira отвечает только на Basic — по этому и различается диалект.
      if (path === '/rest/api/3/myself') {
        const auth = request.headers.authorization ?? '';
        if (!auth.startsWith('Basic ')) return send(401, { message: 'unauthorized' });
        return send(200, { displayName: 'Отдел контроля качества' });
      }
      if (path === '/rest/api/2/myself') {
        return send(200, { name: 'Отдел контроля качества' });
      }

      if (path === '/api/v4/user') {
        return send(200, { username: 'qa-release-bot' });
      }

      if (path === '/hooks/qa') {
        return send(200, { ok: true });
      }

      return send(404, { error: 'not found' });
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/** Первая текстовая строка тела запроса — в обоих диалектах она лежит по-разному. */
function firstText(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed.messages?.[0]?.content;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map((part) => part.text ?? '').join(' ');
    return '';
  } catch {
    return '';
  }
}
