/**
 * Загрузка ядра — фасад над `boot/`: сборка (`boot-core.ts`), журнал ядра (`core-log.ts`),
 * освобождение шагов (`release.ts`), таймеры копии дня и скачков часов (`timers.ts`), типы
 * (`boot.types.ts`). Путь импорта `bootstrap/boot.ts` остаётся прежним для всех вызывающих.
 */
export { bootCore } from './boot/boot-core.ts';
export { BACKUP_EVERY_MS } from './boot/timers.ts';
export type { BootedCore, BootOptions } from './boot/boot.types.ts';
