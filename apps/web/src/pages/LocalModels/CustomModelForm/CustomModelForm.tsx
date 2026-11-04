import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { toast } from '@shared/lib/toast';
import { useAddCustomModel } from '@entities/LocalModels';
import styles from './CustomModelForm.module.scss';

/**
 * «Любая модель»: репозиторий Hugging Face в каталог. Черновик поля живёт здесь, а не в карточке
 * каталога: иначе каждая буква перерисовывала бы все строки моделей (layout-005 — 328 компонентов
 * на букву).
 */
export function CustomModelForm() {
  const { t } = useTranslation();
  const addCustom = useAddCustomModel();
  const [repo, setRepo] = useState('');

  const submit = (): void => {
    const input = repo.trim();
    if (input.length < 3) return;
    addCustom.mutate(input, {
      onSuccess: (model) => {
        toast.success(t('localModels.catalog.custom.added', { title: model.title }));
        setRepo('');
      },
    });
  };

  return (
    <form
      className={styles.customForm}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      aria-label={t('localModels.catalog.custom.title')}
    >
      <Typography variant="heading-sm" as="h3">
        {t('localModels.catalog.custom.title')}
      </Typography>
      <Typography variant="caption" color="muted">
        {t('localModels.catalog.custom.hint')}
      </Typography>
      <div className={styles.customRow}>
        <div className={styles.customField}>
          <TextField
            label={t('localModels.catalog.custom.label')}
            value={repo}
            onChange={setRepo}
            placeholder={t('localModels.catalog.custom.placeholder')}
            isMono
            disabled={addCustom.isPending}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          leftIcon={<Icon name="plus" />}
          isLoading={addCustom.isPending}
          disabled={repo.trim().length < 3}
        >
          {t('localModels.catalog.custom.add')}
        </Button>
      </div>
    </form>
  );
}
