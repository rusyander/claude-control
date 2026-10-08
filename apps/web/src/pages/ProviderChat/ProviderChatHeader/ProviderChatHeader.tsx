import { useTranslation } from 'react-i18next';
import { foreignConsumerId } from '@agentdeck/contracts/platform-consumers';
import { usePlatformRunPlan } from '@entities/Platform';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import type { ProviderChatHeaderProps } from './ProviderChatHeader.types';
import styles from './ProviderChatHeader.module.scss';
import {
  platformRunChoice,
  platformModelCaption,
  platformRefusalCaption,
  platformBypassCaption,
} from '../../../shared/lib/chat-model';

/**
 * Шапка разговора: как он называется, чем отвечает провайдер и где работает CLI.
 *
 * Способ ответа (`stream` / `session` / `api`) показывается меткой не ради
 * украшения: у одного и того же провайдера он зависит от того, установлен ли
 * CLI и есть ли ключ, — и без метки непонятно, почему ответ приходит сразу
 * целиком, а не по словам.
 */
export function ProviderChatHeader({
  chat,
  providerName,
  providerId,
  runner,
  isRunning,
  onRename,
  onPickWorkdir,
  onDelete,
  onStop,
  onRestart,
  isRestarting,
  allowEdits,
  onAllowEditsChange,
  editsWhenOff,
}: ProviderChatHeaderProps) {
  const { t } = useTranslation();
  const transport = chat?.messages.findLast((message) => message.transport)?.transport;
  const offLabel =
    editsWhenOff === 'deny' ? t('providerChat.editsDenied') : t('providerChat.editsAsk');
  const editsLabel = allowEdits === true ? t('providerChat.editsAllowed') : offLabel;

  // Через контур модель разговора — просьба, а не решение (Т6): имя вендора
  // контур не знает, и оно переводится картой соответствия. Считается ТОЙ ЖЕ
  // функцией, что на сервере: второй расчёт разошёлся бы молча, и метка модели
  // показывала бы имя, которого в запросе нет.
  const plan = usePlatformRunPlan(providerId ? foreignConsumerId(providerId) : '');
  const routed = plan.data?.routed === true ? plan.data : undefined;
  const caption = routed
    ? platformModelCaption(routed.title, platformRunChoice(routed.rules, chat?.model ?? ''))
    : undefined;
  const refusal = platformRefusalCaption(plan.data);
  // Уход мимо контура — той же меткой, что и в шапке своего чата (решение №4).
  const bypass = platformBypassCaption(plan.data);

  const rename = (): void => {
    const next = window.prompt(t('providerChat.renamePrompt'), chat?.title ?? '');
    if (next?.trim()) onRename(next.trim());
  };

  return (
    <Stack
      direction="row"
      align="center"
      justify="between"
      gap="var(--spacing-sm)"
      wrap
      padding="var(--spacing-xs) var(--spacing-xl)"
      className={styles.header}
    >
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
        <Typography variant="body" weight="medium">
          {chat?.title ?? t('providerChat.title', { provider: providerName })}
        </Typography>
        {runner && runner.mode !== 'none' && (
          <Badge tone="neutral">{t(`providerChat.mode.${runner.mode}`)}</Badge>
        )}
        {transport && <Badge tone="neutral">{t(`providerChat.transport.${transport}`)}</Badge>}
        {/* Чем ведётся разговор, когда модель подобрала панель (разделение задач,
            Т12). Без метки человек не знает, что этот чат идёт не тем, что
            настроено у CLI, — а знать он это обязан: подбор только ПОНИЖАЕТ. */}
        {chat?.model && (
          <Badge tone="neutral">{t('providerChat.modelBadge', { model: chat.model })}</Badge>
        )}
        {/* Метка контура стоит рядом с меткой модели и только когда разговор
            идёт через контур: в обычном чате она была бы шумом, а здесь —
            единственное место, где видно, что выбранное имя по дороге заменят
            (или что модель есть, хотя чат её не выбирал). */}
        {caption && (
          <Badge tone={caption.warn ? 'warning' : 'neutral'}>
            {t(caption.key, caption.params)}
          </Badge>
        )}
        {refusal && (
          <Badge tone="warning">
            {t(refusal.key, {
              title: refusal.params.title,
              reason: t(`chat.platformRefusedReason.${refusal.params.reason}`, {
                setting: refusal.params.setting,
              }),
              fix: t(`chat.platformRefusedFix.${refusal.params.reason}`),
            })}
          </Badge>
        )}
        {bypass && (
          <Badge tone="warning">
            {t(bypass.key, {
              title: bypass.params.title,
              reason: t(`chat.platformRefusedReason.${bypass.params.reason}`, {
                setting: bypass.params.setting,
              }),
              fix: t(`chat.platformRefusedFix.${bypass.params.reason}`),
            })}
          </Badge>
        )}
        {routed && !routed.effort && (
          <Badge tone="neutral">{t('chat.platformNoEffort', { title: routed.title })}</Badge>
        )}
        {chat?.workdir && (
          <Badge tone="neutral">{t('providerChat.workdirBadge', { path: chat.workdir })}</Badge>
        )}
      </Stack>

      <Stack direction="row" align="center" gap="var(--spacing-3xs)" wrap>
        {/* «Разрешить правки» — тот же переключатель, что у Claude, но в шапке
            разговора и в его шапке на диске. Выключенный значит у CLI с живым
            сервером вопрос человеку карточкой, у одиночного запуска — запись
            закрыта флагом: спросить там некого, обещать карточку нельзя. */}
        {onAllowEditsChange && chat && (
          <Stack as="label" direction="row" align="center" gap="var(--spacing-2xs)">
            <Toggle
              size="sm"
              checked={allowEdits === true}
              onCheckedChange={onAllowEditsChange}
              aria-label={t('providerChat.allowEdits')}
            />
            <Typography
              variant="body-sm"
              color={allowEdits === true ? 'default' : 'subtle'}
              as="span"
            >
              {editsLabel}
            </Typography>
          </Stack>
        )}
        {!onAllowEditsChange && chat && runner && !runner.editsToggle && (
          <Typography variant="caption" color="subtle" as="span">
            {t('providerChat.editsByCli', { name: runner.providerName })}
          </Typography>
        )}
        {isRunning && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onStop}
            leftIcon={<Icon name="stop" size={16} />}
          >
            {t('providerChat.stop')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onPickWorkdir} disabled={!chat}>
          {t('providerChat.workdir')}
        </Button>
        {/* Перезапуск (Т7): у чужого CLI сессии нет, и кнопка обещает ровно то,
            что панель делает, — новый разговор с контрольной точкой. Пока идёт
            ответ, перезапускать нечего: сервер ответил бы 409. */}
        {onRestart && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRestart}
            disabled={!chat || isRunning}
            isLoading={isRestarting}
            title={t('providerChat.restartTitle')}
          >
            {t('providerChat.restart')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={rename} disabled={!chat}>
          {t('providerChat.rename')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={!chat}>
          {t('providerChat.delete')}
        </Button>
      </Stack>
    </Stack>
  );
}
