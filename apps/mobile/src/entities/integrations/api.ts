import { useQuery } from '@tanstack/react-query';
import type { AppSettings, AtlassianSettings, IntegrationLinks } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Внешние привязки проекта на телефоне — ТОЛЬКО чтение.
 *
 * Токенов здесь нет и быть не может: их вводят в панели, на своей машине, и
 * телефон о них не спрашивает. Отсюда видно ровно то, что человеку нужно в
 * руке: к какой задаче относится работа и где лежат требования — чтобы открыть
 * их в браузере, стоя у стенда.
 *
 * Адрес собирается из настроек панели, а не приходит с сервера: в привязке
 * лежат ключ задачи и id страницы — они переживают переезд сайта, а ссылка нет.
 * Та же формула живёт в панели (`entities/Integration/model/links.ts`); общего
 * модуля у них нет, потому что Metro не тянет веб-код.
 */

type SettingsWithIntegrations = AppSettings & {
  integrations?: { atlassian?: Partial<AtlassianSettings> };
};

const EMPTY_ATLASSIAN: AtlassianSettings = {
  enabled: false,
  baseUrl: '',
  email: '',
  deployment: '',
  confluenceUrl: '',
};

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

export function jiraIssueUrl(atlassian: AtlassianSettings, key: string | undefined): string {
  if (!atlassian.baseUrl || !key) return '';
  return `${trimSlash(atlassian.baseUrl)}/browse/${encodeURIComponent(key)}`;
}

export function confluencePageUrl(
  atlassian: AtlassianSettings,
  pageId: string | undefined,
): string {
  if (!pageId) return '';
  const own = trimSlash(atlassian.confluenceUrl);
  const base = trimSlash(atlassian.baseUrl);
  if (!own && !base) return '';
  const root = own || (atlassian.deployment === 'server' ? base : `${base}/wiki`);
  return `${root}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/**
 * Настройки Atlassian из общих настроек панели. Читаем защищённо: секция
 * появилась позже остального, и её отсутствие — обычный старый конфиг, а не
 * повод оставить экран тестов без списка кейсов.
 */
export function useAtlassianSettings(): AtlassianSettings {
  const settings = useQuery({
    queryKey: ['panel-settings', 'integrations'],
    queryFn: () => api.get<SettingsWithIntegrations>('/settings'),
    staleTime: 10 * 60_000,
  });
  const raw = settings.data?.integrations?.atlassian;
  return raw ? { ...EMPTY_ATLASSIAN, ...raw } : EMPTY_ATLASSIAN;
}

/** Привязки проекта и его групп. Нет проекта — не спрашиваем. */
export function useIntegrationLinks(projectPath: string | undefined) {
  return useQuery({
    queryKey: ['integration-links', projectPath],
    queryFn: () => api.get<IntegrationLinks>('/integrations/links', { path: projectPath }),
    enabled: Boolean(projectPath),
    staleTime: 60_000,
    // Интеграции могут быть не настроены вовсе — это не повод повторять запрос.
    retry: false,
  });
}
