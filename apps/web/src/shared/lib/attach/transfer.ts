import type { TransferLike } from './transfer.types';

/**
 * Несут ли данные файлы. Во время `dragover` сами файлы браузер не отдаёт —
 * только их наличие в `types`; по нему и решаем, подсвечивать ли поле.
 */
export function carriesFiles(data: TransferLike | null | undefined): boolean {
  return Boolean(data?.types && Array.from(data.types).includes('Files'));
}
