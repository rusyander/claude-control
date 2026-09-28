import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { scopeOf } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SandboxButton } from '@features/SandboxRunner';
import { DeleteButton } from '@features/EntityDelete';
import { GroupPath } from '@features/GroupPath';
import { useDeleteGroup } from '@entities/Group';
import { selectionOfGroup } from './GroupsPage.lib';
import { usePairSide } from './model/usePairSide';
import { changedMemberLabel } from './model/changedMembers';
import { GroupViewTabs, groupViewPanelId, groupViewTabId } from './GroupViewTabs';
import type { GroupView } from './GroupViewTabs.types';
import { GroupDetails } from './GroupDetails';
import { GroupPairSwitch } from './GroupPairSwitch';
import type { GroupDialogProps } from './GroupDialog.types';
import styles from './GroupDialog.module.scss';

/**
 * Окно группы: «Когда», пара и две вкладки — «Порядок работы» (по умолчанию)
 * и «Состав». В шапке — действия над группой: правка, копия рядом, копия в
 * общие, песочница, удаление. У связанной пары вкладки показывают ту сторону, что
 * действует в проекте, — её путь и правит человек.
 */
export function GroupDialog({
  group,
  pair,
  startComposer,
  onClose,
  onEdit,
  onAdvice,
  onCopy,
}: GroupDialogProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<GroupView>('path');
  // Составитель первого шага зовётся один раз: вкладка «Состав» размонтирует
  // путь, и флаг от страницы при возврате открывал закрытый составитель снова.
  const [startsComposer, setStartsComposer] = useState(startComposer);
  const selectView = (next: GroupView): void => {
    setView(next);
    setStartsComposer(false);
  };
  const deleteGroup = useDeleteGroup();
  const side = usePairSide(group, pair);
  const { shown } = side;
  const isProject = scopeOf(group).kind === 'project';
  const when = shown.when ?? shown.scenario?.when ?? '';
  const changed = group.originChanged ?? [];
  const idBase = `group-${group.id}`;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={group.name}
      size="lg"
      headerActions={
        <>
          <Button size="sm" leftIcon={<Icon name="edit" size={16} />} onClick={() => onEdit(group)}>
            {t('common.edit')}
          </Button>
          <Button size="sm" leftIcon={<Icon name="copy" size={16} />} onClick={() => onCopy(group)}>
            {t('groupsPage.copy.button')}
          </Button>
          {isProject && (
            <Button
              size="sm"
              leftIcon={<Icon name="copy" size={16} />}
              onClick={() => onAdvice('copy', group)}
            >
              {t('groupSources.copyToGlobal')}
            </Button>
          )}
          <SandboxButton
            kind="group"
            title={group.name}
            selection={selectionOfGroup(group.members)}
          />
          <DeleteButton
            entityName={group.name}
            description={t('common.deleteGroup')}
            onDelete={() => deleteGroup.mutate(group.id, { onSuccess: onClose })}
            isPending={deleteGroup.isPending}
          />
        </>
      }
    >
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body-sm" color={when ? 'muted' : 'subtle'} className={styles.when}>
          <span className={styles.whenLabel}>{t('groupSources.when')}: </span>
          {when || t('groupSources.whenEmpty')}
        </Typography>

        {/* Оригинал в проекте правили после копии — говорим, что именно, и даём
          слить в нашу копию: молча расходящиеся копии — худший исход пары. */}
        {changed.length > 0 && (
          <Stack
            direction="row"
            align="center"
            gap="var(--spacing-sm)"
            wrap
            className={styles.changed}
          >
            <Icon name="warning" size={16} />
            <Typography variant="body-sm" as="span" className={styles.changedText}>
              {t('groupSources.originChanged', {
                files: changed
                  .map((key) =>
                    changedMemberLabel(key, (kind) =>
                      t(`groupSources.kind_${kind}`, { defaultValue: kind }),
                    ),
                  )
                  .join(', '),
              })}
            </Typography>
            <Button size="sm" onClick={() => onAdvice('merge', group)}>
              {t('groupSources.merge')}
            </Button>
          </Stack>
        )}

        {pair && side.pairPath && (
          <GroupPairSwitch
            group={group}
            pair={pair}
            path={side.pairPath}
            isGlobalActive={side.isGlobalActive}
            isError={side.isError}
          />
        )}

        <GroupViewTabs idBase={idBase} active={view} onSelect={selectView} />
        <div
          role="tabpanel"
          id={groupViewPanelId(idBase, view)}
          aria-labelledby={groupViewTabId(idBase, view)}
        >
          {/* Ключ — показанная группа: сторона пары сменилась — путь другой группы
              начинается с нуля (поиск, свёрнутые блоки, составитель). */}
          {view === 'path' && (
            <GroupPath key={shown.id} group={shown} startComposer={startsComposer} />
          )}
          {view === 'members' && <GroupDetails group={shown} />}
        </div>
      </Stack>
    </Modal>
  );
}
