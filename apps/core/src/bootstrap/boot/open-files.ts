import { LOW_OPEN_FILES, type OpenFilesLimit } from '../../platform/limits.ts';
import type { Fact, NotApplicable } from '../../platform/os-kind.ts';
import type { Note } from './boot.types.ts';

/**
 * Предел открытых файлов при загрузке (09 limits, 07:52, F15): мягкий предел ниже
 * `LOW_OPEN_FILES` (macOS по умолчанию 256) — предупреждение в вывод ядра и строка
 * `limits.open-files` в `core.jsonl`. Ядро держит журналы задач, сокеты сессий и потоки CLI
 * разом; упёршись в предел, оно падает EMFILE далеко от причины. Нечитаемый предел и Windows
 * (предела нет) — тоже строка: «не проверено» видно, а не выглядит как «в порядке».
 */
export async function checkOpenFiles(
  read: () => Promise<Fact<OpenFilesLimit> | NotApplicable>,
  note: Note,
  warn?: (line: string) => void,
): Promise<void> {
  let fact: Fact<OpenFilesLimit> | NotApplicable;
  try {
    fact = await read();
  } catch (error) {
    fact = { unknown: error instanceof Error ? error.message : String(error) };
  }
  if ('value' in fact) {
    note('limits.open-files', { ...fact.value });
    if (fact.value.low) {
      warn?.(
        `agentdeck core: open-files soft limit ${String(fact.value.soft)} is under ${LOW_OPEN_FILES} — raise it (ulimit -n / launchctl limit maxfiles)`,
      );
    }
    return;
  }
  note('limits.open-files', 'notApplicable' in fact ? { notApplicable: fact.notApplicable } : fact);
}
