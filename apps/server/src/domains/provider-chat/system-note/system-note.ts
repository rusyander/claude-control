import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  QWEN_SYSTEM_SETTINGS_ENV,
  baseSystemSettings,
} from '../../groups/qwen-layer/qwen-layer.ts';
import { HEAVY_QUEUE_ENV, heavyQueueHooks } from '../../chat/group-profile/group-profile.ts';
import { pruneStaleLayers } from '../../groups/qwen-run-layer/qwen-run-layer.ts';
import { layerDigest } from '../../groups/run-layer-parts.ts';
import { renameWithRetry, writeJsonFile, writeTextFile } from '../../../lib/safe-io/safe-io.ts';

/**
 * Строка панели о каталоге проекта — в СИСТЕМНЫЙ промпт Qwen Code, а не в
 * реплику человека (владелец 11.10). В реплике её видел родной хук Qwen в
 * `prompt` и модель читала её как слова человека.
 *
 * Пути попроще нет (qwen 0.25 живьём, 11.10): у `qwen serve` флага
 * `--append-system-prompt` нет — с ним сервер не поднимается, `POST /session`
 * поля системного промпта не принимает, аргументы дочерним `--acp` не
 * пробрасываются, а `QWEN_SYSTEM_MD` ЗАМЕНЯЕТ встроенный промпт целиком. Работает
 * файл контекста: `QWEN.md` каталога из `context.includeDirectories` файла
 * системных настроек ложится в системный промпт (заглушка модели: строка в
 * `system`, в `user` её нет) — тот же механизм, что везёт правила групп.
 *
 * Слой кладётся ПОВЕРХ того файла системных настроек, что уже выбран для прогона
 * (`env[QWEN_CODE_SYSTEM_SETTINGS_PATH]` — слой групп, если он есть, иначе файл
 * машины): ни группы, ни настройки администратора не теряются.
 */

const NOTE_FILE = 'QWEN.md';
const SETTINGS_FILE = 'system-settings.json';

export function qwenNoteLayersRoot(appData: string): string {
  return join(appData, 'qwen-note-layers');
}

