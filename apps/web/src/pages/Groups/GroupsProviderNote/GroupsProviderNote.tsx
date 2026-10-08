import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { activeProvider, useProviders } from '@entities/Provider';
import styles from './GroupsProviderNote.module.scss';

/**
 * Чем группы становятся при чужом активном CLI. Карточки ниже читаются как
 * группы Claude, а чужой CLI его файлов не читает: без строки над ними человек
 * считал бы, что включённая группа действует и на этот CLI. Модель —
 * от сервера (`groupsModel`): слой на прогон или «не действует»; у Claude и
 * пока список CLI не пришёл — ничего.
 */
export function GroupsProviderNote() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);
  const model = provider?.groupsModel;
  if (!provider || (model !== 'run-layer' && model !== 'none')) return null;
  return (
    <div
      className={model === 'none' ? styles.providerNoteNone : styles.providerNote}
      role="note"
      data-testid="groups-provider-note"
      data-model={model}
    >
      <Typography variant="body-sm">
        {t(model === 'none' ? 'groupsPage.providerNote.none' : 'groupsPage.providerNote.runLayer', {
          cli: provider.name,
        })}
      </Typography>
    </div>
  );
}
