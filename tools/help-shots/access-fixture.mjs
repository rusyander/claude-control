/**
 * Обстановка для кадров пачки «Доступы» (`permissions`, `mcp`, `env`).
 *
 * Три раздела пачки — про три файла на диске и про одно рукопожатие, поэтому
 * подменять здесь почти нечего и не нужно. Панель поднимается со СВОИМ
 * каталогом конфигурации и правит настоящие `settings.json`,
 * `settings.local.json`, `.mcp-secrets.env` и `.claude.json`; проверка связи
 * ведёт настоящий обмен MCP с процессом, который тут же и запускается. Личный
 * `~/.claude` владельца машины не читается и не правится ни на шаг.
 *
 * Стенд лежит РЯДОМ с репозиторием, а не во временной папке, по одной причине:
 * путь попадает в кадр. Карточка MCP-сервера показывает команду запуска целиком,
 * а `%TEMP%` на Windows начинается с имени пользователя — в справку, которую
 * читают чужие люди, не уезжает ни одно имя человека. По той же причине панели
 * подсовывается собственный домашний каталог: раздел «Права» показывает его в
 * карточке системы.
 *
 * Каталог помечается файлом-меткой и сносится в конце — метка не даёт снести
 * чужую папку, если имя совпало.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './kit.mjs';

/** Корень одноразового стенда: сосед репозитория, а не его подкаталог. */
export const STAND = join(dirname(REPO_ROOT), 'claude-demo');

/** Каталог конфигурации панели — то, что уезжает в `CLAUDE_CONFIG_DIR`. */
export const CONFIG_DIR = join(STAND, '.claude');

/** Домашний каталог, который увидит панель: без имени человека. */
export const HOME_DIR = join(STAND, 'home');

/** Реестр MCP-серверов лежит НЕ внутри `.claude`, а рядом — так его ищет панель. */
export const MCP_CONFIG = join(STAND, '.claude.json');

/** Выдуманный сервер заказов: его команда видна в кадре, поэтому путь опрятный. */
export const ORDERS_SERVER = join(STAND, 'orders-mcp', 'server.mjs').replace(/\\/g, '/');

/** Метка «каталог создан съёмкой» — без неё чужая папка не сносится. */
const MARK = '.help-shots-owned';

const SETTINGS = join(CONFIG_DIR, 'settings.json');
const SETTINGS_LOCAL = join(CONFIG_DIR, 'settings.local.json');
const SECRETS = join(CONFIG_DIR, '.mcp-secrets.env');
const STATE = join(CONFIG_DIR, 'agentdeck', 'state.json');

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Создать стенд. Выдуманный MCP-сервер копируется из `tools/help-shots`: запускать
 * его из репозитория значило бы показать в кадре путь к самой съёмке — человеку,
 * который читает про «подключение сервера», это только мешает.
 */
export function makeStand() {
  if (existsSync(STAND) && !existsSync(join(STAND, MARK))) {
    throw new Error(`${STAND} уже существует и создан не съёмкой — выберите другой путь`);
  }
  mkdirSync(join(CONFIG_DIR, 'agentdeck'), { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(join(STAND, 'orders-mcp'), { recursive: true });
  writeFileSync(join(STAND, MARK), 'создан tools/help-shots/permissions-panel.mjs\n', 'utf8');
  copyFileSync(join(import.meta.dirname, 'demo-mcp-server.mjs'), ORDERS_SERVER);
  writeState();
  return STAND;
}

/** Снести стенд — но только тот, который создали мы. */
export function dropStand() {
  if (existsSync(join(STAND, MARK))) rmSync(STAND, { recursive: true, force: true });
}

/**
 * Состояние панели. Мастер первого запуска закрыт, тема задана явно: кадры не
 * должны зависеть от темы машины, на которой идёт съёмка.
 */
export function writeState(patch = {}) {
  writeFileSync(
    STATE,
    json({
      projects: [],
      settings: { onboardingDone: true, theme: 'light', language: 'ru' },
      ...patch,
    }),
    'utf8',
  );
}

/** `settings.json` целиком: права, переменные и всё, что раздел показывает. */
export function writeSettings(value = {}) {
  writeFileSync(SETTINGS, json(value), 'utf8');
}

/** `settings.local.json`: те же ключи, но файл личный и в git не попадает. */
export function writeSettingsLocal(value) {
  if (value === undefined) rmSync(SETTINGS_LOCAL, { force: true });
  else writeFileSync(SETTINGS_LOCAL, json(value), 'utf8');
}

/** `.mcp-secrets.env` построчно: комментарий над строкой — это её пояснение. */
export function writeSecrets(text) {
  if (text === undefined) rmSync(SECRETS, { force: true });
  else writeFileSync(SECRETS, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

/** `.claude.json`: `mcpServers` — включённые, `mcpServersDisabled` — погашенные. */
export function writeMcpConfig(value = {}) {
  writeFileSync(MCP_CONFIG, json(value), 'utf8');
}

/**
 * Записи серверов для сценариев `mcp/*`. Собраны так, чтобы КАЖДЫЙ исход был
 * настоящим, а не нарисованным:
 *
 *   orders    — отвечает: рукопожатие с `demo-mcp-server.mjs`, пять инструментов;
 *   warehouse — не отвечает: команды `warehouse-mcp` нет в PATH, ENOENT от системы;
 *   billing   — свой заголовок `Authorization` со ссылкой `${BILLING_TOKEN}`:
 *               пока переменной нет, панель отказывается ещё до соединения и
 *               называет её; когда появится — тот же 401 читается уже как
 *               «токен отвергнут», а не как «нужен вход»;
 *   crm       — тот же сервер, но БЕЗ своего заголовка: 401 с `WWW-Authenticate`
 *               значит «войдите через OAuth».
 */
export function mcpServers({ oauthPort }) {
  const unauthorized = `http://127.0.0.1:${oauthPort}/mcp`;
  return {
    orders: { type: 'stdio', command: 'node', args: [ORDERS_SERVER] },
    warehouse: { type: 'stdio', command: 'warehouse-mcp', args: ['--stdio'] },
    billing: {
      type: 'http',
      url: unauthorized,
      headers: { Authorization: 'Bearer ${BILLING_TOKEN}' },
    },
    crm: { type: 'http', url: unauthorized },
  };
}

/** Права, с которыми открывается сценарий «разбор»: уже настроенный компьютер. */
export const AUDIT_PERMISSIONS = {
  allow: [
    'Read',
    'Edit',
    'Bash(npm run:*)',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'WebSearch',
    'Skill',
    'mcp__orders__list_orders',
    'mcp__orders__order_details',
    'mcp__orders__export_orders',
  ],
  ask: ['Write', 'Bash(git commit:*)', 'WebFetch', 'Task', 'mcp__orders__sync_stock'],
  deny: ['Bash(rm:*)', 'Bash(git push:*)', 'mcp__orders__refund_order'],
};

/** Открыть раздел панели по адресу и дождаться, пока он дорисуется. */
export async function openSection(page, web, path, pause = 1500) {
  await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(pause);
}

/**
 * Закрыть модальное окно. Escape закрывает его штатно, но подложка успевает
 * перехватить следующий клик — ждём, пока она уйдёт из разметки.
 */
export async function closeModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
}

/** Переменные для сценариев `env/*`: секрет, адрес и настройка поведения. */
export const SECRETS_FILE = `# Токен склада: личный кабинет → Доступы → Создать токен
WAREHOUSE_TOKEN=whk_3f8a21d05c6b4e97a1d2
# Ключ службы доставки, выдаёт менеджер направления
DELIVERY_API_KEY=dl_77b1c4e0aa93
`;
