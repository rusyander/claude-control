import type { DiffLineKind } from '@claude-control/contracts';

/**
 * Префикс строки диффа по её типу: как в unified diff. Один на ленту изменений и
 * на предпросмотр записи в файл чужого CLI — дифф в панели везде читается одинаково.
 */
export const DIFF_LINE_PREFIX: Record<DiffLineKind, string> = { add: '+', del: '-', ctx: ' ' };
