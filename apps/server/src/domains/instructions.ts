import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AppSettings, InstructionsFileInfo } from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { providerBackupName, readTextFile, writeTextFile } from '../lib/safe-io.ts';

/**
 * Раздел «Глобальные инструкции» — универсальный по активному провайдеру.
 *
 * Первый реально кросс-провайдерный раздел: у Claude это CLAUDE.md, у Codex —
 * AGENTS.md, у Gemini — GEMINI.md. Файл берётся у активного провайдера
 * (`instructionsFile`), а не хардкодится. Провайдер без задокументированного
 * файла (`globalInstructions` ≠ `ready` или нет `instructionsFile`) раздел не
 * поддерживает — резолвер возвращает `undefined`, маршрут отвечает 4xx, путь
 * панель НЕ угадывает (fail-closed).
 *
 * Запись идёт через `writeTextFile` из safe-io: бэкап перед записью (если файл
 * есть) + атомарная запись + рекурсивное создание каталога — значит `~/.codex`
 * или `~/.gemini` создаются при явном сохранении пользователем, и это безопасно.
 * Пишем ТОЛЬКО в `instructionsFile` активного провайдера — никакие другие его
 * файлы не затрагиваются.
 */

/** Минимум настроек, нужный резолверу инструкций (без импорта AppStore). */
interface InstructionsSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Разрешённая цель раздела инструкций: провайдер + путь к его файлу. */
export interface InstructionsTarget {
  provider: ConfigProvider;
  filePath: string;
  fileName: string;
  cliDetected: boolean;
}

/**
 * Определить файл инструкций активного провайдера — или `undefined`, если раздел
 * им не поддержан (маршрут ответит 4xx). Claude уважает пользовательский каталог
 * (override/env): путь берётся из уже определённого location (`claudeMdPath`),
 * чтобы поведение раздела не изменилось (регресс-ноль). Прочие ready-провайдеры
 * глобальны — путь строится их `instructionsFile` от домашнего каталога.
 */
export function resolveInstructionsTarget(
  store: InstructionsSettingsSource,
  claudeMdPath: string,
): InstructionsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.globalInstructions !== 'ready' || !provider.instructionsFile) {
    return undefined;
  }

  const filePath =
    provider.id === 'claude'
      ? claudeMdPath
      : provider.instructionsFile(store.getSettings().claudeDirOverride);

  return {
    provider,
    filePath,
    fileName: basename(filePath),
    // Детект CLI по наличию его каталога конфигурации (~/.claude|~/.codex|~/.gemini).
    // Достаточно для неалармирующей подсказки — точный поиск бинаря не нужен.
    cliDetected: existsSync(dirname(filePath)),
  };
}

/** Прочитать файл инструкций + метаданные для клиента. Нет файла → пустой контент, `exists:false`. */
export function readInstructionsInfo(target: InstructionsTarget): InstructionsFileInfo {
  return {
    content: readTextFile(target.filePath),
    exists: existsSync(target.filePath),
    fileName: target.fileName,
    filePath: target.filePath,
    cliDetected: target.cliDetected,
    providerId: target.provider.id,
    providerName: target.provider.name,
  };
}

/**
 * Записать файл инструкций активного провайдера: бэкап + атомарно + рекурсивное
 * создание каталога (safe-io). Возвращает путь бэкапа (или `undefined`, если
 * копии выключены / файла ещё не было). Пишет ТОЛЬКО в `target.filePath`.
 */
export function writeInstructions(
  target: InstructionsTarget,
  content: string,
  backupDir: string | undefined,
): string | undefined {
  // Копия claude сохраняет ПРЕЖНЕЕ имя (`CLAUDE.md.<метка>.bak`) — иначе история
  // и откат потеряли бы ленту правил (регресс-ноль). Прочим провайдерам имя
  // префиксуем их id: `AGENTS.md` есть и у Codex, и у OpenCode — без префикса их
  // копии смешались бы в одной ротации, а откат вернул бы файл не тому CLI.
  const backupName =
    target.provider.id === 'claude'
      ? undefined
      : providerBackupName(target.provider.id, target.filePath);
  // preserveForm по умолчанию: текст приходит из <textarea> (браузер шлёт CRLF) —
  // приводим его к стилю файла, иначе в LF-файле появились бы смешанные окончания.
  return writeTextFile(target.filePath, content, { backupDir, backupName });
}
