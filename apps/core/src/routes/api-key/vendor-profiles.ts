import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';
import type { VendorApiKind } from '@agentdeck/providers/types';
import { apiKeyRouteId } from './api-key.ts';
import type { ApiKeyKind, ApiKeyProfile } from './api-key.types.ts';

/**
 * Профили ключа вендора из фактов запуска CLI. Живут в слое маршрутов: реестр CLI знают только
 * переходники и маршруты (depcruise `core-providers-only-in-adapters-routes`), сборка ядра берёт
 * готовые профили.
 */

/** Вид API вендора → словарь профиля ключа; `none` — ключом в модель не ходят. */
const VENDOR_KIND: Partial<Record<VendorApiKind, ApiKeyKind>> = {
  anthropic: 'anthropic',
  google: 'google',
  openai: 'openai-compat',
  'openai-compat': 'openai-compat',
};

/**
 * `api-key:<cli>` — ключ вендора, сохранённый панелью под id провайдера, на адрес вендора из
 * фактов запуска (`vendorApi.baseUrl`, только из документации). Адреса нет — маршрута нет:
 * угаданный адрес отправил бы ключ не тому вендору.
 */
export function vendorProfiles(): ApiKeyProfile[] {
  const out: ApiKeyProfile[] = [];
  for (const facts of CLI_RUN_FACTS) {
    const apiKind = VENDOR_KIND[facts.vendorApi.kind];
    const baseUrl = facts.vendorApi.baseUrl;
    if (!apiKind || !baseUrl) continue;
    out.push({
      routeId: apiKeyRouteId(facts.id),
      baseUrl,
      apiKind,
      storeId: facts.id,
      keyChannel: 'hop-injected',
    });
  }
  return out;
}
