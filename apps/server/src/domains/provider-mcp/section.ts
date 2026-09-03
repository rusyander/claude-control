import type { UniversalMcpServer, UniversalMcpServerDraft } from '@claude-control/contracts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { readTextFile } from '../../lib/safe-io.ts';
import { findBlockOf, scanMcpBlocks, type McpBlockScan } from './blocks.ts';
import { readCodexServers, upsertCodexServer, deleteCodexServer } from './codex-format.ts';
import {
  mapContinueServers,
  removeContinueEntry,
  upsertContinueEntry,
  upsertContinueServer,
  deleteContinueServer,
  writeContinueBlock,
} from './continue-format.ts';
import { readGooseServers, upsertGooseServer, deleteGooseServer } from './goose-format.ts';
import { readJsonMcpServers, upsertJsonMcpServer, deleteJsonMcpServer } from './json-format.ts';
import {
  readOpencodeServers,
  upsertOpencodeServer,
  deleteOpencodeServer,
} from './opencode-format.ts';
import { readContinueServers } from '../../lib/continue-yaml.ts';
import { readGooseExtensions } from '../../lib/goose-yaml.ts';
import { McpServerExistsError, McpServerNotFoundError } from './draft.ts';
import { sortByName } from './values.ts';
import type { ProviderMcpSection, ProviderMcpTarget } from './types.ts';

// --- Диспетчер по формату ----------------------------------------------------

/**
 * Серверы ОСНОВНОГО файла цели (без файлов-блоков). Бросает
 * `UnrecognizedFormatError`, если формат не распознан.
 */
function readMainFileServers(target: ProviderMcpTarget): UniversalMcpServer[] {
  const text = readTextFile(target.filePath);
  if (!text.trim()) return [];
  switch (target.format) {
    case 'json':
      return readJsonMcpServers(text);
    case 'opencode-json':
      return readOpencodeServers(text);
    case 'continue-yaml':
      return mapContinueServers(readContinueServers(text));
    case 'goose-yaml':
      return readGooseServers(text);
    default:
      return readCodexServers(text);
  }
}

/**
 * Прочитать раздел: основной файл плюс файлы-блоки (Continue). Серверы блока
 * несут путь своего файла в `sourceFile` — без него человек не поймёт, какой
 * файл изменится при правке. Порядок общий: по имени.
 *
 * Основной файл fail-closed целиком (не распознан → бросаем), файлы-блоки —
 * порознь: непонятный блок уходит в `skippedBlocks`, остальные работают.
 */
export function readProviderMcpSection(target: ProviderMcpTarget): ProviderMcpSection {
  const main = readMainFileServers(target);
  if (!target.blockDir) return { servers: main, skippedBlocks: [] };

  const scan = scanMcpBlocks(
    target.blockDir,
    main.map((server) => server.name),
  );

  const fromBlocks = scan.files.flatMap((file) =>
    mapContinueServers(file.servers).map((server) => ({ ...server, sourceFile: file.path })),
  );

  return {
    servers: sortByName([...main, ...fromBlocks]),
    skippedBlocks: scan.skipped,
  };
}

/** Прочитать список серверов раздела (основной файл + блоки). */
export function readProviderMcpServers(target: ProviderMcpTarget): UniversalMcpServer[] {
  return readProviderMcpSection(target).servers;
}

/**
 * Есть ли у провайдера запись с таким именем. Встроенные расширения Goose в
 * списке серверов не показываются, но в файле есть — их удаление отвергает сам
 * формат (422 «не редактируется»), а не «нет такого».
 */
function isKnownServer(target: ProviderMcpTarget, serverId: string): boolean {
  if (readProviderMcpServers(target).some((server) => server.name === serverId)) return true;
  return (
    target.format === 'goose-yaml' &&
    readGooseExtensions(readTextFile(target.filePath)).has(serverId)
  );
}

/**
 * Файл, в котором лежит существующая запись: файл-блок или основной конфиг.
 * Новая запись (`serverId === null`) всегда идёт в основной конфиг — своих
 * файлов-блоков панель не заводит.
 */
