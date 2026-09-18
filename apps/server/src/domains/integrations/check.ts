import type { AtlassianDeployment, IntegrationId, IntegrationStatus } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { telegramMe } from '../notify/telegram.ts';
import { sendWebhook } from '../notify/webhook.ts';
import {
  confluenceRoot,
  CONFLUENCE_SYSTEM,
  detectDeployment,
  raw,
  trimUrl,
  type AtlassianAccess,
} from './atlassian/client.ts';
import { IntegrationError } from './errors.ts';
import { toForgeIdentity, whoAmI } from './forge.ts';
import { saveHealth } from './health.ts';
import {
  describeIntegration,
  readConfluenceToken,
  readIntegrations,
  readToken,
  writeSettings,
} from './store.ts';
import { tmsClient } from './tms/index.ts';
import { coded } from '../../lib/server-text.ts';
import { serverText } from '../../lib/server-texts.ts';

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

  if (id === 'atlassian') return probeAtlassian(store, appDataDir, token);
  if (id === 'forge') {
    const account = await whoAmI(toForgeIdentity(settings.forge, token));
    return { detail: serverText('integration-check-logged-in', { account }), account };
  }
  if (id === 'telegram') {
    const account = await telegramMe(token);
    return { detail: serverText('integration-check-telegram-ok', { account }), account };
  }
  if (id === 'tms') {
    const detail = await tmsClient(settings.tms, token).ping();
    return { detail: serverText('integration-check-tms-ok', { detail }) };
  }
  // CI ходит в тот же фордж и тем же токеном; своего адреса у карточки нет
  // намеренно (см. `ci.ts`), поэтому инсталляцию берём у форджа, когда вид
  // совпадает, — иначе человек вводил бы один и тот же адрес дважды.
  const baseUrl = settings.forge.kind === settings.ci.kind ? settings.forge.baseUrl : '';
  const account = await whoAmI(
    toForgeIdentity({ enabled: true, kind: settings.ci.kind, baseUrl, repo: '' }, token),
  );
  return { detail: serverText('integration-check-logged-in', { account }), account };
}

/**
 * Atlassian проверяется определением диалекта — и ЗАПОМИНАЕТ его.
 *
 * Иначе облако с пустым полем «вид установки» каждый раз угадывалось бы по
 * наличию почты, а Confluence у облака и у своей установки живёт по разным
 * путям: ошибка диалекта даёт 404 на верном токене.
 */
async function probeAtlassian(store: AppStore, appDataDir: string, token: string): Promise<Probe> {
  const settings = readIntegrations(store).atlassian;
  const identity = {
    baseUrl: trimUrl(settings.baseUrl),
    email: settings.email.trim(),
    token,
    confluenceUrl: settings.confluenceUrl.trim(),
    confluenceToken: readConfluenceToken(appDataDir) ?? '',
  };
  const probe = await detectDeployment(identity);
  if (settings.deployment !== probe.deployment) {
    writeSettings(store, 'atlassian', { ...settings, deployment: probe.deployment });
  }
  const params = {
    account: probe.account,
    deployment: serverText(
      probe.deployment === 'cloud' ? 'integration-deployment-cloud' : 'integration-deployment-own',
    ),
  };
  const confluence = await probeConfluence({ ...identity, deployment: probe.deployment });
  return {
    detail: confluence
      ? serverText(confluence.code, { ...params, ...confluence.params })
      : serverText('integration-check-atlassian-ok', params),
    account: probe.account,
    deployment: probe.deployment,
  };
}

type ConfluenceVerdict = {
  code:
    | 'integration-check-atlassian-confluence-ok'
    | 'integration-check-atlassian-confluence-rejected'
    | 'integration-check-atlassian-confluence-failed'
    | 'integration-check-atlassian-confluence-unreachable';
  params?: Record<string, string | number>;
};

/**
 * Живёт ли Confluence на этом доступе — вторая половина той же кнопки.
 *
 * Спрашивается отдельно, потому что связь у них РАЗНАЯ: на своей установке Jira
 * и Confluence — разные приложения с разными личными токенами, и «Вошли как …»
 * по Jira ничего не обещает про вики. Живой случай: панель отвечала
 * «Confluence не подключён» на 401, хотя ключ Confluence существовал — просто
 * панель его не спрашивала.
 *
 * Итог НЕ красит карточку: Jira работает, и гасить её из-за вики нельзя. Итог
 * дописывается в ту же подпись, чтобы причина была видна до первой кнопки.
 *
 * Не спрашиваем вовсе, когда спрашивать не у кого: у своей установки без адреса
 * Confluence и без отдельного ключа корень равен хосту Jira, и 404 оттуда —
 * ложная тревога про вики, которой у человека может не быть.
 */
async function probeConfluence(access: AtlassianAccess): Promise<ConfluenceVerdict | undefined> {
  const asked =
    access.deployment === 'cloud' || Boolean(access.confluenceUrl || access.confluenceToken);
  if (!asked) return undefined;
  try {
    // Старый content-API отвечает у ОБОИХ диалектов (у облака — под `/wiki`),
    // а `limit=1` делает пробу такой же дешёвой и безвредной, как «кто я».
    const response = await raw(access, {
      url: `${confluenceRoot(access)}/rest/api/space?limit=1`,
      system: CONFLUENCE_SYSTEM,
    });
    if (response.ok) return { code: 'integration-check-atlassian-confluence-ok' };
    if (response.status === 401 || response.status === 403) {
      return { code: 'integration-check-atlassian-confluence-rejected' };
    }
    return {
      code: 'integration-check-atlassian-confluence-failed',
      params: { status: response.status },
    };
  } catch (error) {
    return {
      code: 'integration-check-atlassian-confluence-unreachable',
      params: { reason: reasonOf(error) },
    };
  }
}

/** Причина отказа человеческой строкой — она же ляжет на карточку. */
function reasonOf(error: unknown): string {
  if (error instanceof IntegrationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
