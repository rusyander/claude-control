import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CLIENT_LOG_LINES, useLogStream, type LogEntry } from '@entities/Logs';
import { Button } from '@shared/ui/button';
import { SkeletonList } from '@shared/ui/skeleton';
import { maskSecrets, snippetAround } from '../../lib/logPrompt';
import { logsErrorCode, logsErrorText } from '../../lib/logsError';
import { countLevels, filterRows, parseEntries } from '../../lib/logView';
import { LogToolbar } from './LogToolbar';
import { LogView } from './LogView';
import type { LogSourceViewProps } from './Logs.types';
import styles from './Logs.module.scss';

const promptLine = (entry: LogEntry): string =>
  entry.service ? `[${entry.service}] ${entry.text}` : entry.text;

/**
 * Один источник: поток строк, фильтр и выбранная строка. Монтируется заново
 * на каждый источник (ключ у родителя) — слежение, выбор и счётчик новых строк
 * относятся к одному потоку и переносить их на другой незачем. Поиск и
 * уровень живут у родителя: искать id запроса по очереди в нескольких
 * сервисах — обычное дело.
 */
export function LogSourceView({
  projectPath,
  isOpen,
  source,
  search,
  onSearchChange,
  level,
  onLevelChange,
  onSourceGone,
  onAskAgent,
}: LogSourceViewProps) {
  const { t } = useTranslation();
  const stream = useLogStream(projectPath, source.id, isOpen);
  const [follow, setFollow] = useState(true);
  const [selectedId, setSelectedId] = useState<number>();
  // Поиск по 5000 строкам — не на каждую букву: поле отвечает сразу, список догоняет.
  const query = useDeferredValue(search);
  const rows = useMemo(() => parseEntries(stream.lines), [stream.lines]);
  const visible = useMemo(() => filterRows(rows, { search: query, level }), [rows, query, level]);
  const counts = useMemo(() => countLevels(rows), [rows]);
  const sourceName = source.id === 'compose:*' ? t('environment.logs.sources.all') : source.label;

  const errorCode = stream.error ? logsErrorCode(stream.error) : undefined;
  useEffect(() => {
    if (errorCode === 'logs-source-unknown') onSourceGone();
  }, [errorCode, onSourceGone]);

  const ask = onAskAgent
    ? (entry: LogEntry) => {
        const lines = stream.lines.map(promptLine);
        const index = stream.lines.findIndex((item) => item.id === entry.id);
        const snippet = snippetAround(lines, Math.max(0, index));
        onAskAgent(
          t('environment.logs.askPrompt', {
            source: sourceName,
            line: maskSecrets(promptLine(entry)),
            count: snippet.to - snippet.from + 1,
            snippet: snippet.text,
          }),
        );
      }
    : undefined;

  const filtered = query.trim() !== '' || level !== undefined;

  return (
    <div className={styles.stream}>
      <LogToolbar
        search={search}
        onSearchChange={onSearchChange}
        shown={visible.length}
        total={rows.length}
        {...(level ? { level } : {})}
        onLevelChange={onLevelChange}
        counts={counts}
        follow={follow}
        onFollowChange={setFollow}
        onClear={() => {
          setSelectedId(undefined);
          stream.clear();
        }}
      />
      {stream.idle && (
        <p className={styles.notice} data-tone="info">
          {source.kind === 'run'
            ? t('environment.logs.view.idleRun')
            : t('environment.logs.view.idleCompose')}
        </p>
      )}
      {stream.truncated && (
        <p className={styles.notice} data-tone="info">
          {t('environment.logs.view.truncated', {
            count: Math.min(rows.length, CLIENT_LOG_LINES),
          })}
        </p>
      )}
      {stream.error !== undefined && errorCode !== 'logs-source-unknown' && (
        <p className={styles.notice} data-tone="danger" role="alert">
          {logsErrorText(stream.error, t)} {t('environment.logs.errors.retrying')}
        </p>
      )}
      {stream.isLoading && (
        <div className={styles.placeholder}>
          <SkeletonList rows={6} />
          <span className={styles.srOnly}>{t('environment.logs.view.loading')}</span>
        </div>
      )}
      {!stream.isLoading && visible.length === 0 && (
        <div className={styles.placeholder}>
          <p className={styles.sub}>
            {filtered && rows.length > 0
              ? t('environment.logs.view.emptyFiltered')
              : t('environment.logs.view.empty')}
          </p>
          {filtered && rows.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onSearchChange('');
                onLevelChange(undefined);
              }}
            >
              {t('environment.logs.view.resetFilter')}
            </Button>
          )}
        </div>
      )}
      {!stream.isLoading && visible.length > 0 && (
        <LogView
          label={t('environment.logs.view.label', { source: sourceName })}
          rows={visible}
          search={query}
          showService={source.id === 'compose:*'}
          follow={follow}
          onFollowChange={setFollow}
          {...(selectedId !== undefined ? { selectedId } : {})}
          onSelect={setSelectedId}
          {...(ask ? { onAsk: ask } : {})}
        />
      )}
    </div>
  );
}
