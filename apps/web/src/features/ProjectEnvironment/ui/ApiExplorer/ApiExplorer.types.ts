import type {
  ApiEndpoint,
  ApiExplorerInfo,
  ApiHistoryEntry,
  ApiSendResult,
  ApiSource,
  ApiSpec,
} from '@entities/ApiExplorer';
import type { ApiDraft, KeyValueRow } from '../../lib/apiRequest';
import type { BaseSuggestion } from '../../lib/apiTargets';

export interface ApiExplorerPanelProps {
  projectPath: string;
  isOpen: boolean;
  /** Положить просьбу агенту в поле чата и закрыть окно. Нет — кнопки «спросить агента» нет. */
  onAskAgent?: (text: string) => void;
}

export interface ApiSourceBarProps {
  projectPath: string;
  info: ApiExplorerInfo;
  selected?: ApiSource;
  spec?: ApiSpec;
  onSelect: (sourceId: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onAskContract?: () => void;
}

export interface ApiTargetBarProps {
  projectPath: string;
  info: ApiExplorerInfo;
  /** Подсказки базового адреса с происхождением, от вероятной к запасной. */
  suggestions: BaseSuggestion[];
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
}

export interface ApiEndpointListProps {
  endpoints: ApiEndpoint[];
  selectedId?: string;
  isFree: boolean;
  /** Контракт ещё читается. */
  isLoading?: boolean;
  onSelect: (endpoint: ApiEndpoint) => void;
  onFree: () => void;
}

export interface ApiRequestEditorProps {
  draft: ApiDraft;
  onDraftChange: (draft: ApiDraft) => void;
  endpoint?: ApiEndpoint;
  baseUrl: string;
  authHeader?: string;
  useAuth: boolean;
  onUseAuthChange: (value: boolean) => void;
  onSend: () => void;
  isSending: boolean;
}

export interface KeyValueRowsProps {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
}

export interface ApiResponseViewProps {
  result: ApiSendResult;
  onAskMismatch?: () => void;
}

export interface ApiHistoryProps {
  projectPath: string;
  isOpen: boolean;
  onReplay: (entry: ApiHistoryEntry) => void;
}
