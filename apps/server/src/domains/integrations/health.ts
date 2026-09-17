import type { AtlassianDeployment, IntegrationId, IntegrationState } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import type { IntegrationHealthRecord } from '../../lib/app-store/app-store.types.ts';

/**
 * Итог живой проверки связи — на диск, рядом с итогами проверок MCP.
 *
 * Держать его только в браузере нельзя по той же причине, по которой это уже
 * исправили у MCP: F5 возвращал «не проверялось» по работающей связи. Ключ —
 * тот же `int:<id>`, что и у токена: одна интеграция, один идентификатор во
 * всех хранилищах панели.
 *
 * В записи нет секрета: состояние, причина словами, имя учётной записи и вид
 * установки Atlassian — ровно то, что видно на карточке.
 */

function key(id: IntegrationId): string {
  return `int:${id}`;
}

export function readHealth(
  store: AppStore,
  id: IntegrationId,
): IntegrationHealthRecord | undefined {
  return store.getIntegrationHealth()[key(id)];
}

export interface HealthInput {
  state: IntegrationState;
  detail: string;
  account?: string;
  deployment?: AtlassianDeployment;
}

/** Запомнить итог проверки. Время ставим здесь — вызывающим его знать незачем. */
export function saveHealth(
  store: AppStore,
  id: IntegrationId,
  input: HealthInput,
): IntegrationHealthRecord {
  const record: IntegrationHealthRecord = {
    state: input.state,
    detail: input.detail,
    checkedAt: new Date().toISOString(),
    account: input.account,
    deployment: input.deployment,
  };
  store.saveIntegrationHealth(key(id), record);
  return record;
}
