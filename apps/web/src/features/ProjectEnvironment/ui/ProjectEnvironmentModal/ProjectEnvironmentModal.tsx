import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { PageTabPanel, PageTabs, type PageTabItem } from '@shared/ui/page-tabs';
import { ApiExplorerPanel } from '../ApiExplorer/ApiExplorerPanel';
import { BackendGuardPanel } from '../BackendGuard/BackendGuardPanel';
import { ComposeServices } from '../ComposeServices/ComposeServices';
import { DatabasePanel } from '../Database/DatabasePanel';
import { LogsPanel } from '../Logs/LogsPanel';
import type { ProjectEnvironmentModalProps } from './ProjectEnvironmentModal.types';
import styles from './ProjectEnvironmentModal.module.scss';

type EnvironmentTab = 'services' | 'logs' | 'database' | 'api' | 'guard';

/**
 * Окно «Окружение»: всё, что нужно бэкенду рядом с кодом. Одно окно с
 * вкладками, а не кнопка на каждую часть, — полоса проекта в шапке чата и так
 * плотная, а сервисы, база и API нужны вместе.
 */
export function ProjectEnvironmentModal({
  isOpen,
  onOpenChange,
  projectPath,
  onAskAgent,
  focusOnClose,
}: ProjectEnvironmentModalProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<EnvironmentTab>('services');
  const tabs: PageTabItem<EnvironmentTab>[] = [
    { id: 'services', label: t('environment.tabs.services'), icon: 'layers' },
    { id: 'logs', label: t('environment.tabs.logs'), icon: 'logs' },
    { id: 'database', label: t('environment.tabs.database'), icon: 'database' },
    { id: 'api', label: t('environment.tabs.api'), icon: 'plug' },
    { id: 'guard', label: t('environment.tabs.guard'), icon: 'lock' },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('environment.title')}
      description={t('environment.description')}
      size="full"
      {...(focusOnClose ? { focusOnClose } : {})}
    >
      <div className={styles.layout}>
        <PageTabs
          page="environment"
          label={t('environment.tabsLabel')}
          tabs={tabs}
          active={tab}
          onSelect={setTab}
        />
        {tab === 'services' && (
          <PageTabPanel page="environment" tab="services" hint={t('environment.tabs.servicesHint')}>
            <ComposeServices projectPath={projectPath} isOpen={isOpen} />
          </PageTabPanel>
        )}
        {tab === 'logs' && (
          <PageTabPanel page="environment" tab="logs" hint={t('environment.tabs.logsHint')}>
            <LogsPanel
              projectPath={projectPath}
              isOpen={isOpen}
              {...(onAskAgent ? { onAskAgent } : {})}
            />
          </PageTabPanel>
        )}
        {tab === 'database' && (
          <PageTabPanel page="environment" tab="database" hint={t('environment.tabs.databaseHint')}>
            <DatabasePanel
              projectPath={projectPath}
              isOpen={isOpen}
              onShowServices={() => setTab('services')}
            />
          </PageTabPanel>
        )}
        {tab === 'api' && (
          <PageTabPanel page="environment" tab="api" hint={t('environment.tabs.apiHint')}>
            <ApiExplorerPanel
              projectPath={projectPath}
              isOpen={isOpen}
              {...(onAskAgent ? { onAskAgent } : {})}
            />
          </PageTabPanel>
        )}
        {tab === 'guard' && (
          <PageTabPanel page="environment" tab="guard" hint={t('environment.tabs.guardHint')}>
            <BackendGuardPanel projectPath={projectPath} isOpen={isOpen} />
          </PageTabPanel>
        )}
      </div>
    </Modal>
  );
}