function objectAt(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Текст `QWEN.md`: та же обёртка, что была в реплике, — модель узнаёт голос панели. */
export function qwenNoteText(note: string): string {
  return `<agentdeck-workspace>${note.trim()}</agentdeck-workspace>\n`;
}

/**
 * Записать слой и вернуть переменную, которая его включает. Пустая строка —
 * `undefined`: слоя нет, прогон идёт на прежних настройках.
 */
export function writeQwenSystemNote(options: {
  appData: string;
  note: string;
  /** Окружение прогона поверх окружения панели: отсюда берётся текущий файл настроек. */
  env: NodeJS.ProcessEnv;
  now?: number;
}): Record<string, string> | undefined {
  const note = options.note.trim();
  if (!note) return undefined;
  const base = baseSystemSettings(options.env);
  const text = qwenNoteText(note);
  // Каталог — по содержимому: два разговора одного проекта делят его, и ни один
  // не переписывает файл, который в эту секунду читает уже запущенный CLI.
  const digest = layerDigest({ kind: 'qwen-system-note', base, text });
  const root = qwenNoteLayersRoot(options.appData);
  const dir = join(root, digest);
  const now = options.now ?? Date.now();
  if (!existsSync(join(dir, SETTINGS_FILE))) {
    const staging = join(root, `.${digest}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    writeTextFile(join(staging, NOTE_FILE), text);
    const context = objectAt(base.context);
    const included = Array.isArray(context.includeDirectories) ? context.includeDirectories : [];
    writeJsonFile(join(staging, SETTINGS_FILE), {
      ...base,
      context: {
        ...context,
        includeDirectories: [...included, dir],
        loadFromIncludeDirectories: true,
      },
    });
    // Каталог без файла настроек — недописанный прошлый (сбой посреди сборки). Файл
    // есть — соседний прогон успел первым, пока писался черновик: его каталог не трогать.
    if (existsSync(dir) && !existsSync(join(dir, SETTINGS_FILE))) {
      rmSync(dir, { recursive: true, force: true });
    }
    try {
      renameWithRetry(staging, dir);
    } catch {
      // Соседний прогон успел первым — его каталог того же содержимого.
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    // Слой в ходу: свежая метка не даёт уборке снести его под работающим CLI.
    const stamp = new Date(now);
    utimesSync(dir, stamp, stamp);
  }
  pruneStaleLayers(root, digest, now);
  return { [QWEN_SYSTEM_SETTINGS_ENV]: join(dir, SETTINGS_FILE) };
}

/**
 * Окно и сроки локальной модели для Qwen Code (L4b, бандл 0.25.0).
 *
 * Qwen Code не знает окна незнакомой модели и берёт по имени; на локальной оно другое, и
 * автосжатие истории считалось бы от чужого числа. Читает он `model.generationConfig` из
 * настроек: `contextWindowSize` (окно для сжатия и шапки), `timeout` (весь запрос) и
 * `streamIdleTimeoutMs` (пауза в потоке; умолчание 240 с короче законного разбора
 * промпта). Слой кладётся ПОВЕРХ уже выбранного файла системных настроек — группы и
 * настройки администратора остаются, как у строки о каталоге.
 */
export interface QwenLocalLimits {
  contextWindow: number;
  timeoutMs: number;
  idleMs: number;
}

export function qwenLimitLayersRoot(appData: string): string {
  return join(appData, 'qwen-limit-layers');
}

export function writeQwenLimits(options: {
  appData: string;
  limits: QwenLocalLimits;
  env: NodeJS.ProcessEnv;
  now?: number;
}): Record<string, string> {
  const base = baseSystemSettings(options.env);
  const model = objectAt(base.model);
  const merged = {
    ...base,
    model: {
      ...model,
      generationConfig: {
        ...objectAt(model.generationConfig),
        contextWindowSize: options.limits.contextWindow,
        timeout: options.limits.timeoutMs,
        streamIdleTimeoutMs: options.limits.idleMs,
      },
    },
  };
  return writeSettingsLayer(
    qwenLimitLayersRoot(options.appData),
    layerDigest({ kind: 'qwen-local-limits', merged }),
    merged,
    options.now,
  );
}

/**
 * Лёгкий набор MCP группы в Qwen Code (6.1): снятые серверы — в `mcp.excluded`
 * слоя поверх выбранного файла системных настроек. Список у Qwen 0.25 сливается
 * между уровнями сложением (`mergeStrategy: "concat"` в схеме бандла), так что
 * исключения человека и администратора остаются. Снимать нечего — слоя нет.
 */
export function qwenMcpLayersRoot(appData: string): string {
  return join(appData, 'qwen-mcp-layers');
}

export function writeQwenMcpExcluded(options: {
  appData: string;
  names: readonly string[];
  env: NodeJS.ProcessEnv;
  now?: number;
}): Record<string, string> | undefined {
  if (options.names.length === 0) return undefined;
  const base = baseSystemSettings(options.env);
  const mcp = objectAt(base.mcp);
  const own = Array.isArray(mcp.excluded) ? mcp.excluded : [];
  const merged = {
    ...base,
    mcp: { ...mcp, excluded: [...new Set([...own, ...options.names])] },
  };
  return writeSettingsLayer(
    qwenMcpLayersRoot(options.appData),
    layerDigest({ kind: 'qwen-mcp-excluded', merged }),
    merged,
    options.now,
  );
}

/**
 * Фоновые вызовы модели Qwen Code, которые панели не нужны (6.3), — слоем поверх
 * выбранного файла системных настроек. `serve` после каждого хода сам просит
 * модель угадать следующую реплику человека; панель эту подсказку не показывает,
 * а документация (`features/followup-suggestions.md`) прямо велит такому клиенту
 * выключать `ui.enableFollowupSuggestions`. Группе разделения (её ведёт не человек)
 * выключены ещё извлечение авто-памяти после хода, её «сон» и авто-навыки: каждый —
 * отдельный вызов модели с перепиской, а выводы из прогона без человека попали бы в
 * личную память Qwen. Обычный разговор память Qwen ведёт, как вёл.
 *
 * Группе тем же слоем едет и очередь тяжёлых шагов (3.2), общая с группами
 * Claude: хуки до и после оболочки, дописанные к хукам выбранного файла, и
 * каталог очереди переменной прогона. Без неё гейт группы Qwen шёл бы мимо
 * очереди и снова делил процессор с соседями.
 */
export function qwenQuietLayersRoot(appData: string): string {
  return join(appData, 'qwen-quiet-layers');
}

export function writeQwenQuietRun(options: {
  appData: string;
  group: boolean;
  env: NodeJS.ProcessEnv;
  heavyQueue?: { hook: string; dir: string };
  now?: number;
}): Record<string, string> {
  const base = baseSystemSettings(options.env);
  const queue = options.group ? options.heavyQueue : undefined;
  const merged = {
    ...base,
    ui: { ...objectAt(base.ui), enableFollowupSuggestions: false },
    ...(options.group
      ? {
          memory: {
            ...objectAt(base.memory),
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
            enableAutoSkill: false,
          },
        }
      : {}),
    ...(queue ? { hooks: withHooks(objectAt(base.hooks), heavyQueueHooks(queue.hook, 1000)) } : {}),
  };
  const layer = writeSettingsLayer(
    qwenQuietLayersRoot(options.appData),
    layerDigest({ kind: 'qwen-quiet-run', merged }),
    merged,
    options.now,
  );
  return queue ? { ...layer, [HEAVY_QUEUE_ENV]: queue.dir } : layer;
}

/** Хуки слоя дописываются к хукам выбранного файла: события групп и машины остаются. */
function withHooks(
  base: Record<string, unknown>,
  added: Record<string, unknown[]>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [event, entries] of Object.entries(added)) {
    const prior = Array.isArray(merged[event]) ? (merged[event] as unknown[]) : [];
    merged[event] = [...prior, ...entries];
  }
  return merged;
}

/** Файл настроек слоя — каталогом по содержимому, как у строки о каталоге. */
function writeSettingsLayer(
  root: string,
  digest: string,
  merged: Record<string, unknown>,
  at: number | undefined,
): Record<string, string> {
  const dir = join(root, digest);
  const now = at ?? Date.now();
  if (!existsSync(join(dir, SETTINGS_FILE))) {
    const staging = join(root, `.${digest}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    writeJsonFile(join(staging, SETTINGS_FILE), merged);
    // Недописанный каталог — снести; готовый соседа (файл на месте) — не трогать.
    if (existsSync(dir) && !existsSync(join(dir, SETTINGS_FILE))) {
      rmSync(dir, { recursive: true, force: true });
    }
    try {
      renameWithRetry(staging, dir);
    } catch {
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    const stamp = new Date(now);
    utimesSync(dir, stamp, stamp);
  }
  pruneStaleLayers(root, digest, now);
  return { [QWEN_SYSTEM_SETTINGS_ENV]: join(dir, SETTINGS_FILE) };
}
