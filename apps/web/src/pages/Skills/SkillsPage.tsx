import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
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

      {!isLoading && filtered.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      <SkillFormModal isOpen={isFormOpen} onOpenChange={setIsFormOpen} skill={editing} />
    </Stack>
  );
}
