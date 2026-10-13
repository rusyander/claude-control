import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { projectByPath, useAddProject, useProjectRegistry } from '@entities/Project';
import { projectShortName } from '@shared/lib/workspace';

interface ProjectShelfButtonProps {
  path: string;
  name?: string | undefined;
}

/**
 * Проект вкладки и страница «Проекты» в одной кнопке ряда проекта. Есть там —
 * подпись «В «Проектах»» ведёт к его настройкам; нет — «В «Проекты»» добавляет
 * одним нажатием. Так папка, открытая в чате через «Добавить папку», не
 * требует второго похода на страницу «Проекты», а уже добавленная видна сразу.
 */
export function ProjectShelfButton({ path, name }: ProjectShelfButtonProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: registry, isLoading } = useProjectRegistry();
  const add = useAddProject();

  // Пока реестр не пришёл, кнопки нет: «добавить» на мгновение перед «уже есть»
  // читалось бы как сбой, а нажатие в этот миг дало бы 409.
  if (isLoading || !registry) return null;
  const saved = projectByPath(registry, path);

  if (saved) {
    return (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<Icon name="pin" size={20} />}
        onClick={() => void navigate({ to: '/projects', search: { id: saved.id } } as never)}
        title={t('chatProjects.savedHint')}
      >
        <span data-bar-label="">{t('chatProjects.saved')}</span>
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={<Icon name="plus" size={20} />}
      isLoading={add.isPending}
      onClick={() => add.mutate({ path, name: name ?? projectShortName(path) })}
      title={t('chatProjects.saveHint')}
    >
      <span data-bar-label="">{t('chatProjects.save')}</span>
    </Button>
  );
}
