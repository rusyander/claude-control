import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { LoadErrorCard } from '@shared/ui/load-error';
import { useGroups, type GroupListItem } from '@entities/Group';
import { buildSections } from '../model/sections';
import { GroupTile } from '../GroupTile/GroupTile';
import { GroupsTabs } from '../GroupsTabs/GroupsTabs';
import { GroupsTabPanel } from '../GroupsTabPanel/GroupsTabPanel';
import { CoreGroupsSection, type CoreLaunchRequest } from '../CoreGroupsSection/CoreGroupsSection';
import { CoreImportDialog } from '../CoreImportDialog/CoreImportDialog';
import { launchInitialOf } from '../model/coreImport';
import styles from './GroupsPage.module.scss';
import { countOf } from '../lib/countOf';
import type { GroupCardModel } from '../model/sections.types';
import { cardOf } from '../model/cardOf';
import { GROUPS_PAGE } from '../model/tabs.constants';
import { GROUPS_TABS, type GroupsTabId } from '../model/tabs.types';

/**
 * Группы (этап 10, F1): сверху — группы ядра (сценарии библиотеки, запуск, прежние запуски), ниже —
 * прежние группы сеткой ТОЛЬКО ДЛЯ ЧТЕНИЯ на двух вкладках, глобальные и проектные. Прежний
 * исполнитель групп снят: ни создания, ни правки, ни тумблера, ни обнаружения — у карточки одно
 * действие «В ядро», перевод её «Пути» в сценарий ядра и запуск, который он открывает.
 */
export function GroupsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string; show?: string };
  // Вкладка — общим механизмом разделов: адрес главнее памяти, память — прежний
  // ключ `agentdeck.groups.tab`, так что запомненное у зрителя не теряется.
  const pageTab = usePageTab(GROUPS_PAGE, GROUPS_TABS);
  const [importing, setImporting] = useState<GroupListItem | undefined>(undefined);
  const [coreLaunch, setCoreLaunch] = useState<CoreLaunchRequest | undefined>(undefined);

  const groups = useGroups();
  const sections = buildSections(groups.data ?? []);
  // Агент ведёт к группе (`?show=<id>`): вкладка — по области группы, а не из
  // памяти зрителя; иначе карточка проектной группы стояла на скрытой вкладке.
  const shown = search.show ? cardOf(sections, search.show) : undefined;
  const tab = shown?.tab ?? pageTab.active;

  // Замена записи истории — «назад» уводит со страницы, а не по вкладкам.
  const selectTab = (next: GroupsTabId): void => {
    void navigate({ to: '.', search: { tab: next }, replace: true });
  };

  // Вкладка найдена — `?show=` уходит из адреса: дальше страница живёт своей
  // вкладкой, и F5 не перещёлкивал бы её снова. Группы нет в списке — тоже уходит.
  const showDone = Boolean(search.show) && (Boolean(shown) || groups.isSuccess);
  useEffect(() => {
    if (!showDone) return;
    selectTab(tab);
    // Только по завершению поиска: вкладка уже в том же кадре.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDone]);

  const renderCards = (cards: GroupCardModel[], emptyText: string) => {
    if (groups.isLoading) return <SkeletonList rows={3} />;
    if (groups.isError) return <LoadErrorCard onRetry={() => void groups.refetch()} />;
    if (cards.length === 0) {
      return (
        <Typography variant="body-sm" color="subtle">
          {emptyText}
        </Typography>
      );
    }
    return (
      <div className={styles.grid}>
        {cards.map((card) => (
          <GroupTile
            key={card.group.id}
            group={card.group}
            pair={card.pair}
            onCore={setImporting}
          />
        ))}
      </div>
    );
  };

  return (
    <Stack gap="var(--spacing-md)" className={styles.page}>
      <PageHeader title={t('groups.title')} subtitle={t('groups.subtitle')} helpTopic="groups" />

      <CoreGroupsSection launch={coreLaunch} onLaunch={setCoreLaunch} />

      {/* Прежние группы одним блоком: заголовок, вкладки и сетка — кадр справки снимает его целиком. */}
      <Stack gap="var(--spacing-md)" data-groups-legacy>
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="heading-sm" as="h2">
            {t('groupsPage.core.legacyHeading')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('groupsPage.core.legacyHint')}
          </Typography>
        </Stack>

        <GroupsTabs
          active={tab}
          onSelect={selectTab}
          counts={{
            global: { count: countOf(groups, sections.global.length) },
            project: { count: countOf(groups, sections.project.length) },
          }}
        />

        {tab === 'global' && (
          <GroupsTabPanel tab="global" hint={t('groupSources.sectionGlobalHint')}>
            {renderCards(sections.global, t('groupSources.emptyGlobal'))}
          </GroupsTabPanel>
        )}

        {tab === 'project' && (
          <GroupsTabPanel tab="project" hint={t('groupSources.sectionProjectHint')}>
            {renderCards(sections.project, t('groupSources.emptyProject'))}
          </GroupsTabPanel>
        )}
      </Stack>

      {importing && (
        <CoreImportDialog
          group={importing}
          onClose={() => setImporting(undefined)}
          onSaved={(ref) => {
            setImporting(undefined);
            setCoreLaunch({
              key: `${ref.id}@${ref.version}:${Date.now()}`,
              initial: launchInitialOf(importing, ref),
            });
          }}
        />
      )}
    </Stack>
  );
}
