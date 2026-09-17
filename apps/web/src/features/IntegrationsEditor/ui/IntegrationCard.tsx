import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BadgeTone } from '@shared/ui/badge';
import type { IntegrationId, IntegrationsSettings, TelegramEvent } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import {
  TELEGRAM_EVENTS,
  useCheckIntegration,
  useForgetIntegration,
  useSaveIntegration,
} from '@entities/Integration';
import { integrationSecretAnchor } from '@entities/PanelAgent';
import { buildSettings, draftFrom, isDraftDirty, missingFields } from '../model/draft';
import { IntegrationFields } from './IntegrationFields';
import { IntegrationCardExtras } from './IntegrationCardExtras';
import type { IntegrationCardProps } from './IntegrationCard.types';

/** На что подписана карточка. У коннекторов без подписки список пуст. */
function eventsOf(settings: IntegrationsSettings, id: IntegrationId): TelegramEvent[] {
  if (id === 'telegram') return settings.telegram.events;
  if (id === 'webhook') return settings.webhook.events;
  return [];
}

/** Итог проверки цветом: настроено, отвалилось, ещё не спрашивали. */
const STATE_TONE: Record<string, BadgeTone> = {
  ok: 'success',
  error: 'danger',
  unchecked: 'neutral',
};

/**
 * Карточка одного коннектора: настройки, токен, включение и живая проверка.
 *
 * Токен показывается ТОЛЬКО маской — сервер сам значение не отдаёт, и поле
 * ввода всегда пустое. Пустым оно и уходит: непустое поле означает «заменить
 * ключ», а забыть его можно только отдельной кнопкой. Иначе правка адреса
 * молча стирала бы доступ.
 *
 * «Проверить связь» — единственный честный ответ на вопрос «работает ли»: в
 * настройках может быть всё правильно, а токен уже отозван. Результат живёт в
 * карточке, а не в тосте: тост исчезает, а причина отказа нужна ровно тогда,
 * когда правят поля.
 */
export function IntegrationCard({ id, status, settings }: IntegrationCardProps) {
  const { t } = useTranslation();
  const saved = settings[id];

  const save = useSaveIntegration();
  const check = useCheckIntegration();
  const forget = useForgetIntegration();

  const [draft, setDraft] = useState(() => draftFrom(id, saved as never));
  // События подписаны у двух карточек, и у каждой свои: подписка на вебхук не
  // должна меняться от правки Telegram и наоборот.
  const subscribed = eventsOf(settings, id);
  const [events, setEvents] = useState<TelegramEvent[]>(() => subscribed);
  const [token, setToken] = useState('');

  // Настройки приезжают запросом: до их прихода форма собрана из умолчаний, и
  // без пересборки человек правил бы пустые поля поверх сохранённых значений.
  useEffect(() => {
    setDraft(draftFrom(id, saved as never));
    // Пересобираем форму по САМИМ настройкам, а не по их ссылке в замыкании.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, JSON.stringify(saved)]);

  useEffect(() => {
    setEvents(subscribed);
    // Пересобираем по значению, а не по ссылке массива: она новая на каждом ответе.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, subscribed.join(',')]);

  const missing = missingFields(id, draft);
  const isDirty =
    isDraftDirty(id, draft, saved) ||
    Boolean(token.trim()) ||
    events.join(',') !== subscribed.join(',');

  const onFieldChange = (key: string, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = (enabled: boolean): void => {
    save.mutate({
      id,
      settings: buildSettings({ id, draft, enabled, events }),
      token: token.trim() ? token.trim() : undefined,
    });
    setToken('');
  };

  const state = status?.state ?? 'unchecked';

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body" weight="medium" as="span">
              {t(`integrations.card.${id}.title`)}
            </Typography>
            <Badge tone={STATE_TONE[state] ?? 'neutral'} withDot>
              {t(`integrations.state.${state}`)}
            </Badge>
            {status?.deployment && (
              <Badge tone="info">{t(`integrations.deployment.${status.deployment}`)}</Badge>
            )}
          </Stack>

          <Stack direction="row" align="center" gap="var(--spacing-2xs)">
            <Typography variant="caption" color="subtle" as="span">
              {t('integrations.card.enabled')}
            </Typography>
            <Toggle
              checked={saved.enabled}
              aria-label={t('integrations.card.enabledAria', {
                name: t(`integrations.card.${id}.title`),
              })}
              // Включение — отдельное действие: у него свой смысл («панель может
              // ходить наружу»), и прятать его внутрь «Сохранить» нельзя.
              onCheckedChange={(next) => submit(next)}
              disabled={save.isPending || (missing.length > 0 && !saved.enabled)}
            />
          </Stack>
        </Stack>

        <Typography variant="body-sm" color="subtle" className="prose">
          {t(`integrations.card.${id}.hint`)}
        </Typography>

        <IntegrationFields id={id} draft={draft} onChange={onFieldChange} missing={missing} />

        <IntegrationCardExtras
          id={id}
          events={events}
          onEventsChange={setEvents}
          allEvents={TELEGRAM_EVENTS}
        />

        <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
          <Stack flex={1} minWidth="220px" data-agent-anchor={integrationSecretAnchor(id)}>
            <TextField
              label={t('integrations.card.token')}
              type="password"
              value={token}
              onChange={setToken}
              placeholder={t('integrations.card.tokenPlaceholder')}
              // Маска — в подсказке, а не в placeholder: подсказка остаётся на
              // экране и в дереве доступности, а placeholder исчезает с первым
              // набранным символом, и «какой ключ тут лежит» пропадает ровно в
              // тот момент, когда человек решает, менять ли его.
              hint={[
                status?.hasToken
                  ? t('integrations.card.tokenSaved', { mask: status.maskedToken })
                  : t('integrations.card.tokenEmpty'),
                t(`integrations.card.${id}.tokenHint`),
              ].join(' ')}
            />
          </Stack>

          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="check" size={18} />}
            onClick={() => submit(saved.enabled)}
            // Незаполненное обязательное поле гасит не только тумблер, но и
            // сохранение УЖЕ включённой карточки: иначе включённый Zephyr,
            // переключённый на Test IT, сохранялся включённым и без адреса —
            // карточка горела зелёным, а первая же кнопка отвечала отказом.
            // Выключенную карточку это не трогает: её заполняют в несколько
            // заходов, и запрещать сохранять половину формы незачем.
            disabled={!isDirty || (saved.enabled && missing.length > 0)}
            isLoading={save.isPending}
          >
            {t('common.save')}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="refresh" size={18} />}
            onClick={() => check.mutate(id)}
            isLoading={check.isPending}
          >
            {t('integrations.card.check')}
          </Button>

          {status?.hasToken && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="trash" size={18} />}
              onClick={() => forget.mutate(id)}
              isLoading={forget.isPending}
            >
              {t('integrations.card.forget')}
            </Button>
          )}
        </Stack>

        {missing.length > 0 && (
          <Typography variant="caption" color="warning">
            {t('integrations.card.missing', {
              fields: missing.map((key) => t(`integrations.field.${id}.${key}`)).join(', '),
            })}
          </Typography>
        )}

        {status?.detail && (
          <Typography variant="caption" color={state === 'error' ? 'danger' : 'subtle'}>
            {status.detail}
          </Typography>
        )}

        {status?.account && (
          <Typography variant="caption" color="subtle">
            {t('integrations.card.account', { name: status.account })}
          </Typography>
        )}

        {status?.checkedAt && (
          <Typography variant="caption" color="subtle">
            {t('integrations.card.checkedAt', {
              time: new Date(status.checkedAt).toLocaleString(),
            })}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
