import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IMPORTABLE_MEMBER_KINDS } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { useImportDiscovered } from '@entities/Group';
import { foundText } from '../model/foundText';
import { GroupViewTabs } from '../GroupViewTabs/GroupViewTabs';
import type { GroupView } from '../GroupViewTabs.types';
import type { FoundDialogProps } from './FoundDialog.types';
import styles from './FoundDialog.module.scss';
import { groupViewTabId } from '../lib/groupViewTabId';
import { groupViewPanelId } from '../lib/groupViewPanelId';
import { uiLang } from '../model/uiLang';
import { sourceLabel } from '../model/sourceLabel';

/**
 * Окно находки обнаружения: то же устройство, что у группы, — «Когда», почему
 * это набор, «Порядок работы» и «Состав» с одной строкой у каждого участника,
 * — чтобы решение «Импортировать» принималось по содержанию.
 */
export function FoundDialog({ found, onClose }: FoundDialogProps) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<GroupView>('path');
  const text = foundText(found, i18n.language);
  const importFound = useImportDiscovered();
  const source = sourceLabel(found.foundIn);
  const foundIn =
    source.kind === 'provider'
      ? t('groupSources.providerSource', { name: source.name })
      : source.name;
  const idBase = `found-${found.key.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  // Что импорт в группу не перенесёт — называется до «Импортировать», а не теряется молча.
  const left = found.members.filter((member) => !IMPORTABLE_MEMBER_KINDS.includes(member.kind));

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={text.name}
      size="lg"
      headerActions={
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Icon name="plus" size={16} />}
          isLoading={importFound.isPending}
          aria-label={t('groupSources.importAria', { name: text.name })}
          onClick={() =>
            importFound.mutate(
              { key: found.key, lang: uiLang(i18n.language) },
              { onSuccess: onClose },
            )
          }
        >
          {t('groupSources.import')}
        </Button>
      }
    >
      <Stack gap="var(--spacing-sm)">
        <Typography
          variant="body-sm"
          color={text.when ? 'muted' : 'subtle'}
          className={styles.text}
        >
          <span className={styles.label}>{t('groupSources.when')}: </span>
          {text.when || t('groupSources.whenEmpty')}
        </Typography>
        {text.why && (
          <Typography variant="body-sm" color="subtle" className={styles.text}>
            <span className={styles.label}>{t('groupSources.why')}: </span>
            {text.why}
          </Typography>
        )}

        {left.length > 0 && (
          <Typography variant="body-sm" color="warning" className={styles.text}>
            {t('groupSources.importLeaves', {
              count: left.length,
              total: found.members.length,
              names: left.map((member) => member.id).join(', '),
            })}
          </Typography>
        )}

        <GroupViewTabs idBase={idBase} active={view} onSelect={setView} />
        <div
          role="tabpanel"
          id={groupViewPanelId(idBase, view)}
          aria-labelledby={groupViewTabId(idBase, view)}
        >
          {view === 'path' &&
            (found.steps.length === 0 ? (
              <Typography variant="body-sm" color="subtle">
                {t('groupSources.stepsEmpty')}
              </Typography>
            ) : (
              <ol className={styles.list} aria-label={t('groupPath.listLabel')}>
                {found.steps.map((step, index) => (
                  <li key={`${index}:${step.title}`} className={styles.step}>
                    <span className={styles.number} aria-hidden="true">
                      {index + 1}
                    </span>
                    <Typography variant="body-sm" as="span" className={styles.stepTitle}>
                      {step.title}
                    </Typography>
                    {step.source && (
                      <Badge tone="info">
                        {t('groupPath.sourceChip', {
                          source: t('groupPath.source.skill'),
                          id: step.source,
                        })}
                      </Badge>
                    )}
                  </li>
                ))}
              </ol>
            ))}
          {view === 'members' && (
            <Stack gap="var(--spacing-sm)">
              {found.members.length === 0 ? (
                <Typography variant="body-sm" color="subtle">
                  {t('groupSources.membersEmpty')}
                </Typography>
              ) : (
                <ol className={styles.members}>
                  {found.members.map((member) => (
                    <li key={`${member.kind}:${member.id}`} className={styles.member}>
                      <Badge tone="neutral">{t(`groupSources.kind_${member.kind}`)}</Badge>
                      <Typography variant="body-sm" weight="medium" as="span">
                        {member.id}
                      </Typography>
                      {!IMPORTABLE_MEMBER_KINDS.includes(member.kind) && (
                        <Badge tone="warning">{t('groupSources.importLeavesBadge')}</Badge>
                      )}
                      <Typography
                        variant="body-sm"
                        color="subtle"
                        as="span"
                        className={styles.summary}
                      >
                        {member.summary || t('groupSources.memberNoDescription')}
                      </Typography>
                    </li>
                  ))}
                </ol>
              )}
              <dl className={styles.facts}>
                <dt>
                  <Typography variant="caption" color="subtle" as="span">
                    {t('groupSources.foundIn')}
                  </Typography>
                </dt>
                <dd>
                  <Typography variant="mono" as="span">
                    {foundIn}
                  </Typography>
                </dd>
                <dt>
                  <Typography variant="caption" color="subtle" as="span">
                    {t('groupSources.usedIn')}
                  </Typography>
                </dt>
                <dd>
                  <Typography variant="mono" as="span">
                    {found.usedIn.length === 0
                      ? t('groupSources.usedInNone')
                      : found.usedIn.join('\n')}
                  </Typography>
                </dd>
              </dl>
            </Stack>
          )}
        </div>
      </Stack>
    </Modal>
  );
}
