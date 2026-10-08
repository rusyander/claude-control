import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { scopeOf, type Group } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl } from '@shared/hooks/use-entity-url';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { LoadErrorCard } from '@shared/ui/load-error';
import { GroupFormModal, ScenarioCreateModal } from '@features/GroupEditor';
import { useGroupDiscovery, useGroups, useRunDiscovery, type GroupListItem } from '@entities/Group';
import { buildSections } from '../model/sections';
import { GroupTile } from '../GroupTile/GroupTile';
import { FoundTile } from '../FoundTile/FoundTile';
import { GroupDialog } from '../GroupDialog/GroupDialog';
import { FoundDialog } from '../FoundDialog/FoundDialog';
import { GroupsTabs } from '../GroupsTabs/GroupsTabs';
import { GroupsTabPanel } from '../GroupsTabPanel/GroupsTabPanel';
import { DiscoveryProgress } from '../DiscoveryProgress/DiscoveryProgress';
import { AdviceModal } from '../AdviceModal/AdviceModal';
import { CopyGroupDialog } from '../CopyGroupDialog/CopyGroupDialog';
import type { AdviceMode } from '../AdviceModal.types';
import { CreateGroupChooser } from '../CreateGroupChooser/CreateGroupChooser';
import { GroupsProviderNote } from '../GroupsProviderNote/GroupsProviderNote';
import type { CreateGroupKind } from '../CreateGroupChooser/CreateGroupChooser.types';
import styles from './GroupsPage.module.scss';
import type { OpenedItem } from './GroupsPage.types';
import { countOf } from '../lib/countOf';
import type { GroupCardModel } from '../model/sections.types';
import { cardOf } from '../model/cardOf';
import { GROUPS_PAGE } from '../model/tabs.constants';
import { GROUPS_TABS, type GroupsTabId } from '../model/tabs.types';

/**
 * Группы: четыре вкладки — глобальные, проектные, найденные и журнал
 * обнаружения; вкладка в адресе (`?tab=`) и помнится у зрителя. Карточки —
 * сеткой, щелчок открывает окно группы с «Порядком работы» и «Составом».
 * Связанная пара (глобальная копия проектной группы) — одна карточка и одно
 * окно с выбором стороны. «Создать группу» — один вход с выбором вида: сценарий
 * (одни шаги; после создания окно открывается на составлении первого шага) или
 * набор (участники вместе, работа по стадиям конвейера). Старый блок
 * «Автоматизации (хуки)» снят (владелец, I1): хук добавляется шагом «Хук», а
 * хуки settings.json видны и работают в разделе «Хуки».
 */
