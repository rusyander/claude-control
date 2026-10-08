import { useNavigate } from '@tanstack/react-router';

/**
 * Записать id открытого элемента в адрес или убрать его при закрытии.
 * Замена записи в истории, а не новая: возврат назад должен уводить со
 * страницы, а не отматывать по одному открытому элементу.
 */
export function useEntityUrlWriter(): (id: string | undefined) => void {
  const navigate = useNavigate();

  return (id) => {
    void navigate({ to: '.', search: id ? { id } : {}, replace: true });
  };
}
