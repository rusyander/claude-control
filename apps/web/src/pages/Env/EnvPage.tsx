import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { EnvVar } from '@claude-control/contracts';
import { apiClient, toErrorMessage } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { toast } from '@shared/lib/toast';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { SourceBadge } from '@shared/ui/source-badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useSettings } from '@entities/AppConfig';
import { useGroups } from '@entities/Group';
import { EnvFormModal, envFileName } from '@features/EnvEditor';
import { DeleteButton } from '@features/EntityDelete';
import styles from './EnvPage.module.scss';

/**
 * Полное значение секрета — отдельным запросом. Тело читаем сырым текстом:
 * обычный разбор axios пробует JSON.parse на любом теле, и чисто числовой
 * секрет приезжал бы числом, а секрет вида `{"a":1}` — объектом.
 */
async function fetchRevealed(item: EnvVar): Promise<string> {
  const { data } = await apiClient.get<unknown>('/env/reveal', {
    params: { key: item.key, source: item.source },
    transformResponse: [(raw: unknown) => raw],
  });
  return typeof data === 'string' ? data : String(data);
}

/**
 * Бейдж источника. Локальный файл — общим бейджем с его объяснением; переменная
 * включённой группы — именем группы: она лежит в settings.json, но её хозяин —
 * группа, и правится она там (удалённую здесь группа вернула бы при следующем
 * включении). Остальные — именем файла, а не словом из enum: человек ищет
 * глазами settings.json, не «settings».
 */
function EnvSourceBadge({ item, groupName }: { item: EnvVar; groupName?: string }) {
  const { t } = useTranslation();
  if (item.source === 'settings-local') return <SourceBadge source="settings-local" />;
  if (item.source === 'group') {
    return (
      <Badge tone="accent">{t('env.groupBadge', { name: groupName ?? item.groupId ?? '' })}</Badge>
    );
  }
  return (
    <Badge tone={item.source === 'secrets' ? 'warning' : 'neutral'}>
      {envFileName(item.source)}
    </Badge>
  );
}

/**
 * Переменные окружения. Значения секретов приходят с сервера уже
 * замаскированными — полное значение запрашивается отдельно: по клику или,
 * если так решено в настройках приложения («показывать секреты сразу»), при
 * загрузке списка.
 */
