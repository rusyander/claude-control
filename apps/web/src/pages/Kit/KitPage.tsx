import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { KitItem } from '@agentdeck/contracts/kit';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { Typography } from '@shared/ui/typography';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { saveDraft } from '@shared/lib/draft';
import { toast } from '@shared/lib/toast';
import { projectShortName, workspace } from '@shared/lib/workspace';
import { useKit } from '@entities/Kit';
import { KitModesCard } from '@features/KitModes';
import { KitItemRow } from './KitItemRow';
import { KitItemEditor } from './KitItemEditor';
import { KitGlobalOnly } from './KitGlobalOnly';
import { KIT_TABS, KIT_TAB_ICONS } from './model/tabs';
import { improvePrompt } from './model/improvePrompt';
import styles from './KitPage.module.scss';

/**
 * «Набор панели» (В2): что едет с приложением, кто это получает и правка
 * поверх встроенного. Вкладка — вид элементов; режим — на CLI, сверху.
 */
export function KitPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useKit();
  const { active, select } = usePageTab('kit', KIT_TABS);
  const [open, setOpen] = useState<KitItem | undefined>(undefined);

  /**
   * «Улучшить» — задание агенту, а не запись панели: текст кладётся в поле ввода
   * нового чата в папке копий «моё», отправляет человек.
   */
  const improve = (item: KitItem): void => {
    if (!data) return;
    const cwd = data.mineDir;
    const tabId = workspace.reveal(cwd, projectShortName(cwd));
    workspace.rememberView(tabId, undefined);
    saveDraft(
      `project:${tabId}`,
      improvePrompt({
        name: item.name,
        kind: item.kind,
        builtin: `${data.builtinDir}${item.id}`,
        mine: `${data.mineDir}/${item.id}`,
      }),
    );
    toast.success(t('kit.improveReady'));
    void navigate({ to: '/chat' } as never);
  };

  const items = data?.items.filter((item) => item.kind === active) ?? [];
  const tabs = KIT_TABS.map((id) => ({
    id,
    label: t(`kit.tabs.${id}`),
    icon: KIT_TAB_ICONS[id],
    count: data?.items.filter((item) => item.kind === id).length ?? 0,
  }));

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader title={t('kit.title')} subtitle={t('kit.subtitle')} helpTopic="kit" />
      {isLoading ? <SkeletonList /> : null}
      {isError ? <LoadErrorCard title={t('kit.loadError')} onRetry={() => void refetch()} /> : null}
      {data ? (
        <>
          <KitModesCard providers={data.providers} />
          <PageTabs
            page="kit"
            label={t('kit.tabs.label')}
            tabs={tabs}
            active={active}
            onSelect={select}
          />
          <PageTabPanel page="kit" tab={active} hint={t(`kit.tabs.hint.${active}`)}>
            {items.length ? (
              <ul className={styles.list}>
                {items.map((item) => (
                  <KitItemRow
                    key={item.id}
                    item={item}
                    globalDir={data.globalDir}
                    onOpen={setOpen}
                    onImprove={improve}
                  />
                ))}
              </ul>
            ) : (
              <Typography variant="body-sm" color="subtle">
                {t('kit.item.empty')}
              </Typography>
            )}
          </PageTabPanel>
          <KitGlobalOnly items={data.globalOnly.filter((item) => item.kind === active)} />
          {data.version ? (
            <Typography variant="caption" color="subtle">
              {t('kit.version', { version: data.version })}
            </Typography>
          ) : null}
          <KitItemEditor item={open} onClose={() => setOpen(undefined)} />
        </>
      ) : null}
    </Stack>
  );
}
