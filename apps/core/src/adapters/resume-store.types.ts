/**
 * Чей транскрипт (поиск в хранилище CLI по id и корню): `owned` — транскрипт этого id и этого корня;
 * `absent` — транскрипта id нет; `foreign` — есть, но другого корня (или под чужим id внутри);
 * `unreadable` — хранилище не прочитать.
 */
export type TranscriptVerdict = 'owned' | 'absent' | 'foreign' | 'unreadable';

/**
 * Перенос разговора в хранилище сеанса до запуска CLI: отказ — причиной, до процесса; иначе
 * `place()` кладёт копию транскрипта (и указатель, который нужен CLI, чтобы его найти) в дом сеанса.
 */
export type ResumeStage = { ok: true; place(): void } | { ok: false; reason: string };

/** Откуда продолжается разговор: дом CLI прежней сессии ядра или хранилище человека (по пину). */
export type ResumeSource = { kind: 'core'; home: string } | { kind: 'human' };
