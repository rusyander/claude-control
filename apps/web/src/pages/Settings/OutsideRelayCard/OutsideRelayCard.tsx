import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import {
  useOutsideRelay,
  useToggleOutsideRelay,
  type OutsideRelayState,
} from '@entities/MobileApp';
import { SettingToggleRow } from '../SettingToggleRow/SettingToggleRow';
import styles from './OutsideRelayCard.module.scss';

/**
 * Бейдж хука: стоит, стоит с таймаутом короче ожидания или нет вовсе.
 * Выключенной пересылке хуки не нужны — они сняты, и бейджа нет.
 */
function hookBadge(
  relay: OutsideRelayState,
): 'hookInstalled' | 'hookShort' | 'hookMissing' | undefined {
  if (!relay.enabled) return undefined;
  if (!relay.installed) return 'hookMissing';
  return relay.shortTimeout ? 'hookShort' : 'hookInstalled';
}

/**
 * Агент в терминале и VS Code — под контролем с телефона: вопросы, запросы прав
 * и сообщения посреди хода. За такую сессию отвечают хуки панели в настройках
 * Claude Code; панель вписывает их сама по переключателю. Если включено, а
 * хуков нет (запись не удалась, хук выключен в «Хуках»), карточка так и
 * говорит и даёт готовую команду, а не делает вид, что переключатель работает.
 */
export function OutsideRelayCard() {
  const { t } = useTranslation();
  const { data: relay } = useOutsideRelay();
  const toggle = useToggleOutsideRelay();
  const navigate = useNavigate();
  if (!relay) return null;

  const badge = hookBadge(relay);
  const copy = (): void => {
    void navigator.clipboard
      .writeText(relay.command)
      .then(() => toast.success(t('settings.phone.commandCopied')));
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center">
          <Typography variant="body" weight="medium">
            {t('settings.phone.relayTitle')}
          </Typography>
          {badge ? (
            <Badge tone={badge === 'hookInstalled' ? 'success' : 'warning'}>
              {t(`settings.phone.${badge}`)}
            </Badge>
          ) : null}
        </Stack>
        <Typography variant="body-sm" color="subtle" className="prose">
          {t('settings.phone.relayExplain')}
        </Typography>
        <SettingToggleRow
          label={t('settings.phone.relayToggle')}
          hint={t('settings.phone.relayToggleHint')}
          checked={relay.enabled}
          onChange={(enabled) => toggle.mutate(enabled)}
        />
        {relay.shortTimeout ? (
          <Typography variant="body-sm" color="warning" className="prose">
            {t('settings.phone.hookShortTimeout')}
          </Typography>
        ) : null}
        {!relay.enabled || relay.installed ? null : (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body-sm" className="prose">
              {t('settings.phone.hookHowTo')}
            </Typography>
            <pre className={styles.command}>{relay.command}</pre>
            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Button variant="secondary" onClick={copy}>
                {t('settings.phone.copyCommand')}
              </Button>
              <Button variant="ghost" onClick={() => void navigate({ to: '/hooks' } as never)}>
                {t('settings.phone.openHooks')}
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
