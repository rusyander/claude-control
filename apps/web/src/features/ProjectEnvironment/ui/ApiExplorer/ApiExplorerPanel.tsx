import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useApiExplorerInfo,
  useApiSend,
  useApiSpec,
  useRefreshApiExplorer,
  type ApiEndpoint,
  type ApiHistoryEntry,
} from '@entities/ApiExplorer';
import { EmptyState } from '@shared/ui/empty-state';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { apiErrorCode, apiErrorText } from '../../lib/apiError';
import {
  buildUrl,
  draftFromEndpoint,
  draftFromHistory,
  emptyDraft,
  headerPairs,
  historyMatchesEndpoint,
  type ApiDraft,
} from '../../lib/apiRequest';
import { baseSuggestions } from '../../lib/apiTargets';
import { issueText } from '../../lib/apiIssue';
import { ApiEndpointList } from './ApiEndpointList';
import { ApiExplorerSkeleton, ApiResponseSkeleton } from './ApiExplorerSkeleton';
import { ApiHistory } from './ApiHistory';
import { ApiRequestEditor } from './ApiRequestEditor';
import { ApiResponseView } from './ApiResponseView';
import { ApiSourceBar } from './ApiSourceBar';
import { ApiTargetBar } from './ApiTargetBar';
import type { ApiExplorerPanelProps } from './ApiExplorer.types';
import styles from './ApiExplorer.module.scss';

/**
 * Вкладка «API»: контракт проекта слева списком эндпоинтов, справа — запрос и
 * ответ со сверкой по схеме, внизу — история. Черновик запроса и выбранный
 * эндпоинт живут здесь: смена контракта сбрасывает выбор, а история может
 * заполнить черновик целиком.
 */
