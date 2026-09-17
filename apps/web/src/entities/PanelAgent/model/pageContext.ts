import type { PanelAgentPageContext } from '@agentdeck/contracts/panel-agent';
import { NAV_SECTIONS } from '@shared/config/navigation';

/**
 * Ключ подписи раздела по адресу. Совпадение по самому длинному префиксу:
 * `/tests/…` — это «Тестирование», а корень `/` подходит только сам себе,
 * иначе любая страница читалась бы «Обзором».
 */
export function sectionLabelKey(pathname: string): string | undefined {
  let best: { path: string; label: string } | undefined;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const fits =
        item.path === '/'
          ? pathname === '/'
          : pathname === item.path || pathname.startsWith(`${item.path}/`);
      if (fits && (!best || item.path.length > best.path.length)) best = item;
    }
  }
  return best?.label;
}

/**
 * Контекст, уходящий с каждым сообщением: где человек и какой проект у него
 * выбран. Адрес — с запросом (`/settings?tab=prompts`): вкладка тоже место.
 * Пустые поля не отправляем — схема сервера их не ждёт.
 */
export function buildPageContext(input: {
  pathname: string;
  searchStr?: string;
  title?: string;
  projectPath?: string;
}): PanelAgentPageContext {
  const search = input.searchStr && input.searchStr !== '?' ? input.searchStr : '';
  return {
    route: `${input.pathname}${search}`,
    ...(input.title ? { title: input.title } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  };
}
