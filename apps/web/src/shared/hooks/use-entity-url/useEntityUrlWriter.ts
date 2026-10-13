import { useMatch, useNavigate, useRouter } from '@tanstack/react-router';

/**
 * Записать id открытого элемента в адрес или убрать его при закрытии.
 * Замена записи в истории, а не новая: возврат назад должен уводить со
 * страницы, а не отматывать по одному открытому элементу.
 *
 * Пишет только страница, которой адрес принадлежит. Пока следующий раздел
 * грузится, уходящая страница ещё смонтирована, и её эффекты срабатывают уже по
 * чужому адресу: `to: '.'` разрешался в новый раздел, и чат, уходя на
 * `/projects?id=…`, стирал там `id` — ссылка открывала список без проекта
 * (та же ловушка, что у вкладок, `usePageTab`).
 */
export function useEntityUrlWriter(): (id: string | undefined) => void {
  const navigate = useNavigate();
  const router = useRouter();
  const ownPath = useMatch({ strict: false, select: (match) => match.pathname });

  return (id) => {
    if (ownPath !== undefined && router.state.location.pathname !== ownPath) return;
    void navigate({ to: '.', search: id ? { id } : {}, replace: true });
  };
}
