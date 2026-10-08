import type { Project } from '@agentdeck/contracts';

/**
 * Какой проект открывать.
 *
 * Запомненный проект мог исчезнуть из реестра — тогда открывается первый, а не
 * пустой экран: пустота здесь читается как «раздел сломан». Пока реестр грузится,
 * выбор сохраняется: список тогда — одни открытые вкладки, и запомненный проект
 * из реестра в нём «исчез» бы, уступив место первой вкладке. Так же — пока реестр
 * не загрузился с ошибкой: иначе запомненный проект подменялся первой вкладкой
 * до конца сессии, и «Повторить» его уже не возвращал (ревью 28.09, F-194).
 */
export function resolveSelected(
  projects: Project[],
  selectedId: string,
  isLoading = false,
  isError = false,
): string {
  if (isLoading || isError || projects.length === 0) return selectedId;
  const exists = projects.some((project) => project.id === selectedId);
  return exists ? selectedId : (projects[0]?.id ?? '');
}