export function ApiExplorerPanel({ projectPath, isOpen, onAskAgent }: ApiExplorerPanelProps) {
  const { t } = useTranslation();
  const info = useApiExplorerInfo(projectPath, isOpen);
  const [chosenSource, setChosenSource] = useState<string>();
  const sources = info.data?.sources ?? [];
  const source = sources.find((item) => item.id === chosenSource) ?? sources[0];
  const spec = useApiSpec(projectPath, source?.id);
  const refresh = useRefreshApiExplorer(projectPath);
  const send = useApiSend(projectPath);
  const [endpointId, setEndpointId] = useState<string>();
  const [draft, setDraft] = useState<ApiDraft>(emptyDraft);
  const [baseInput, setBaseInput] = useState<string>();
  const [useAuth, setUseAuth] = useState(true);
  const [failure, setFailure] = useState<string>();

  if (info.isPending) return <ApiExplorerSkeleton />;
  if (info.isError) {
    if (apiErrorCode(info.error) === 'api-project-unregistered') {
      return (
        <EmptyState
          icon="plug"
          title={t('environment.api.notFoundTitle')}
          text={t('environment.api.errors.unregistered')}
        />
      );
    }
    return <LoadErrorCard onRetry={() => void info.refetch()} />;
  }

  const data = info.data;
  const endpoints = spec.data?.endpoints ?? [];
  const endpoint = endpoints.find((item) => item.id === endpointId);
  const suggestions = baseSuggestions(spec.data, data.services, data.envUrls);
  const baseUrl = baseInput ?? data.baseUrl ?? suggestions[0]?.url ?? '';

  const pickEndpoint = (next: ApiEndpoint): void => {
    setEndpointId(next.id);
    setDraft(draftFromEndpoint(next));
    setFailure(undefined);
    send.reset();
  };
  const pickFree = (): void => {
    setEndpointId(undefined);
    setDraft(emptyDraft());
    setFailure(undefined);
    send.reset();
  };
  const replay = (entry: ApiHistoryEntry): void => {
    // Эндпоинт из того же контракта — сверка снова сработает и поля пути
    // заполнены; иначе свободный запрос по полному адресу.
    const candidate =
      entry.sourceId === source?.id
        ? endpoints.find((item) => item.id === entry.endpointId)
        : undefined;
    const known = candidate && historyMatchesEndpoint(entry, candidate) ? candidate : undefined;
    setEndpointId(known?.id);
    setDraft(draftFromHistory(entry, known));
    setFailure(undefined);
    send.reset();
  };

  const doSend = (): void => {
    if (send.isPending) return;
    setFailure(undefined);
    const body = ['get', 'head'].includes(draft.method) || !draft.body ? undefined : draft.body;
    send.mutate(
      {
        method: draft.method,
        url: buildUrl(baseUrl, draft),
        headers: headerPairs(draft),
        ...(body !== undefined ? { body } : {}),
        ...(endpoint && source ? { sourceId: source.id, endpointId: endpoint.id } : {}),
        useAuth: Boolean(data.auth) && useAuth,
      },
      { onError: (error) => setFailure(apiErrorText(error, t)) },
    );
  };

  const sourceLabel = source?.label ?? '';
  const askContract =
    onAskAgent && source
      ? () => onAskAgent(t('environment.api.askAgent.contract', { source: sourceLabel }))
      : undefined;
  const result = send.data;
  const askMismatch =
    onAskAgent && result?.check?.verdict === 'mismatch' && endpoint
      ? () =>
          onAskAgent(
            t('environment.api.askAgent.mismatch', {
              endpoint: endpoint.id,
              status: result.status,
              source: sourceLabel,
              issues: (result.check?.issues ?? [])
                .map((issue) => `- ${issueText(issue, t)}`)
                .join('\n'),
            }),
          )
      : undefined;

  return (
    <div className={styles.block}>
      <div className={styles.card}>
        <ApiSourceBar
          projectPath={projectPath}
          info={data}
          {...(source ? { selected: source } : {})}
          {...(spec.data ? { spec: spec.data } : {})}
          onSelect={(id) => {
            setChosenSource(id);
            pickFree();
          }}
          onRefresh={() => refresh.mutate(source?.id)}
          isRefreshing={refresh.isPending}
          {...(askContract && spec.data ? { onAskContract: askContract } : {})}
        />
        {spec.isError && (
          <p className={styles.error} role="alert">
            {apiErrorText(spec.error, t)}
          </p>
        )}
      </div>
      <ApiTargetBar
        projectPath={projectPath}
        info={data}
        suggestions={suggestions}
        baseUrl={baseUrl}
        onBaseUrlChange={setBaseInput}
      />

      <div className={styles.workspace}>
        <ApiEndpointList
          endpoints={endpoints}
          isFree={!endpoint}
          onSelect={pickEndpoint}
          onFree={pickFree}
          {...(endpoint ? { selectedId: endpoint.id } : {})}
          {...(spec.isFetching && !spec.data ? { isLoading: true } : {})}
        />
        <div className={styles.main}>
          <ApiRequestEditor
            draft={draft}
            onDraftChange={setDraft}
            {...(endpoint ? { endpoint } : {})}
            baseUrl={baseUrl}
            {...(data.auth ? { authHeader: data.auth.header } : {})}
            useAuth={useAuth}
            onUseAuthChange={setUseAuth}
            onSend={doSend}
            isSending={send.isPending}
          />
          <div aria-live="polite" className={styles.resultArea}>
            {send.isPending && <ApiResponseSkeleton label={t('environment.api.request.sending')} />}
            {failure && (
              <p className={`${styles.card} ${styles.failure}`} role="alert">
                <Icon name="error" size={16} />
                <span>{failure}</span>
              </p>
            )}
            {!send.isPending && !failure && result && (
              <ApiResponseView
                result={result}
                {...(askMismatch ? { onAskMismatch: askMismatch } : {})}
              />
            )}
          </div>
        </div>
      </div>

      <ApiHistory projectPath={projectPath} isOpen={isOpen} onReplay={replay} />
    </div>
  );
}
