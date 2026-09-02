import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useCreateParam } from '@shared/hooks/use-create-param';
import { SkeletonList } from '@shared/ui/skeleton';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { SearchField } from '@shared/ui/search-field';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkillFormModal } from '@features/SkillEditor';
import { skillApi } from '@entities/Skill';
import type { Skill } from '@claude-control/contracts';
import { SkillCard } from './SkillCard';
import styles from './SkillsPage.module.scss';

/** Раздел скиллов: поиск по названию и описанию, включение и выключение. */
export function SkillsPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Skill | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: skills = [], isLoading } = skillApi.useList();
  const setEnabled = skillApi.useSetEnabled();
  const deleteSkill = skillApi.useDelete();

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const openEdit = (skill: Skill): void => {
    setEditing(skill);
    setIsFormOpen(true);
    writeUrl(skill.id);
  };

  // Ссылка вида /skills?id=<имя> открывает этот скилл сразу в редакторе.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<Skill>({ items: skills, getId: (skill) => skill.id, onOpen: openEdit });
  // Быстрое действие «Добавить» с обзора: /skills?create=1 сразу открывает форму.
  useCreateParam(openCreate);

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle),
    );
  }, [skills, query]);

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('skills.title')}
        subtitle={t('skills.subtitle')}
        helpTopic="skills"
        actions={
          <Button variant="primary" leftIcon={<Icon name="plus" size={24} />} onClick={openCreate}>
            {t('skills.addSkill')}
          </Button>
        }
      />

      <ExplainBox title={t('skills.explainTitle')} text={t('skills.explain')} />

      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t('common.search')}
        label={t('common.search')}
      />

      {isLoading && <SkeletonList rows={5} />}

      <Stack gap="var(--spacing-sm)">
        {filtered.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onToggle={(isEnabled) => setEnabled.mutate({ id: skill.id, isEnabled })}
            onEdit={() => openEdit(skill)}
            onDelete={() => deleteSkill.mutate(skill.id)}
            isDeleting={deleteSkill.isPending}
          />
        ))}
      </Stack>

      {/* Два разных «пусто», как у правил: промах поиска показывает запрос,
          настоящая пустота объясняет, откуда берутся скиллы. Одно слово «Пусто»
          на оба случая не говорило ни того, ни другого. */}
      {!isLoading && filtered.length === 0 && query.trim() && (
        <EmptyState
          icon="search"
          title={t('skills.noMatchTitle')}
          text={t('skills.noMatchText', { query: query.trim() })}
        />
      )}
      {!isLoading && skills.length === 0 && !query.trim() && (
        <EmptyState icon="skills" title={t('skills.emptyTitle')} text={t('skills.emptyText')} />
      )}

      <SkillFormModal isOpen={isFormOpen} onOpenChange={closeForm} skill={editing} />
    </Stack>
  );
}
