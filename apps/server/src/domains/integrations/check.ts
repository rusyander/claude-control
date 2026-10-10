import type { AtlassianDeployment, IntegrationId, IntegrationStatus } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { telegramMe } from '../notify/telegram.ts';
import { sendWebhook } from '../notify/webhook.ts';
import {
  detectConfluenceDeployment,
  detectDeployment,
  trimUrl,
  type DeploymentProbe,
} from './atlassian/client.ts';
import { IntegrationError } from './errors.ts';
import { toForgeIdentity, whoAmI } from './forge.ts';
import { saveHealth } from './health.ts';
import {
  describeIntegration,
  forgeSettingsOf,
  readIntegrations,
  readToken,
  tmsSettingsOf,
  writeSettings,
} from './store/store.ts';
import { tmsClient } from './tms/index.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';

/**
 * «Проверить связь» — одна кнопка на карточку и один вход на все системы.
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
    return {
      detail: serverText(
        token ? 'integration-check-webhook-signed' : 'integration-check-webhook-ok',
      ),
    };
  }

  if (!token) {
    throw coded(
      new IntegrationError('integration_not_found', 'Токен не сохранён.'),
      'integration-token-not-saved',
    );
  }

  if (id === 'jira' || id === 'confluence') return probeAtlassian(store, id, token);
  if (id === 'gitlab' || id === 'github') {
    const account = await whoAmI(toForgeIdentity(forgeSettingsOf(store, id), token));
    return { detail: serverText('integration-check-logged-in', { account }), account };
  }
  if (id === 'telegram') {
    const account = await telegramMe(token);
    return { detail: serverText('integration-check-telegram-ok', { account }), account };
  }
  if (id === 'zephyr' || id === 'xray' || id === 'testit') {
    const detail = await tmsClient(tmsSettingsOf(store, id), token).ping();
    return { detail: serverText('integration-check-tms-ok', { detail }) };
  }
  // CI ходит в тот же фордж и тем же токеном; своего адреса у карточки нет
  // намеренно (см. `ci.ts`), поэтому инсталляцию берём у форджа того же вида —
  // иначе человек вводил бы один и тот же адрес дважды.
  const kind = settings.ci.kind;
  const baseUrl = kind ? settings[kind].baseUrl : '';
  const account = await whoAmI(toForgeIdentity({ enabled: true, kind, baseUrl, repo: '' }, token));
  return { detail: serverText('integration-check-logged-in', { account }), account };
}

/**
 * Jira и Confluence проверяются определением диалекта — и ЗАПОМИНАЮТ его.
 *
 * Иначе облако с пустым полем «вид установки» каждый раз угадывалось бы по
 * наличию почты, а Confluence у облака и у своей установки живёт по разным
 * путям: ошибка диалекта даёт 404 на верном токене. Каждая система
 * спрашивается у себя самой: подключённая без Jira вики не обязана знать о ней.
 */
async function probeAtlassian(
  store: AppStore,
  id: 'jira' | 'confluence',
  token: string,
): Promise<Probe> {
  const settings = readIntegrations(store)[id];
  const identity = { baseUrl: trimUrl(settings.baseUrl), email: settings.email.trim(), token };
  const probe: DeploymentProbe =
    id === 'jira' ? await detectDeployment(identity) : await detectConfluenceDeployment(identity);
  if (settings.deployment !== probe.deployment) {
    writeSettings(store, id, { ...settings, deployment: probe.deployment });
  }
  return {
    detail: serverText('integration-check-atlassian-ok', {
      account: probe.account,
      deployment: serverText(
        probe.deployment === 'cloud'
          ? 'integration-deployment-cloud'
          : 'integration-deployment-own',
      ),
    }),
    account: probe.account,
    deployment: probe.deployment,
  };
}

/** Причина отказа человеческой строкой — она же ляжет на карточку. */
function reasonOf(error: unknown): string {
  if (error instanceof IntegrationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
