import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  QWEN_SYSTEM_SETTINGS_ENV,
  baseSystemSettings,
} from '../../groups/qwen-layer/qwen-layer.ts';
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
    // Каталог без файла настроек — недописанный прошлый (сбой посреди сборки).
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
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
