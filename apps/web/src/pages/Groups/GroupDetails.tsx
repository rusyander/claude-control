import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useGroupMembers } from '@entities/Group';
import { useMemberLines } from './model/useMemberLines';
import { foundInOf } from './model/sections';
import { GroupMemberRow } from './GroupMemberRow';
import { GroupProjectLocal } from './GroupProjectLocal';
import type { GroupDetailsProps } from './GroupDetails.types';
import styles from './GroupDetails.module.scss';

/**
 * Вкладка «Состав»: участники по порядку с одной строкой «что делает» у каждого
 * участника, откуда группа взялась и где используется. Пути — текстом: их
 * выделяют и копируют, а не кликают.
 */
export function GroupDetails({ group }: GroupDetailsProps) {
  const { t } = useTranslation();
  const lineOf = useMemberLines();
  const briefs = useGroupMembers(group.id);
  const briefOf = (kind: string, id: string) =>
    briefs.data?.members.find((item) => item.kind === kind && item.id === id);
  const pending = new Set(briefs.data?.pending ?? []);
  const foundIn = foundInOf(group);
  // Сервер досчитывает `usedIn`; до него (или на старом сервере) это привязки.
  const usedIn = group.usedIn ?? group.projectPaths ?? [];

  return (
    <Stack gap="var(--spacing-sm)">
      {group.description && (
        <Typography variant="body-sm" color="muted" className={styles.description}>
          {group.description}
        </Typography>
      )}

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle">
          {t('groupSources.members')}
        </Typography>
        {group.members.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {t('groupSources.membersEmpty')}
          </Typography>
        ) : (
          <ol className={styles.members}>
            {group.members.map((member) => (
              <GroupMemberRow
                key={`${member.kind}:${member.id}`}
                member={member}
                line={lineOf(member)}
                brief={briefOf(member.kind, member.id)}
                isReading={briefs.isLoading}
                isPending={pending.has(`${member.kind}:${member.id}`)}
              />
            ))}
          </ol>
        )}
      </Stack>

      <dl className={styles.facts}>
        {foundIn && (
          <>
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
          </>
        )}
        <dt>
          <Typography variant="caption" color="subtle" as="span">
            {t('groupSources.usedIn')}
          </Typography>
        </dt>
        <dd>
          {usedIn.length === 0 ? (
            <Typography variant="body-sm" color="subtle" as="span">
              {t('groupSources.usedInNone')}
            </Typography>
          ) : (
            <Stack gap="var(--spacing-3xs)">
              {usedIn.map((path) => (
                <Typography key={path} variant="mono" as="span">
                  {path}
                </Typography>
              ))}
            </Stack>
          )}
        </dd>
      </dl>

      {/* Собственный набор привязанного проекта: без него группа с привязкой
        выглядела пустой, хотя агент в ней работает с его правилами и скиллами. */}
      {(group.projectPaths ?? []).length > 0 && (
        <GroupProjectLocal paths={group.projectPaths ?? []} />
      )}
    </Stack>
  );
}