export function EnvPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<EnvVar | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);
  // Имена групп для бейджа «группа: …»: в ответе /api/env есть только groupId.
  const { data: groups = [] } = useGroups();

  const removeVar = useMutation({
    mutationFn: async (item: EnvVar) => {
      const { data } = await apiClient.delete('/env', {
        params: { key: item.key, source: item.source },
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.env });
    },
    meta: { successMessage: 'toasts.deleted' },
  });

  // Перенос переменной между settings.json и settings.local.json. Секреты из
  // .mcp-secrets.env так не переносятся — для них кнопки нет (см. ниже).
  const moveVar = useMutation({
    mutationFn: async (item: EnvVar) => {
      const { data } = await apiClient.post(`/env/${encodeURIComponent(item.key)}/move`, {
        source: item.source,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.env });
    },
    meta: { successMessage: 'toasts.moved' },
  });

  const { data: vars = [], isLoading } = useQuery({
    queryKey: queryKeys.env,
    queryFn: async () => {
      const { data } = await apiClient.get<EnvVar[]>('/env');
      return data;
    },
  });

  // «Показывать секреты сразу» из настроек приложения: каждый секрет
  // раскрывается один раз, когда впервые появился в списке. Один раз — чтобы
  // кнопка «скрыть» по-прежнему работала, а не проигрывала эффекту.
  const { data: appSettings } = useSettings();
  const revealByDefault = appSettings?.revealSecretsByDefault ?? false;
  const autoRevealed = useRef(new Set<string>());
  useEffect(() => {
    if (!revealByDefault) return;
    const pending = vars.filter((item) => item.isSecret && !autoRevealed.current.has(item.id));
    if (pending.length === 0) return;
    for (const item of pending) autoRevealed.current.add(item.id);

    void Promise.all(
      pending.map(
        async (item) => [item.id, await fetchRevealed(item).catch(() => undefined)] as const,
      ),
    ).then((pairs) => {
      setRevealed((current) => {
        const next = { ...current };
        for (const [id, text] of pairs) if (text !== undefined) next[id] = text;
        return next;
      });
    });
  }, [revealByDefault, vars]);

  // Ссылка /env?id=<источник:ключ> — так сюда приводит поиск — открывает
  // переменную на правку; открытие дописывает id в адрес, закрытие снимает.
  const writeUrl = useEntityUrlWriter();
  const openEdit = (item: EnvVar): void => {
    setEditing(item);
    setIsFormOpen(true);
    writeUrl(item.id);
  };
  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };
  useEntityUrl<EnvVar>({ items: vars, getId: (item) => item.id, onOpen: openEdit });

  const reveal = async (item: EnvVar): Promise<void> => {
    if (revealed[item.id] !== undefined) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }

    try {
      const text = await fetchRevealed(item);
      setRevealed((current) => ({ ...current, [item.id]: text }));
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('env.title')}
        subtitle={t('env.subtitle')}
        helpTopic="env"
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size={24} />}
            onClick={() => {
              setEditing(undefined);
              setIsFormOpen(true);
            }}
          >
            {t('env.addVar')}
          </Button>
        }
      />

      <ExplainBox title={t('env.explainTitle')} text={t('env.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      <Card padding="none">
        <Stack>
          {vars.map((item) => (
            <Stack
              key={item.id}
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-sm)"
              className={styles.row}
            >
              <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="mono" weight="medium" as="span">
                    {item.key}
                  </Typography>
                  <EnvSourceBadge
                    item={item}
                    groupName={groups.find((group) => group.id === item.groupId)?.name}
                  />
                </Stack>

                <Typography variant="mono" color="subtle" as="span" truncate>
                  {revealed[item.id] ?? item.value}
                </Typography>

                {item.comment && (
                  <Typography variant="caption" color="subtle" clamp={1} className={styles.comment}>
                    {item.comment}
                  </Typography>
                )}
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                {item.isSecret && (
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={
                      <Icon name={revealed[item.id] !== undefined ? 'eyeOff' : 'eye'} size={24} />
                    }
                    aria-label={
                      revealed[item.id] !== undefined ? t('env.hideValue') : t('env.revealValue')
                    }
                    onClick={() => void reveal(item)}
                  />
                )}
                {/* Перенос общий ↔ локальный — только для переменных из файлов
                    настроек. Секреты (.mcp-secrets.env) и env групп не переносим. */}
                {(item.source === 'settings' || item.source === 'settings-local') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="swap" size={24} />}
                    aria-label={
                      item.source === 'settings-local'
                        ? t('env.moveToShared')
                        : t('env.moveToLocal')
                    }
                    disabled={moveVar.isPending}
                    onClick={() => moveVar.mutate(item)}
                  />
                )}
                {/* Переменную группы здесь не правят и не удаляют: сервер такой
                    черновик отвергает (400), а удалённую группа вернула бы при
                    следующем включении. Её место — карточка группы. */}
                {item.source !== 'group' && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Icon name="edit" size={24} />}
                      aria-label={`${t('common.edit')}: ${item.key}`}
                      onClick={() => openEdit(item)}
                    />
                    <DeleteButton
                      entityName={item.key}
                      description={t('env.deleteVar')}
                      onDelete={() => removeVar.mutate(item)}
                      isPending={removeVar.isPending}
                    />
                  </>
                )}
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Card>

      {!isLoading && vars.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      <EnvFormModal isOpen={isFormOpen} onOpenChange={closeForm} envVar={editing} />
    </Stack>
  );
}
