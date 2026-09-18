import { existsSync } from 'node:fs';
import type { UniversalMcpServerDraft } from '@agentdeck/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import {
  deleteProviderMcpServer,
  readProviderMcpServers,
  resolveProviderMcpTarget,
  upsertProviderMcpServer,
  McpServerNotFoundError as ProviderMcpServerNotFoundError,
} from './provider-mcp.ts';
import type { ProviderMcpSettingsSource, ProviderMcpTarget } from './provider-mcp/types.ts';
import { serverText } from '../lib/server-texts.ts';
import {
  McpServerNotFoundError,
  assertMcpServerExists,
  deleteMcpServer,
  saveMcpServer,
} from './mcp.ts';

/**
 * Переходники панели: как записать СВОЙ MCP-сервер в конфигурацию CLI.
 *
 * У панели их два — Jira с Confluence (`tools/mcp/atlassian.mjs`) и контур
 * компании (`tools/mcp/platform.mjs`), — и правило записи у них одно на двоих:
 * запись идёт в конфиг АКТИВНОГО провайдера, если он умеет MCP, иначе в
 * `~/.claude.json`; повторное нажатие обновляет запись, а не отказывает 409
 * (кнопку жмут как раз после переезда панели на другой порт).
 *
 * ГЛАВНОЕ СВОЙСТВО ОБОИХ: в окружение записи уходит ТОЛЬКО адрес панели. Ни
 * токен Atlassian, ни ключ контура в процесс CLI не попадают никогда —
 * переходник ходит в панель, а наружу ходит уже она.
 *
 * Общий модуль, а не копия на каждый переходник: две копии этой развилки
 * разошлись бы молча, и один из переходников однажды начал бы писать в чужой
 * файл.
 */

export interface PanelBridge {
  /**
   * Имя записи в конфиге. С префиксом панели намеренно: без него имя совпало бы
   * с самым вероятным именем ОФИЦИАЛЬНОГО чужого сервера, и запись легла бы
   * поверх настройки, которую панель не заводила.
   */
  id: string;
  /**
   * Имя той же записи до переименования продукта (17.09.2026). Такая запись уже
   * лежит в конфигурации CLI у людей: она считается подключённой, повторная
   * регистрация переименовывает её, снятие убирает и её.
   */
  legacyId?: string;
  /** Путь к скрипту переходника в репозитории панели. */
  script: string;
}

export interface PanelBridgeTarget {
  mcpConfigPath: string;
  backupDir?: string;
  /** Адрес самой панели: `http://127.0.0.1:5178`. */
  selfBaseUrl: string;
  /**
   * Настройки панели — по ним определяется АКТИВНЫЙ провайдер. Не задан —
   * работаем с конфигом Claude, как было до универсальных провайдеров.
   */
  store?: ProviderMcpSettingsSource;
}

/**
 * Куда писать запись. Разделения по имени CLI здесь нет намеренно: вопрос
 * решает способность провайдера (`capabilities.mcp` + `mcpConfig`), которую он
 * объявляет сам.
 */
function providerTarget(options: PanelBridgeTarget): ProviderMcpTarget | undefined {
  return options.store ? resolveProviderMcpTarget(options.store) : undefined;
}

/**
 * Почему активному CLI переходник записать НЕКУДА — либо пусто, если есть куда.
 *
 * Провайдер без MCP не получает записи вовсе, а не молча получает её в чужой
 * файл. Развилка тут неочевидная, и без этой проверки она работала наоборот:
 * `resolveProviderMcpTarget` возвращает `undefined` и у Claude (у него нет
 * своего `mcpConfig`, он живёт в `~/.claude.json` — и запасной путь для него
 * ПРАВИЛЬНЫЙ), и у провайдера, который MCP не умеет вовсе. Второй случай
 * сваливался в тот же запасной путь: панель писала в конфигурацию Claude Code,
 * рапортовала успех, а CLI, которым человек работает, никакого инструмента не
 * получал.
 */
export function bridgeRefusalReason(store?: ProviderMcpSettingsSource): string | undefined {
  if (!store) return undefined;
  const provider = getActiveProvider(store);
  if (provider.capabilities.mcp === 'ready') return undefined;
  return serverText('panel-mcp-no-section', { provider: provider.name });
}

