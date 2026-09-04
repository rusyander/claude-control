import type { ChatSummary } from '@claude-control/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Какие разговоры показывать в боковом списке.
 *
 * Без открытого проекта это домашняя вкладка — там живёт песочница, и только
 * она: разговоры настоящих проектов ушли бы в общую кучу, из которой их не
 * разобрать.
 *
 * У открытого проекта — его собственные разговоры плюс те, что выделило из них
 * разделение задач. Последние живут в КОПИЯХ репозитория, то есть в других
 * каталогах, и по фильтру пути сюда бы не попали, — но человек ищет их там, где
 * согласился на разделение.
 *
 * «Собственный» — каталог вкладки И ВСЁ ВЛОЖЕННОЕ в него. У Claude Code проект
 * равен рабочему каталогу запуска: разговор, начатый в `widget-app/widget`,
 * получает собственную запись и из списка вкладки `widget-app` пропадает
 * целиком — открыт, виден в ленте, а в списке «Показано 0 из 0». Совпадение
 * считается по границе сегмента: у того же хозяина рядом лежит
 * `widget-app-admin`, и проверка по одному префиксу утащила бы соседний проект
 * в чужую вкладку.
 *
 * Копий может и не быть: в проекте без git разделение заводит чаты В ТОМ ЖЕ
 * каталоге, и тогда они уже отобраны как свои. Без проверки такой разговор
 * попадал в список ДВАЖДЫ — та же строка, тот же ключ React, а дерево под
 * родителем оказывалось вдвое гуще, чем чатов на самом деле.
 *
 * Дети достраиваются к ОБЕИМ вкладкам, домашней в том числе: параллельный
 * запуск живёт как раз в её списке проектов, порождает разговоры настоящих
 * проектов и вкладок под них больше не открывает. Без этой достройки они не
 * попали бы в список ни здесь (не песочница), ни там (проект не открыт).
 */
/** Разговор проекта — его каталог или любой вложенный, но не сосед по префиксу. */
function insideProject(chatPath: string | undefined, projectId: string): boolean {
  const path = normalizeProjectPath(chatPath ?? '');
  return path === projectId || path.startsWith(`${projectId}/`);
}

export function visibleChats(all: ChatSummary[], activeProjectId?: string): ChatSummary[] {
  const own = activeProjectId
    ? all.filter((chat) => !chat.isSandbox && insideProject(chat.projectPath, activeProjectId))
    : all.filter((chat) => chat.isSandbox);

  const roots = new Set(own.map((chat) => chat.id));
  const children = all.filter(
    (chat) => chat.parentId && roots.has(chat.parentId) && !roots.has(chat.id),
  );

  return children.length > 0 ? [...own, ...children] : own;
}
