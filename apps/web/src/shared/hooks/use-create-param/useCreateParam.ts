import { useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/**
 * Открыть форму создания по флагу `?create` в адресе.
 *
 * Быстрое действие «Добавить» с обзора ведёт на раздел ссылкой вида
 * `/rules?create=1`. Раздел уже умеет создавать сущность своей формой — этот
 * хук лишь дёргает её открытие один раз и сразу убирает флаг из адреса, чтобы
 * возврат назад или перезагрузка не открывали форму снова. Логика создания не
 * дублируется: используется тот же `openCreate`, что и у кнопки на странице.
 */
export function useCreateParam(open: () => void): void {
  const { create } = useSearch({ strict: false }) as { create?: boolean };
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    if (!create || handled.current) return;
    handled.current = true;
    open();
    // Флаг одноразовый: убираем его из адреса тем же способом, что и запись id
    // открытого элемента (см. useEntityUrlWriter) — заменой, а не новой записью.
    void navigate({ to: '.', search: {}, replace: true });
    // open — стабильный обработчик страницы, а сработать нужно ровно на появление
    // флага; за единственный вызов отвечает ref, а не список зависимостей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [create]);
}