function blockPathOf(target: ProviderMcpTarget, serverId: string | null): string | undefined {
  if (!target.blockDir || serverId === null) return undefined;

  let scan: McpBlockScan;
  try {
    // Имена основного файла нужны как «занятые»: блок, повторяющий их, пропущен
    // и правке не подлежит — иначе панель писала бы в файл, который не показывает.
    scan = scanMcpBlocks(
      target.blockDir,
      readMainFileServers(target).map((server) => server.name),
    );
  } catch (error) {
    // Основной файл не разбирается — писать в блоки тоже нельзя: неизвестно,
    // какие имена он занимает. Раздел и так уже только для чтения.
    if (error instanceof UnrecognizedFormatError) return undefined;
    throw error;
  }

  return findBlockOf(scan, serverId)?.path;
}

/**
 * Добавить или изменить сервер (при переименовании `serverId` — прежнее имя).
 *
 * Создание с занятым именем и переименование в занятое имя — ОТКАЗ
 * (`McpServerExistsError` → 409), а не запись поверх: запись шла по имени
 * безусловно, и «github» из формы молча заменял настроенный «github» —
 * пользователь видел «сохранено», а прежняя команда/адрес исчезали. Осознанная
 * замена (перенос между провайдерами, самопроверка, предпросмотр) передаёт
 * `allowOverwrite` явно.
 */
export function upsertProviderMcpServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
  options?: { allowOverwrite?: boolean },
): string | undefined {
  if (serverId !== draft.name && !options?.allowOverwrite) {
    // Список берём из того же файла тем же читателем — форма имени у каждого
    // формата своя (ключ отображения, `name` внутри записи у continue).
    const taken = readProviderMcpServers(target).some((server) => server.name === draft.name);
    if (taken) throw new McpServerExistsError(draft.name);
  }

  // Запись из файла-блока правится В СВОЁМ файле: перенести её в основной конфиг
  // значило бы оставить в блоке прежнюю копию — Continue грузит оба файла.
  const blockPath = blockPathOf(target, serverId);
  if (blockPath) {
    return writeContinueBlock(
      target,
      blockPath,
      (servers) => upsertContinueEntry(servers, serverId, draft),
      backupDir,
    );
  }

  switch (target.format) {
    case 'json':
      return upsertJsonMcpServer(target, serverId, draft, backupDir);
    case 'opencode-json':
      return upsertOpencodeServer(target, serverId, draft, backupDir);
    case 'continue-yaml':
      return upsertContinueServer(target, serverId, draft, backupDir);
    case 'goose-yaml':
      return upsertGooseServer(target, serverId, draft, backupDir);
    default:
      return upsertCodexServer(target, serverId, draft, backupDir);
  }
}

/** Удалить сервер по имени. */
export function deleteProviderMcpServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  // Несуществующее имя — 404, а не тихое «удалено»: иначе опечатка в имени
  // выглядела бы как успех (у Claude `/api/mcp/:id` отвечает так же).
  if (!isKnownServer(target, serverId)) throw new McpServerNotFoundError(serverId);

  // Удаляем оттуда же, где запись лежит: убрать её из основного конфига,
  // оставив в блоке, значит «удалить» сервер, который Continue продолжит грузить.
  const blockPath = blockPathOf(target, serverId);
  if (blockPath) {
    return writeContinueBlock(
      target,
      blockPath,
      (servers) => removeContinueEntry(servers, serverId),
      backupDir,
    );
  }

  switch (target.format) {
    case 'json':
      return deleteJsonMcpServer(target, serverId, backupDir);
    case 'opencode-json':
      return deleteOpencodeServer(target, serverId, backupDir);
    case 'continue-yaml':
      return deleteContinueServer(target, serverId, backupDir);
    case 'goose-yaml':
      return deleteGooseServer(target, serverId, backupDir);
    default:
      return deleteCodexServer(target, serverId, backupDir);
  }
}
