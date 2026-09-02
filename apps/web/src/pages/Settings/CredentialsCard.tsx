import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { TextField } from '@shared/ui/text-field';
import { TEMPLATES, TONE } from './CredentialsCard.constants';
import styles from './SettingsPage.module.scss';

/**
 * Доступ Claude Code к аккаунту.
 *
 * Нужен ровно одной вещи — песочнице: она запускает Claude с отдельным
 * каталогом конфигурации, и штатный доступ туда не попадает. Всё остальное
 * работает с настоящим каталогом и в этой карточке не нуждается.
 *
 * Токен здесь не показывается никогда: сервер отдаёт только источник.
 */

interface CredentialsStatus {
  source: 'file' | 'keychain' | 'panel' | 'apiKey' | 'none';
  reason?: string;
  hasManual: boolean;
  manualPath: string;
  platform: string;
}

export function CredentialsCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const status = useQuery({
    queryKey: ['credentials'],
    queryFn: async () => {
      const { data } = await apiClient.get<CredentialsStatus>('/credentials');
      return data;
    },
  });

  const save = useMutation({
    mutationFn: async (raw: string) => {
      await apiClient.post('/credentials', { value: raw });
    },
    onSuccess: () => {
      setIsOpen(false);
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (mutationError: unknown) => {
      const message = (mutationError as { response?: { data?: { message?: string } } })?.response
        ?.data?.message;
      setError(message ?? t('credentials.saveFailed'));
    },
    meta: { silentError: true },
  });

  const clear = useMutation({
    mutationFn: async () => {
      await apiClient.delete('/credentials');
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['credentials'] }),
  });

  const source = status.data?.source ?? 'none';

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('credentials.title')}
          </Typography>
          {/* При ошибке запроса бейдж молчит: «не найден» там был бы неправдой —
              мы просто не знаем. */}
          {!status.isError && (
            <Badge tone={TONE[source]} withDot>
              {t(`credentials.source_${source}`)}
            </Badge>
          )}
        </Stack>

        <Typography variant="caption" color="subtle" className="prose">
          {t('credentials.purpose')}
        </Typography>

        {status.isError && (
          <Typography variant="body-sm" color="danger" className="prose">
            {t('credentials.loadError')}
          </Typography>
        )}

        {status.data?.reason && (
          <Typography variant="body-sm" color="warning" className="prose">
            {status.data.reason}
          </Typography>
        )}

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="edit" size={20} />}
            onClick={() => {
              setValue(TEMPLATES.oauth);
              setError(undefined);
              setIsOpen(true);
            }}
          >
            {t('credentials.setManually')}
          </Button>

          {status.data?.hasManual && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="trash" size={20} />}
              onClick={() => clear.mutate()}
              isLoading={clear.isPending}
            >
              {t('credentials.clearManual')}
            </Button>
          )}
        </Stack>

        {status.data?.hasManual && (
          <Typography variant="caption" color="subtle">
            {t('credentials.manualFile')}: <code>{status.data.manualPath}</code>
          </Typography>
        )}
      </Stack>

      <Modal
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        title={t('credentials.manualTitle')}
        description={t('credentials.manualHint')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => save.mutate(value)} isLoading={save.isPending}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Stack gap="var(--spacing-md)">
          {/* Три готовых образца: подставить своё проще, чем вспоминать поля. */}
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium" as="span">
              {t('credentials.templates')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              {(['oauth', 'apiKey', 'readFrom'] as const).map((kind) => (
                <Button
                  key={kind}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setValue(TEMPLATES[kind]);
                    setError(undefined);
                  }}
                >
                  {t(`credentials.template_${kind}`)}
                </Button>
              ))}
            </Stack>
          </Stack>

          <TextField
            label={t('credentials.jsonLabel')}
            value={value}
            onChange={(next) => {
              setValue(next);
              setError(undefined);
            }}
            multiline
            rows={12}
            isMono
            error={error}
            hint={t('credentials.jsonHint')}
          />

          <Typography variant="caption" color="subtle" className={styles.credentialsWarning}>
            {t('credentials.securityNote')}
          </Typography>
        </Stack>
      </Modal>
    </Card>
  );
}
