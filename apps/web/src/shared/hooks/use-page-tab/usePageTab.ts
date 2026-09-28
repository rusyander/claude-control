import { useEffect } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  pickPageTab,
  readRememberedPageTab,
  rememberPageTab,
  unknownTabParam,
} from '@shared/lib/page-tab';

/**
 * Открытая вкладка страницы раздела и переход на другую.
 *
 * Вкладка живёт в адресе (`?tab=…`, заменой, а не новой записью истории — иначе
 * «Назад» ходил бы по вкладкам, а не по разделам) и в памяти браузера: вернувшись
 * в раздел из бокового меню, человек попадает туда, где был. Выбор ВСЕГДА
 * записывается в память, в том числе пришедший по ссылке, — иначе после ухода
 * со страницы открылась бы не та вкладка, которую он видел последней.
 *
 * `?id=…` при смене вкладки снимается: он адресует элемент на ОДНОЙ из вкладок,
 * и на другой ему не на что указывать.
 */
export function usePageTab<T extends string>(
  page: string,
  ids: readonly T[],
): { active: T; select: (tab: T) => void } {
  const navigate = useNavigate();
  // Сырой адрес, не разобранный: `?tab=1` приходит числом и в разобранном
  // адресе страницы его нет — а в строке браузера он остаётся. И открытая
  // вкладка — из того же снимка: разобранный поиск маршрута отстаёт от адреса
  // на кадр, и сверка «адрес ≠ открытая» в этом кадре возвращала прежнюю
  // вкладку — второй щелчок по вкладкам откатывался (F-214).
  // Пока следующий раздел грузится, эта страница ещё смонтирована, а адрес уже
  // его: его `?tab=` для неё чужой. Без этой сверки она принимала его за
  // незнакомую свою вкладку и переписывала в адресе раздела, куда ушёл человек
  // (/settings?tab=models → tab=proxy) — на «Назад», ссылках агента, наблюдателе.
  const leaving = useRouterState({
    select: (state) =>
      state.resolvedLocation !== undefined &&
      state.resolvedLocation.pathname !== state.location.pathname,
  });
  const locationTab = useRouterState({
    select: (state) => (state.location.search as Record<string, unknown>).tab,
  });
  const rawTab = leaving ? undefined : locationTab;
  const active = pickPageTab(ids, rawTab, readRememberedPageTab(page));

  useEffect(() => {
    rememberPageTab(page, active);
  }, [page, active]);

  // Неизвестная `?tab=xyz` не остаётся в адресе: открыта другая вкладка, и
  // скопированная ссылка должна вести туда, что человек видит. Остальные
  // параметры (`?id=…`) не трогаем — они про содержимое открытой вкладки.
  const unknownTab = unknownTabParam(rawTab, active);
  useEffect(() => {
    if (!unknownTab) return;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, tab: active }),
      replace: true,
    });
  }, [unknownTab, active, navigate]);

  const select = (tab: T): void => {
    rememberPageTab(page, tab);
    void navigate({ to: '.', search: { tab }, replace: true });
  };

  return { active, select };
}
