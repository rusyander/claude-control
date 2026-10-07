import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { serverMessageText } from '@shared/config/i18n/server-message';
import { useGroupDelivery } from '@entities/Group';
import { changedMemberLabel } from './model/changedMembers';
import type { GroupDeliveryProps } from './GroupDelivery.types';
import styles from './GroupDelivery.module.scss';

/**
 * Что группа даст прогону активного чужого CLI — ответ сервера, а не догадка
 * клиента: тот же план слоя, что соберётся на запуске (`planGroupLayer`), только
 * без записи. Участник, который не доедет, назван вместе с причиной — иначе
 * человек узнал бы о нём лишь из заметки в ленте после прогона.
 */
export function GroupDelivery({ groupId, provider }: GroupDeliveryProps) {
  const { t } = useTranslation();
  const delivery = useGroupDelivery(groupId, provider.id);
  const cli = provider.name;
  const label = (key: string): string =>
    changedMemberLabel(key, (kind) => t(`groupSources.kind_${kind}`, { defaultValue: kind }));
  const data = delivery.data;

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.box} data-testid="group-delivery">
      <Typography variant="body-sm" weight="semibold" as="span">
        {t('groupsPage.delivery.title', { cli })}
      </Typography>
      {delivery.isError && (
        <Typography variant="caption" color="danger" as="p" role="alert">
          {t('groupsPage.delivery.loadFailed', { cli })}
        </Typography>
      )}
      {data?.model === 'none' && (
        <Typography variant="caption" color="subtle" as="p">
          {t('groupsPage.delivery.none', { cli })}
        </Typography>
      )}
      {data?.model === 'run-layer' && (
        <>
          <Typography variant="caption" color="subtle" as="p" data-testid="group-delivery-state">
            {t(data.enabled ? 'groupsPage.delivery.enabled' : 'groupsPage.delivery.disabled', {
              cli,
            })}
          </Typography>
          <Typography variant="caption" as="p">
            {data.delivered.length > 0
              ? t('groupsPage.delivery.delivered', {
                  count: data.delivered.length,
                  names: data.delivered.map((item) => label(item.member)).join(', '),
                })
              : t('groupsPage.delivery.nothingDelivered', { cli })}
          </Typography>
          {data.envNames.length > 0 && (
            <Typography variant="caption" color="subtle" as="p">
              {t('groupsPage.delivery.env', { names: data.envNames.join(', ') })}
            </Typography>
          )}
          {data.refused.length > 0 && (
            <>
              <Typography variant="caption" color="warning" as="span">
                {t('groupsPage.delivery.refused')}
              </Typography>
              <ul className={styles.list} data-testid="group-delivery-refused">
                {data.refused.map((item) => (
                  <li key={`${item.group}:${item.member}:${item.code}`}>
                    <Typography variant="caption" as="span">
                      {label(item.member)} —{' '}
                      {serverMessageText(item.code, item.params) ?? item.code}
                    </Typography>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
