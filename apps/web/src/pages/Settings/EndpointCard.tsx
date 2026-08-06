import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EndpointProbeResult, EndpointProfile } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { SelectField } from '@shared/ui/select-field';
import { toast } from '@shared/lib/toast';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import {
  useEndpoints,
  useProbeEndpoint,
  useApplyEndpoint,
  newEndpointProfile,
  replaceProfile,
  removeProfile,
  isProfileComplete,
} from '@entities/Endpoint';
import { EndpointProfileForm } from './EndpointProfileForm';
import { EndpointTargetRow } from './EndpointTargetRow';

/**
 * Свой эндпоинт: адрес, по которому CLI ходит в модель вместо облака вендора —
 * локальная модель, корпоративный шлюз или прокси.
 *
 * Профиль заводится один раз на уровне панели и раздаётся в CLI кнопкой, вместо
 * того чтобы вбивать `ANTHROPIC_BASE_URL` и его аналоги руками в каждом
 * разделе окружения. Кто примет профиль, а кто нет, решает документация самих
 * CLI: имя переменной адреса панель не выдумывает, и у кого его нет, строка
 * говорит об этом прямо.
 *
 * Проверка связи — отдельной кнопкой (запрос по сети), пробная генерация — не
 * здесь вовсе: она тратит токены, и её место в чате.
 */
export function EndpointCard() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  const [selectedId, setSelectedId] = useState('');
  const [probes, setProbes] = useState<Record<string, EndpointProbeResult>>({});
  const [applyingTo, setApplyingTo] = useState('');

  const { data } = useEndpoints(selectedId);
  const probe = useProbeEndpoint();
  const apply = useApplyEndpoint();

  if (!settings) return null;

  const profiles = settings.endpointProfiles;
  const active = profiles.find((item) => item.id === selectedId) ?? profiles[0];

  const saveProfiles = (next: EndpointProfile[]): void => {
    updateSettings.mutate({ endpointProfiles: next });
  };

  const addProfile = (): void => {
    // Идентификатор из времени и случайного хвоста: он никому не показывается,
    // а `crypto.randomUUID` требует защищённого контекста — панель открывают и
    // по http на 127.0.0.1.
    const id = `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const profile = newEndpointProfile(id, t('endpoints.newName', { n: profiles.length + 1 }));
    saveProfiles([...profiles, profile]);
    setSelectedId(id);
  };

  const runProbe = (): void => {
    if (!active) return;
    probe.mutate(active.id, {
      onSuccess: (result) => {
        setProbes((current) => ({ ...current, [active.id]: result }));
        if (result.ok) toast.success(t('endpoints.probeOk', { count: result.models.length }));
        else toast.error(result.error ?? t('endpoints.probeFailed'));
      },
      onError: () => toast.error(t('endpoints.probeFailed')),
    });
  };

  const runApply = (providerId: string): void => {
    if (!active) return;
    setApplyingTo(providerId);
    apply.mutate(
      { profileId: active.id, provider: providerId },
      {
        onSuccess: (result) => toast.success(t('endpoints.applied', { path: result.filePath })),
        onError: () => toast.error(t('endpoints.applyFailed')),
        onSettled: () => setApplyingTo(''),
      },
    );
  };

  const activeProbe = active ? probes[active.id] : undefined;
  const complete = active ? isProfileComplete(active) : false;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="body" weight="medium">
            {t('endpoints.title')}
          </Typography>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="plus" size={16} />}
            onClick={addProfile}
          >
            {t('endpoints.add')}
          </Button>
        </Stack>

        <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t('endpoints.hint')}
        </Typography>

        {!active ? (
          <Typography variant="body-sm" color="subtle">
            {t('endpoints.empty')}
          </Typography>
        ) : (
          <Stack gap="var(--spacing-sm)">
            {profiles.length > 1 && (
              <SelectField
                label={t('endpoints.profile')}
                value={active.id}
                onChange={setSelectedId}
                options={profiles.map((item) => ({ value: item.id, label: item.name }))}
              />
            )}

            <EndpointProfileForm
              profile={active}
              tokenMask={data?.tokenMasks[active.id] ?? ''}
              probe={activeProbe}
              onChange={(next) => saveProfiles(replaceProfile(profiles, next))}
            />

            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon name="check" size={16} />}
                onClick={runProbe}
                disabled={!complete}
                isLoading={probe.isPending}
              >
                {t('endpoints.probe')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Icon name="trash" size={16} />}
                onClick={() => {
                  saveProfiles(removeProfile(profiles, active.id));
                  setSelectedId('');
                }}
              >
                {t('endpoints.remove')}
              </Button>
              {activeProbe && (
                <Badge tone={activeProbe.ok ? 'success' : 'danger'} withDot>
                  {activeProbe.ok
                    ? t('endpoints.probeBadgeOk', { count: activeProbe.models.length })
                    : t('endpoints.probeBadgeFailed')}
                </Badge>
              )}
            </Stack>

            {activeProbe && !activeProbe.ok && activeProbe.error && (
              <Typography variant="caption" color="subtle">
                {activeProbe.error}
              </Typography>
            )}

            {/* Ассистент самой панели — отдельным выбором: панель и CLI могут
                смотреть в разные стороны, и переводить её вслед за правкой
                профиля молча нельзя. */}
            <SelectField
              label={t('endpoints.assistant')}
              value={settings.assistantEndpointId}
              onChange={(assistantEndpointId) => updateSettings.mutate({ assistantEndpointId })}
              options={[
                { value: '', label: t('endpoints.assistantOff') },
                ...profiles.map((item) => ({ value: item.id, label: item.name })),
              ]}
              hint={t('endpoints.assistantHint')}
            />

            <Typography variant="body" weight="medium">
              {t('endpoints.targets')}
            </Typography>
            <Stack gap="var(--spacing-2xs)">
              {(data?.targets ?? []).map((target) => (
                <EndpointTargetRow
                  key={target.providerId}
                  target={target}
                  disabled={!complete}
                  isApplying={apply.isPending && applyingTo === target.providerId}
                  onApply={runApply}
                />
              ))}
            </Stack>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
