/** Типы для `brand.mjs` — сам файл без типов, его исполняют и скрипты `tools/` голым Node. */

export declare const BRAND_NAME: 'AgentDeck';
export declare const BRAND_SLUG: 'agentdeck';
export declare const LEGACY_BRAND_NAME: string;
export declare const LEGACY_BRAND_SLUG: string;
export declare const LEGACY_BRAND_PASCAL: string;
export declare const MIGRATION_MARKER: string;

export type BrandLog = (line: string) => void;
export type MigrationOutcome = 'migrated' | 'kept' | 'none' | 'failed';

export declare function brandEnvName(name: string): string;
export declare function legacyEnvName(name: string): string;
export declare function brandEnv(
  name: string,
  env?: Record<string, string | undefined>,
): string | undefined;

export declare function appDataDirOf(configRoot: string): string;
export declare function legacyAppDataDirOf(configRoot: string): string;
export declare function resolveAppDataDir(configRoot: string, log?: BrandLog): string;

export declare function panelHomeDirPath(home?: string): string;
export declare function legacyPanelHomeDirPath(home?: string): string;
export declare function panelHomeDir(log?: BrandLog): string;
export declare function panelHomeFile(name: string, home?: string): string;

export declare function resolveBrandDir(
  legacyDir: string,
  freshDir: string,
  log?: BrandLog,
): string;
export declare function migrateDir(
  legacyDir: string,
  freshDir: string,
  log?: BrandLog,
): MigrationOutcome;
