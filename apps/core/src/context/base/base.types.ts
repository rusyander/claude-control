import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';

/** Ключ замера базы (G9): CLI × версия × вид шага × набор слоя × список MCP. */
export interface BaseKey {
  adapter: string;
  cliVersion: string;
  stepKind: string;
  layerHash: string;
  mcpHash: string;
}

/** Замер = строка `context.base` журнала. */
export type BaseRecord = JournalDataV1['context.base'];

export interface BaseCacheFile {
  version: 1;
  /** По `baseKeyId(key)`. */
  bases: Record<string, BaseRecord & { measuredAt: number }>;
}

/** Тела запросов первого хода пробы на заглушке модели и бриф, с которым она шла. */
export interface ProbeTrace {
  bodies: readonly string[];
  brief: string;
}

export interface BaseDeps {
  read(): Promise<Fact<BaseCacheFile>>;
  write(file: BaseCacheFile): Promise<void>;
  /** Проба на заглушке модели (бесплатно, без сети): один ход сеанса с этим ключом. */
  probe(key: BaseKey): Promise<ProbeTrace>;
  now?: () => number;
}

export type BaseOutcome =
  { ok: true; base: BaseRecord; measured: boolean } | { ok: false; reason: string };

export interface Drift {
  expected: number;
  actual: number;
  /** Доля расхождения от ожидаемого. */
  ratio: number;
  over: boolean;
}
