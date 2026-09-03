import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { SETTINGS_ROUTE } from '@shared/config/routes';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { useProviderRunner, useSaveProviderKey } from '@entities/ProviderKeys';

/**
 * Гейт ключа ассистента на входе в чат (Ф6a).
 *
 * Резолвит раннер активного провайдера. Если раннер `none` (нет ключа И CLI не
 * найден) — показывает модалку с просьбой вставить API-ключ и ссылкой в
 * настройки. Ключ сохраняется через тот же зашифрованный механизм. Если раннер
 * `api` (есть ключ) или `cli` (найден CLI) — модалки НЕТ. Для Claude в текущей
 * среде (CLI `claude` установлен) раннер = `cli`, поэтому модалка не появляется —
 * поведение чата не меняется.
 *
 * Модалку можно закрыть: она не блокирует интерфейс, а лишь подсказывает. Для
 * провайдера без модельного API (Cursor, apiKind `none`) поле ввода не
 * показывается — только предложение выбрать другого провайдера в настройках.
 */
export function AssistantKeyGate() {
  const { t } = useTranslation();
  const { data: runner } = useProviderRunner();
  const save = useSaveProviderKey();

  const [dismissed, setDismissed] = useState(false);
  const [key, setKey] = useState('');

  // Новый резолв (сменили провайдера/задали ключ) — снова разрешаем показ.
  useEffect(() => {
    setDismissed(false);
  }, [runner?.providerId, runner?.mode]);

  if (!runner || runner.mode !== 'none') return null;

  const isUnsupported = runner.reason === 'unsupported' || runner.apiKind === 'none';
  const isOpen = !dismissed;

  const submit = (): void => {
    const trimmed = key.trim();
    if (!trimmed) return;
    save.mutate(
      { providerId: runner.providerId, key: trimmed },
      {
        onSuccess: () => {
          setKey('');
          setDismissed(true);
        },
      },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => !open && setDismissed(true)}
      title={t('assistantKey.title', { provider: runner.providerName })}
      description={
        isUnsupported
          ? t('assistantKey.unsupported', { provider: runner.providerName })
          : t('assistantKey.description', { provider: runner.providerName })
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => setDismissed(true)}>
            {t('common.close')}
          </Button>
          {/* Ключи провайдеров лежат во вкладке «Провайдеры» — ведём сразу туда. */}
          <Link
            to={SETTINGS_ROUTE}
            search={{ tab: 'providers' }}
            onClick={() => setDismissed(true)}
          >
            <Button variant="ghost">{t('assistantKey.openSettings')}</Button>
          </Link>
          {!isUnsupported && (
            <Button onClick={submit} isLoading={save.isPending} disabled={!key.trim()}>
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      {isUnsupported ? (
        <Typography variant="body-sm" color="subtle">
          {t('assistantKey.unsupportedHint', { provider: runner.providerName })}
        </Typography>
      ) : (
        <Stack gap="var(--spacing-md)">
          {/* Шаг 1 — ПРЕДПОЧТИТЕЛЬНО: вход в CLI провайдера (подписка, без оплаты
              по токенам). Приоритет подписки — незыблемое правило. */}
          {runner.cliRunnable && (
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="body-sm" weight="medium">
                {t('assistantKey.subscriptionTitle')}
              </Typography>
              <Typography variant="body-sm" color="subtle">
                {t('assistantKey.subscriptionHint', { command: runner.cliCommand })}
              </Typography>
              <Typography variant="caption" color="subtle">
                {t([`assistantKey.cliLogin.${runner.providerId}`, 'assistantKey.cliLoginGeneric'], {
                  command: runner.cliCommand,
                })}
              </Typography>
            </Stack>
          )}

          {/* Шаг 2 — ФОЛБЭК: платный API-ключ (только если подписки/CLI нет). */}
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('assistantKey.apiTitle')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t([`assistantKey.apiKeyHow.${runner.apiKind}`, 'assistantKey.apiKeyHowGeneric'])}
            </Typography>
            <TextField
              label={t('assistantKey.inputLabel', { provider: runner.providerName })}
              type="password"
              value={key}
              onChange={setKey}
              placeholder={t('assistantKey.inputPlaceholder')}
            />
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}
