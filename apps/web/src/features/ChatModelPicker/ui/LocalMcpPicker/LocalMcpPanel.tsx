import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { LocalMcpInfo, LocalMcpServer } from '@agentdeck/contracts/local-models';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { formatTokens } from '@shared/lib/formatTokens';
import { localMcpRows, localMcpTight } from '../../model/localMcpRows';
import styles from './LocalMcpPicker.module.scss';

interface LocalMcpPanelProps {
  /** Нет ответа сервера: список ещё грузится или не прочитался. */
  data: LocalMcpInfo | undefined;
  loadFailed: boolean;
  /** Идёт сохранение выбора — флажки на это время заперты. */
  saving: boolean;
  measuring: boolean;
  onToggle: (id: string, on: boolean) => void;
  onRemeasure: (ids: string[]) => void;
}

/** Подпись цены сервера: замер, оценка по схемам, сбой или ожидание замера. */
function costLabel(server: LocalMcpServer, measuring: boolean, t: TFunction): string {
  if (server.tokens !== null) {
    const key = server.source === 'estimate' ? 'chat.localMcp.costEstimate' : 'chat.localMcp.cost';
    return t(key, { tokens: formatTokens(server.tokens), tools: server.tools ?? 0 });
  }
  if (server.error) return t('chat.localMcp.failed');
  return t(measuring ? 'chat.localMcp.measuring' : 'chat.localMcp.unmeasured');
}

/** Раскрытый список MCP-серверов: цена каждого, флажки, остаток окна. Чистое представление — данные и действия приходят снаружи. */
export function LocalMcpPanel({
  data,
  loadFailed,
  saving,
  measuring,
  onToggle,
  onRemeasure,
}: LocalMcpPanelProps) {
  const { t } = useTranslation();
  const rows = data ? localMcpRows(data) : [];
  const failed = data?.servers.filter((server) => server.error) ?? [];

  return (
    <div className={styles.panel} role="group" aria-label={t('chat.localMcp.title')}>
      <Typography variant="caption" color="muted">
        {t('chat.localMcp.what')}
      </Typography>

      {loadFailed && (
        <Typography variant="caption" color="warning" role="alert">
          {t('chat.localMcp.loadError')}
        </Typography>
      )}

      {data && rows.length === 0 && (
        <Typography variant="caption" color="muted">
          {t('chat.localMcp.empty')}
        </Typography>
      )}

      {data && rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map(({ server, canPick }) => (
            <li key={server.id} className={styles.row}>
              <label
                title={
                  canPick
                    ? undefined
                    : t(server.tokens === null ? 'chat.localMcp.noCost' : 'chat.localMcp.noRoom')
                }
              >
                <input
                  type="checkbox"
                  checked={server.picked}
                  disabled={!canPick || saving}
                  onChange={(event) => onToggle(server.id, event.target.checked)}
                />
                <span>{server.id}</span>
              </label>
              <span className={styles.cost}>{costLabel(server, measuring, t)}</span>
            </li>
          ))}
        </ul>
      )}

      {data && (
        <Typography
          variant="caption"
          color={localMcpTight(data) ? 'warning' : 'muted'}
          role="status"
          aria-live="polite"
        >
          {t(data.headroom < 0 ? 'chat.localMcp.overflow' : 'chat.localMcp.headroom', {
            headroom: formatTokens(Math.abs(data.headroom)),
            context: formatTokens(data.context),
          })}
        </Typography>
      )}

      {failed.length > 0 && (
        <Typography variant="caption" color="muted">
          {failed.map((server) => `${server.id}: ${server.error ?? ''}`).join(' · ')}
        </Typography>
      )}

      {data && data.servers.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          isLoading={measuring}
          onClick={() => onRemeasure(data.servers.map((server) => server.id))}
        >
          {t('chat.localMcp.remeasure')}
        </Button>
      )}
    </div>
  );
}
