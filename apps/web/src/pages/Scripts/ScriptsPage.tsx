import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useCreateParam } from '@shared/hooks/use-create-param';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { formatSize } from '@shared/lib/format';
import { ScriptFormModal } from '@features/ScriptEditor';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import { ResourceFileTree } from '@features/ResourceFiles';
import { useScripts, useDeleteScript, type ScriptFile } from '@entities/Script';
import { useIsCapabilityReady } from '@entities/Provider';
import { formatDate } from './ScriptsPage.lib';
import styles from './ScriptsPage.module.scss';

/**
 * Скрипты из каталога hooks/. Хуки на странице «Хуки» задают, когда скрипт
 * запускается; здесь правится сам код — включая файлы, которые пока ни к
 * какому событию не привязаны.
 *
 * Раздел работает при любом провайдере (COMMON-1): это файлы самой панели, а не
 * чужой конфиг. Claude-специфичны здесь ровно две вещи — песочница и отметка
 * «вызывается хуком»; они гейтятся по возможностям `sandbox` и `hooks`, поэтому
 * у Claude страница выглядит и работает ровно как раньше.
 */
export function ScriptsPage() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<ScriptFile | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);
  // Раскрытый скрипт показывает своё содержимое тем же деревом, что и скилл.
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const { data: scripts = [], isLoading } = useScripts();
  const removeScript = useDeleteScript();

  const hasHooks = useIsCapabilityReady('hooks');
  const hasSandbox = useIsCapabilityReady('sandbox');

  const openForm = (script?: ScriptFile): void => {
    setEditing(script);
    setIsFormOpen(true);
    writeUrl(script?.id);
  };

  // Ссылка /scripts?id=<имя файла> открывает этот скрипт в редакторе.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<ScriptFile>({ items: scripts, getId: (script) => script.id, onOpen: openForm });
  // Быстрое действие «Добавить» с обзора: /scripts?create=1 открывает форму создания.
  useCreateParam(() => openForm());

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('scripts.title')}
        subtitle={hasHooks ? t('scripts.subtitle') : t('scripts.subtitleNoHooks')}
        helpTopic="scripts"
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size={24} />}
            onClick={() => openForm()}
          >
            {t('scripts.addScript')}
          </Button>
        }
      />

      <ExplainBox
        title={t('scripts.explainTitle')}
        text={hasHooks ? t('scripts.explain') : t('scripts.explainNoHooks')}
      />

      {isLoading && <SkeletonList rows={5} />}

      <Card padding="none">
        <Stack>
          {scripts.map((script) => (
            <Stack
              key={script.id}
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-sm)"
              className={styles.row}
            >
              <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <button
                    type="button"
                    className={styles.nameToggle}
                    onClick={() =>
                      setExpanded((current) => (current === script.id ? undefined : script.id))
                    }
                  >
                    <Icon
                      name="chevronRight"
                      size={16}
                      className={expanded === script.id ? styles.chevronOpen : undefined}
                    />
                    <Typography variant="mono" weight="medium" as="span">
                      {script.name}
                    </Typography>
                  </button>
                  {/* «Используется» — про привязку к хуку; без хуков отметке
                      неоткуда взяться, поэтому у таких провайдеров её нет. */}
                  {hasHooks && (
                    <Badge tone={script.isUsed ? 'success' : 'neutral'}>
                      {script.isUsed ? t('scripts.used') : t('scripts.unused')}
                    </Badge>
                  )}
                </Stack>

                {script.description && (
                  <Typography
                    variant="caption"
                    color="subtle"
                    clamp={1}
                    className={styles.description}
                  >
                    {script.description}
                  </Typography>
                )}

                <Typography variant="caption" color="subtle" as="span">
                  {formatSize(script.sizeBytes)} · {formatDate(script.modifiedAt)}
                </Typography>

                {expanded === script.id && <ResourceFileTree kind="script" id={script.name} />}
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                {/* Песочница поднимает изолированный Claude Code — у других
                    провайдеров такой возможности нет, кнопку не показываем. */}
                {hasSandbox && (
                  <SandboxButton
                    kind="script"
                    title={script.name}
                    scriptName={script.name}
                    selection={{ scriptNames: [script.name] }}
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="edit" size={24} />}
                  aria-label={`${t('common.edit')}: ${script.name}`}
                  onClick={() => openForm(script)}
                />
                <DeleteButton
                  entityName={script.name}
                  description={
                    script.isUsed ? t('scripts.deleteUsedWarning') : t('scripts.deleteScript')
                  }
                  onDelete={() => removeScript.mutate(script.id)}
                  isPending={removeScript.isPending}
                />
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Card>

      {!isLoading && scripts.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      <ScriptFormModal isOpen={isFormOpen} onOpenChange={closeForm} script={editing} />
    </Stack>
  );
}