function universalDraft(bridge: PanelBridge, selfBaseUrl: string): UniversalMcpServerDraft {
  return {
    name: bridge.id,
    transport: 'stdio',
    // Тем же Node, которым работает сама панель: искать `node` в PATH незачем,
    // а на Windows это ещё и разные `node.exe` у разных менеджеров версий.
    command: process.execPath,
    args: [bridge.script],
    // ТОЛЬКО адрес. Секрет сюда не попадает ни при каких условиях.
    env: { AGENTDECK_URL: selfBaseUrl },
    headers: {},
  };
}

/** Скрипт переходника на месте? Панель могли запустить не из своего репозитория. */
export function bridgeScriptExists(bridge: PanelBridge): boolean {
  return existsSync(bridge.script);
}

/** Завести или обновить запись о переходнике. Возвращает имя записи. */
export function registerPanelBridge(bridge: PanelBridge, options: PanelBridgeTarget): string {
  const target = providerTarget(options);
  const previous = registeredBridgeId(bridge, options.mcpConfigPath, options.store) ?? null;
  if (target) {
    upsertProviderMcpServer(
      target,
      previous,
      universalDraft(bridge, options.selfBaseUrl),
      options.backupDir,
      { allowOverwrite: true },
    );
    return bridge.id;
  }

  saveMcpServer(
    options.mcpConfigPath,
    previous,
    { ...universalDraft(bridge, options.selfBaseUrl), groupIds: [] },
    options.backupDir,
    { allowOverwrite: true },
  );
  return bridge.id;
}

/** Убрать запись. Нет её — не ошибка: кнопку могли нажать дважды. */
export function unregisterPanelBridge(bridge: PanelBridge, options: PanelBridgeTarget): boolean {
  const fresh = unregisterById(bridge.id, options);
  const legacy = bridge.legacyId ? unregisterById(bridge.legacyId, options) : false;
  return fresh || legacy;
}

function unregisterById(id: string, options: PanelBridgeTarget): boolean {
  const target = providerTarget(options);
  if (target) {
    try {
      deleteProviderMcpServer(target, id, options.backupDir);
      return true;
    } catch (error) {
      if (error instanceof ProviderMcpServerNotFoundError) return false;
      throw error;
    }
  }

  try {
    deleteMcpServer(options.mcpConfigPath, id, options.backupDir);
    return true;
  } catch (error) {
    if (error instanceof McpServerNotFoundError) return false;
    throw error;
  }
}

/**
 * Зарегистрирован ли переходник — по нему рисуется кнопка «Подключить/Убрать».
 * Спрашивается о ТОМ ЖЕ файле, в который пишет регистрация, иначе кнопка
 * говорила бы о чужой конфигурации.
 */
export function isPanelBridgeRegistered(
  bridge: PanelBridge,
  mcpConfigPath: string,
  store?: ProviderMcpSettingsSource,
): boolean {
  return registeredBridgeId(bridge, mcpConfigPath, store) !== undefined;
}

/** Под каким именем переходник записан: нынешним, прежним или никаким. */
export function registeredBridgeId(
  bridge: PanelBridge,
  mcpConfigPath: string,
  store?: ProviderMcpSettingsSource,
): string | undefined {
  const target = store ? resolveProviderMcpTarget(store) : undefined;
  const has = (id: string): boolean =>
    target ? isRegisteredIn(target, id) : existing(mcpConfigPath, id) !== null;
  if (has(bridge.id)) return bridge.id;
  if (bridge.legacyId && has(bridge.legacyId)) return bridge.legacyId;
  return undefined;
}

/** Есть ли запись в разделе провайдера. Нечитаемый чужой конфиг — «нет». */
function isRegisteredIn(target: ProviderMcpTarget, id: string): boolean {
  try {
    return readProviderMcpServers(target).some((server) => server.name === id);
  } catch {
    // Чужой файл может не разбираться вовсе — это его дело, а не повод падать
    // на вопросе «подключено ли»: раздел ответит честным «нет».
    return false;
  }
}

function existing(mcpConfigPath: string, id: string): string | null {
  try {
    assertMcpServerExists(mcpConfigPath, id);
    return id;
  } catch {
    return null;
  }
}
