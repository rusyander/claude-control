import type { EntityToggleDeps } from '../entity-toggle.ts';
import { migrateAutomations } from './automation-migration.ts';
import { migrateGroupPaths } from './path-migration.ts';

/** Куда писать итог: у маршрутов это `app.log` Fastify. */
export interface MigrationLog {
  info: (details: object, message: string) => void;
  warn: (details: object, message: string) => void;
}

/**
 * Перенос старого «Порядка работы» в путь и автоматизаций в шаги — один раз на
 * запись: перенесённая группа сценария больше не несёт, повторный проход её не
 * видит. Зовётся на старте и после каждой смены каталога на лету: у нового
 * каталога свой `state.json`, и без переноса его группа показывала пустой путь,
 * а первая правка пути отрезала старые шаги навсегда (`path-migration.ts`
 * пропускает группу, у которой путь уже есть).
 */
export function runLegacyGroupMigrations(deps: EntityToggleDeps, log: MigrationLog): void {
  try {
    const report = migrateGroupPaths(deps);
    if (report.migrated.length > 0) log.info({ report }, 'group path migration');
  } catch (error) {
    // Старт панели и переезд важнее переноса: не удался — группа перенесётся при сохранении.
    log.warn({ err: error }, 'group path migration failed');
  }
  // После пути: шаг «Хук» встаёт в уже перенесённый путь группы.
  try {
    const report = migrateAutomations(deps);
    if (report.migrated.length > 0) log.info({ report }, 'automation migration');
  } catch (error) {
    // Не удался — автоматизации остались в состоянии и перенесутся при следующем проходе.
    log.warn({ err: error }, 'automation migration failed');
  }
}
