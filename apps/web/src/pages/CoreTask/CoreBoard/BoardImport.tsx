import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGroups, type GroupListItem } from '@entities/Group';
import { CoreLaunchScreen, type LaunchDraft } from '@features/CoreLaunch';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { CoreImportDialog } from '../CoreImportDialog/CoreImportDialog';
import { launchInitialOf } from '../model/coreImport';

const P = 'coreBoard.import';

/** Запуск, открытый переводом группы: ключ пересоздаёт форму под новый сценарий. */
interface LaunchRequest {
  key: string;
  initial: Partial<LaunchDraft>;
}

/** Шагов в «Пути» группы (или в старом «Порядке работы» у группы без «Пути»). */
function stepsOf(group: GroupListItem): number {
  return (group.path?.steps.length ?? 0) || (group.scenario?.steps.length ?? 0);
}

interface ImportPickerProps {
  onPick: (group: GroupListItem) => void;
  onClose: () => void;
}

/** Выбор прежней группы с «Путём»; список групп читается, только когда окно открыто. */
function ImportPicker({ onPick, onClose }: ImportPickerProps) {
  const { t } = useTranslation();
  const groups = useGroups();
  const withPath = (groups.data ?? []).filter((g) => stepsOf(g) > 0);
  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()} title={t(`${P}.pickTitle`)} size="md">
      <Stack gap="var(--spacing-sm)" data-board-import-pick>
        <Typography variant="body-sm">{t(`${P}.pickIntro`)}</Typography>
        {groups.isLoading && <SkeletonList rows={3} />}
        {groups.isError && (
          <Typography variant="body-sm" color="danger">
            {t(`${P}.loadError`)}
          </Typography>
        )}
        {groups.isSuccess && withPath.length === 0 && (
          <Typography variant="body-sm" color="subtle" data-board-import-empty>
            {t(`${P}.pickEmpty`)}
          </Typography>
        )}
        {withPath.map((group) => (
          <Card padding="sm" key={group.id} data-board-import-group={group.id}>
            <Stack direction="row" gap="var(--spacing-xs)" align="center">
              <Stack flex={1} minWidth={0}>
                <Typography variant="body-sm" weight="medium" as="span" truncate>
                  {group.name}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {t(`${P}.steps`, { count: stepsOf(group) })}
                </Typography>
              </Stack>
              <Button
                size="sm"
                aria-label={t(`${P}.pickAria`, { name: group.name })}
                onClick={() => onPick(group)}
              >
                {t(`${P}.pick`)}
              </Button>
            </Stack>
          </Card>
        ))}
      </Stack>
    </Modal>
  );
}

/**
 * «Импорт пунктов» доски (D13): прежняя группа → её «Путь» становится сценарием библиотеки ядра
 * (та же миграция `fromPath`, что была на странице групп), и открывается запуск с ним — там пункты
 * кладутся «В очередь» записями доски или оцениваются сразу. Сам перевод задач не создаёт.
 */
export function BoardImport() {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState<GroupListItem | undefined>();
  const [launch, setLaunch] = useState<LaunchRequest | undefined>();

  return (
    <>
      <Button
        variant="secondary"
        leftIcon={<Icon name="groups" size={20} />}
        title={t(`${P}.openHint`)}
        onClick={() => setPicking(true)}
        data-board-import
      >
        {t(`${P}.open`)}
      </Button>
      {picking && (
        <ImportPicker
          onClose={() => setPicking(false)}
          onPick={(group) => {
            setPicking(false);
            setImporting(group);
          }}
        />
      )}
      {importing && (
        <CoreImportDialog
          group={importing}
          onClose={() => setImporting(undefined)}
          onSaved={(ref) => {
            setImporting(undefined);
            setLaunch({
              key: `${ref.id}@${ref.version}:${Date.now()}`,
              initial: launchInitialOf(importing, ref),
            });
          }}
        />
      )}
      {launch && (
        <Modal
          isOpen
          onOpenChange={(open) => !open && setLaunch(undefined)}
          title={t('nav.coreLaunch')}
          size="xl"
        >
          <div data-board-import-launch>
            <CoreLaunchScreen key={launch.key} initial={launch.initial} />
          </div>
        </Modal>
      )}
    </>
  );
}
