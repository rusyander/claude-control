import { useQuery } from '@tanstack/react-query';
import type { AppSettings, AtlassianSettings } from '@agentdeck/contracts';
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
