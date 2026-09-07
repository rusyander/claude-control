import type {
  AtlassianDeployment,
  IntegrationId,
  IntegrationStatus,
} from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { telegramMe } from '../notify/telegram.ts';
import { sendWebhook } from '../notify/webhook.ts';
import { detectDeployment, trimUrl } from './atlassian/client.ts';
import { IntegrationError } from './errors.ts';
import { toForgeIdentity, whoAmI } from './forge.ts';
import { saveHealth } from './health.ts';
import { describeIntegration, readIntegrations, readToken, writeSettings } from './store.ts';
import { tmsClient } from './tms/index.ts';

/**
 * «Проверить связь» — одна кнопка на карточку и один вход на все пять систем.
 *
 * Проверка обязана быть ДЕШЁВОЙ и БЕЗВРЕДНОЙ: она спрашивает «кто я», а не
 * трогает данные. Иначе человек, нажавший кнопку трижды, завёл бы три пустых
 * цикла в чужом тест-менеджменте.
 *
 * Итог всегда попадает на диск (`health.ts`), и удачный, и неудачный: до этого
 * та же ошибка была у MCP — F5 возвращал «не проверялось» по рабочей связи.
 *
 * Ничего отсюда НЕ БРОСАЕТСЯ наружу: неудача — это состояние карточки, а не
 * отказ маршрута. Человек должен увидеть причину на карточке, а не 502 в
 * консоли браузера.
 */

export async function checkIntegration(
  store: AppStore,
  appDataDir: string,
  id: IntegrationId,
): Promise<IntegrationStatus> {
  try {
    const probe = await probeIntegration(store, appDataDir, id);
    saveHealth(store, id, {
      state: 'ok',
      detail: probe.detail,
      account: probe.account,
      deployment: probe.deployment,
    });
  } catch (error) {
    saveHealth(store, id, { state: 'error', detail: reasonOf(error) });
  }
  return describeIntegration(store, appDataDir, id);
}

interface Probe {
  detail: string;
  account?: string;
  deployment?: AtlassianDeployment;
}

async function probeIntegration(
  store: AppStore,
  appDataDir: string,
  id: IntegrationId,
): Promise<Probe> {
  const settings = readIntegrations(store);
  const token = readToken(appDataDir, id);

  // Вебхук проверяется ДО требования токена: секрет подписи у него
  // необязателен. И проверка у него единственно возможная — настоящая
  // отправка: «кто я» у произвольного адреса не спросишь, поэтому приёмник
  // получает тело с событием `test`, по которому его и отличит от боевого.
  if (id === 'webhook') {
    const url = settings.webhook.url;
    await sendWebhook(url, token, {
      event: 'test',
      text: 'Проверка связи из панели AgentDeck.',
      at: new Date().toISOString(),
    });
    return { detail: `Приёмник ответил на пробное событие${token ? ' (тело подписано)' : ''}.` };
  }

  if (!token) {
    throw new IntegrationError('integration_not_found', 'Токен не сохранён.');
  }

  if (id === 'atlassian') return probeAtlassian(store, token);
  if (id === 'forge') {
    const account = await whoAmI(toForgeIdentity(settings.forge, token));
    return { detail: `Вошли как ${account}.`, account };
  }
  if (id === 'telegram') {
    const account = await telegramMe(token);
    return { detail: `Бот ${account} на связи.`, account };
  }
  if (id === 'tms') {
    const detail = await tmsClient(settings.tms, token).ping();
    return { detail: `${detail} — связь есть.` };
  }
  // CI ходит в тот же фордж и тем же токеном; своего адреса у карточки нет
  // намеренно (см. `ci.ts`), поэтому инсталляцию берём у форджа, когда вид
  // совпадает, — иначе человек вводил бы один и тот же адрес дважды.
  const baseUrl = settings.forge.kind === settings.ci.kind ? settings.forge.baseUrl : '';
  const account = await whoAmI(
    toForgeIdentity({ enabled: true, kind: settings.ci.kind, baseUrl, repo: '' }, token),
  );
  return { detail: `Вошли как ${account}.`, account };
}

/**
 * Atlassian проверяется определением диалекта — и ЗАПОМИНАЕТ его.
 *
 * Иначе облако с пустым полем «вид установки» каждый раз угадывалось бы по
 * наличию почты, а Confluence у облака и у своей установки живёт по разным
 * путям: ошибка диалекта даёт 404 на верном токене.
 */
async function probeAtlassian(store: AppStore, token: string): Promise<Probe> {
  const settings = readIntegrations(store).atlassian;
  const probe = await detectDeployment({
    baseUrl: trimUrl(settings.baseUrl),
    email: settings.email.trim(),
    token,
    confluenceUrl: settings.confluenceUrl.trim(),
  });
  if (settings.deployment !== probe.deployment) {
    writeSettings(store, 'atlassian', { ...settings, deployment: probe.deployment });
  }
  return {
    detail: `Вошли как ${probe.account} (${probe.deployment === 'cloud' ? 'облако' : 'своя установка'}).`,
    account: probe.account,
    deployment: probe.deployment,
  };
}

/** Причина отказа человеческой строкой — она же ляжет на карточку. */
function reasonOf(error: unknown): string {
  if (error instanceof IntegrationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