export function GroupsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string; id?: string; show?: string };
  // Вкладка — общим механизмом разделов: адрес главнее памяти, память — прежний
  // ключ `agentdeck.groups.tab`, так что запомненное у зрителя не теряется.
  const pageTab = usePageTab(GROUPS_PAGE, GROUPS_TABS);
  const [editingGroup, setEditingGroup] = useState<Group | undefined>(undefined);
  const [isGroupFormOpen, setIsGroupFormOpen] = useState(false);
  const [isScenarioOpen, setIsScenarioOpen] = useState(false);
  const [isChooserOpen, setIsChooserOpen] = useState(false);
  const [advice, setAdvice] = useState<{ mode: AdviceMode; group: GroupListItem } | undefined>(
    undefined,
  );
  // Открытое окно: группа по id, находка по ключу. Держим ключ, а не запись —
  // окно показывает свежие данные списка, а удалённая группа закрывает его сама.
  const [opened, setOpened] = useState<OpenedItem | undefined>(undefined);
  const [copying, setCopying] = useState<GroupListItem | undefined>(undefined);

  const groups = useGroups();
  const discovery = useGroupDiscovery();
  const runDiscovery = useRunDiscovery();
  const sections = buildSections(groups.data ?? [], discovery.data);
  const isDiscovering = Boolean(discovery.data?.running) || runDiscovery.isPending;
  const sources = discovery.data?.sources ?? [];
  // Агент ведёт к группе (`?show=<id>`): вкладка — по области группы, а не из
  // памяти зрителя; иначе карточка проектной группы стояла на скрытой вкладке.
  const shown = search.show ? cardOf(sections, search.show) : undefined;
  const tab = shown?.tab ?? pageTab.active;

  // Адрес несёт и вкладку, и открытую в редакторе группу: запись одного не
  // должна стирать другое. Замена записи истории — «назад» уводит со страницы.
  const writeSearch = (next: { tab: GroupsTabId; id?: string }): void => {
    void navigate({ to: '.', search: next.id ? next : { tab: next.tab }, replace: true });
  };
  // Память вкладки пишет `usePageTab`, когда адрес сменился.
  const selectTab = (next: GroupsTabId): void => writeSearch({ tab: next, id: search.id });

  // Вкладка найдена — `?show=` уходит из адреса: дальше страница живёт своей
  // вкладкой, и F5 не перещёлкивал бы её снова. Группы нет в списке — тоже уходит.
  const showDone = Boolean(search.show) && (Boolean(shown) || groups.isSuccess);
  useEffect(() => {
    if (!showDone) return;
    writeSearch({ tab, id: search.id });
    // Только по завершению поиска: вкладка и id уже в том же кадре.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDone]);

  const openCreateGroup = (): void => {
    setEditingGroup(undefined);
    setIsGroupFormOpen(true);
  };

  // Один вход «Создать группу»: вид выбирают в окне выбора, дальше — форма вида.
  const pickKind = (kind: CreateGroupKind): void => {
    setIsChooserOpen(false);
    if (kind === 'scenario') setIsScenarioOpen(true);
    else openCreateGroup();
  };

  const openEditGroup = (group: Group): void => {
    setEditingGroup(group);
    setIsGroupFormOpen(true);
    writeSearch({ tab, id: group.id });
  };

  // Ссылка /groups?id=<uuid> открывает эту группу в редакторе.
  useEntityUrl<Group>({
    items: groups.data ?? [],
    getId: (group) => group.id,
    onOpen: openEditGroup,
  });

  const closeGroupForm = (open: boolean): void => {
    setIsGroupFormOpen(open);
    if (!open) writeSearch({ tab });
  };

  const openCreatedScenario = (group: Group): void => {
    const home: GroupsTabId = scopeOf(group).kind === 'project' ? 'project' : 'global';
    writeSearch({ tab: home });
    setOpened({ kind: 'group', id: group.id, isFresh: true });
  };

  // Копия легла выключенной — открываем её окно на её вкладке: дальше её правят.
  const openCopied = (copy: Group): void => {
    const home: GroupsTabId = scopeOf(copy).kind === 'project' ? 'project' : 'global';
    writeSearch({ tab: home });
    setCopying(undefined);
    setOpened({ kind: 'group', id: copy.id });
  };

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
            onOpen={() => setOpened({ kind: 'group', id: card.group.id })}
            onCopy={() => setCopying(card.group)}
          />
        ))}
      </div>
    );
  };

  // Окно ищет карточку и по проектной половине пары: после «Скопировать в
  // общие» открытая проектная группа становится парой глобальной копии, и поиск
  // по одному id карточки молча закрывал окно под окном советов.
  const openedAt = opened?.kind === 'group' ? cardOf(sections, opened.id) : undefined;
  const openedCard = openedAt
    ? [...sections.global, ...sections.project].find((card) => card.group.id === openedAt.cardId)
    : undefined;
  // Карточка открытого окна переехала на другую вкладку (копия в общие) —
  // страница под окном идёт за ней: закрыв окно, человек видит свою группу.
  const openedTab = openedAt?.tab;
  useEffect(() => {
    if (openedTab && openedTab !== tab) writeSearch({ tab: openedTab, id: search.id });
    // Только на переезд карточки: под открытым окном вкладки человек не переключает.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedTab]);
  const openedFound =
    opened?.kind === 'found'
      ? sections.discovered.find((found) => found.key === opened.id)
      : undefined;

  const hasNoGroupsAtAll = !groups.isLoading && !groups.isError && (groups.data ?? []).length === 0;
  const isBlank = hasNoGroupsAtAll && sections.discovered.length === 0;

  return (
    <Stack gap="var(--spacing-md)" className={styles.page}>
      <PageHeader
        title={t('groups.title')}
        subtitle={t('groups.subtitle')}
        helpTopic="groups"
        actions={
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              leftIcon={<Icon name="search" size={20} />}
              isLoading={isDiscovering}
              disabled={isDiscovering}
              title={t('groupSources.discoverHint')}
              onClick={() => runDiscovery.mutate()}
            >
              {isDiscovering ? t('groupSources.discovering') : t('groupSources.discover')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={20} />}
              onClick={() => setIsChooserOpen(true)}
            >
              {t('groupsPage.create.button')}
            </Button>
          </Stack>
        }
      />

      <ExplainBox title={t('groups.explainTitle')} text={t('groups.explain')} />
      <GroupsProviderNote />

      <GroupsTabs
        active={tab}
        onSelect={selectTab}
        counts={{
          global: { count: countOf(groups, sections.global.length) },
          project: { count: countOf(groups, sections.project.length) },
          found: { count: countOf(discovery, sections.discovered.length) },
          discovery: {
            count: countOf(discovery, sources.length),
            errors: sources.filter((source) => source.state === 'failed').length,
          },
        }}
      />

      {tab === 'global' && (
        <GroupsTabPanel tab="global" hint={t('groupSources.sectionGlobalHint')}>
          {isBlank ? (
            <EmptyState
              icon="groups"
              title={t('groups.emptyTitle')}
              text={t('groups.emptyText')}
              action={
                <Button
                  variant="primary"
                  leftIcon={<Icon name="plus" size={20} />}
                  onClick={() => setIsChooserOpen(true)}
                >
                  {t('groupsPage.create.button')}
                </Button>
              }
            />
          ) : (
            renderCards(sections.global, t('groupSources.emptyGlobal'))
          )}
        </GroupsTabPanel>
      )}

      {tab === 'project' && (
        <GroupsTabPanel tab="project" hint={t('groupSources.sectionProjectHint')}>
          {renderCards(sections.project, t('groupSources.emptyProject'))}
        </GroupsTabPanel>
      )}

      {tab === 'found' && (
        <GroupsTabPanel tab="found" hint={t('groupSources.sectionFoundHint')}>
          {discovery.isLoading && <SkeletonList rows={2} />}
          {discovery.isError && (
            <LoadErrorCard
              title={t('groupSources.discoveryError')}
              onRetry={() => void discovery.refetch()}
            />
          )}
          {discovery.data && sections.discovered.length === 0 && (
            <Typography variant="body-sm" color="subtle">
              {t('groupSources.emptyFound')}
            </Typography>
          )}
          {sections.discovered.length > 0 && (
            <div className={styles.grid}>
              {sections.discovered.map((found) => (
                <FoundTile
                  key={found.key}
                  found={found}
                  onOpen={() => setOpened({ kind: 'found', id: found.key })}
                />
              ))}
            </div>
          )}
        </GroupsTabPanel>
      )}

      {tab === 'discovery' && (
        <GroupsTabPanel tab="discovery" hint={t('groupsPage.discovery.hint')}>
          {discovery.isLoading && <SkeletonList rows={2} />}
          {discovery.isError && (
            <LoadErrorCard
              title={t('groupSources.discoveryError')}
              onRetry={() => void discovery.refetch()}
            />
          )}
          {discovery.data && <DiscoveryProgress view={discovery.data} />}
        </GroupsTabPanel>
      )}

      {openedCard && (
        <GroupDialog
          // Своё окно на каждую группу: состояние пути (составитель, удаление,
          // открытый шаг) не переезжает к другой группе. Ключ — то, что открыл
          // человек, а не карточка: копия в общие делает группу парой с новой
          // карточкой, и окно с итогом копии не должно при этом пересоздаваться.
          key={opened?.id}
          group={openedCard.group}
          pair={openedCard.pair}
          startComposer={opened?.isFresh}
          onClose={() => setOpened(undefined)}
          onEdit={openEditGroup}
          onAdvice={(mode, group) => setAdvice({ mode, group })}
          onCopy={setCopying}
        />
      )}
      {openedFound && <FoundDialog found={openedFound} onClose={() => setOpened(undefined)} />}

      <GroupFormModal isOpen={isGroupFormOpen} onOpenChange={closeGroupForm} group={editingGroup} />
      <CreateGroupChooser
        isOpen={isChooserOpen}
        onOpenChange={setIsChooserOpen}
        onPick={pickKind}
      />
      <ScenarioCreateModal
        isOpen={isScenarioOpen}
        onOpenChange={setIsScenarioOpen}
        onCreated={openCreatedScenario}
      />
      {copying && (
        <CopyGroupDialog
          group={copying}
          takenNames={(groups.data ?? []).map((group) => group.name)}
          onClose={() => setCopying(undefined)}
          onCopied={openCopied}
        />
      )}
      {advice && (
        <AdviceModal mode={advice.mode} group={advice.group} onClose={() => setAdvice(undefined)} />
      )}
    </Stack>
  );
}
