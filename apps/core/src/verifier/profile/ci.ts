/**
 * Набор CI (04:48): «проверки, которые гоняет CI, — набор публикации». Фасад папки `ci/`:
 * `scan` — команды из конфигов CI с их каталогом, `shell` — строка → argv без оболочки (P25),
 * `match` — сигнатура проверки, `generic` — команда без своей проверки → проверка `ci:` или
 * названный отказ (публикация и выкладка не исполняются никогда).
 */

export type { CiCommand, CiDropped, CiScan } from './ci/ci.types.ts';
export { scanCi } from './ci/scan.ts';
export { isShellInvocation, splitSegments, tokenise } from './ci/shell.ts';
export { ciSet, matchWords, normaliseBinary, scriptHit } from './ci/match.ts';
export { classifyCiCommand, genericFromCi } from './ci/generic.ts';
