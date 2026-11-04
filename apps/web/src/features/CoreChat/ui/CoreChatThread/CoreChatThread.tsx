import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { ChatItem, ChatToolItem } from '../../model/coreChat.types';
import type { CoreChatThreadProps } from './CoreChatThread.types';
import styles from './CoreChatThread.module.scss';

/** Короткая подпись входа инструмента: путь/команда, если есть, иначе JSON в одну строку. */
function toolLine(tool: ChatToolItem): string {
  const input = tool.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
      if (typeof o[key] === 'string') return o[key];
    }
  }
  const raw = JSON.stringify(input ?? null);
  return raw.length > 160 ? `${raw.slice(0, 159)}…` : raw;
}

/** Вызов без результата ещё идёт; результат с ошибкой — провал. */
function toolState(tool: ChatToolItem): 'running' | 'done' | 'failed' {
  if (tool.result === null) return 'running';
  return tool.result.isError ? 'failed' : 'done';
}

function ToolRow({ tool }: { tool: ChatToolItem }) {
  const { t } = useTranslation();
  const state = toolState(tool);
  const label = {
    running: t('coreChat.thread.toolRunning'),
    done: t('coreChat.thread.toolDone'),
    failed: t('coreChat.thread.toolFailed'),
  }[state];
  const tone = ({ running: 'muted', done: 'success', failed: 'danger' } as const)[state];
  return (
    <div className={styles.tool} data-core-chat-tool={tool.name} data-tool-state={state}>
      <Typography variant="caption" color="muted" as="span">
        {t('coreChat.thread.tool')}
      </Typography>
      <Typography variant="mono" as="span" weight="medium">
        {tool.name}
      </Typography>
      <Typography variant="mono" color="muted" as="span" truncate>
        {toolLine(tool)}
      </Typography>
      <Typography variant="caption" as="span" color={tone}>
        {label}
      </Typography>
    </div>
  );
}

function Row({ item }: { item: ChatItem }) {
  const { t } = useTranslation();
  switch (item.kind) {
    case 'human':
      return (
        <div className={`${styles.bubble} ${styles.human}`} data-core-chat-human>
          <Typography variant="caption" color="muted" as="span">
            {t('coreChat.thread.you')}
          </Typography>
          <Typography as="p" className={styles.text}>
            {item.text}
          </Typography>
        </div>
      );
    case 'assistant':
      return (
        <div className={`${styles.bubble} ${styles.model}`} data-core-chat-assistant>
          <Typography variant="caption" color="muted" as="span">
            {t('coreChat.thread.model')}
          </Typography>
          <Typography as="p" className={styles.text}>
            {item.text}
          </Typography>
        </div>
      );
    case 'tool':
      return <ToolRow tool={item.tool} />;
    case 'permission':
      return (
        <div className={styles.note} data-core-chat-permission>
          <Typography variant="caption" color="warning" as="span">
            {t('coreChat.thread.permission')}
          </Typography>
          <Typography variant="mono" as="span" truncate>
            {JSON.stringify(item.data)}
          </Typography>
        </div>
      );
    case 'error':
      return (
        <div className={styles.note} data-core-chat-error>
          <Typography variant="caption" color="danger" as="span">
            {t('coreChat.thread.error')}
          </Typography>
          <Typography variant="mono" as="span">
            {item.text}
          </Typography>
        </div>
      );
    case 'turn-end':
      return item.isError ? (
        <div className={styles.note} data-core-chat-turn-failed>
          <Typography variant="caption" color="danger" as="span">
            {t('coreChat.thread.turnFailed')}
          </Typography>
        </div>
      ) : null;
    default:
      return null;
  }
}

/** Лента разговора; новые строки докручиваются вниз. */
export function CoreChatThread({ items, pending }: CoreChatThreadProps) {
  const { t } = useTranslation();
  const end = useRef<HTMLDivElement>(null);
  const count = items.length + pending.length;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [count]);
  return (
    <div className={styles.thread} data-core-chat-thread>
      {count === 0 && (
        <Typography color="muted" data-core-chat-empty>
          {t('coreChat.thread.empty')}
        </Typography>
      )}
      {items.map((item) => (
        <Row key={item.key} item={item} />
      ))}
      {pending.map((text, i) => (
        <div
          key={`pending-${i}`}
          className={`${styles.bubble} ${styles.human} ${styles.pending}`}
          data-core-chat-pending
        >
          <Typography variant="caption" color="muted" as="span">
            {t('coreChat.thread.you')} · {t('coreChat.thread.sending')}
          </Typography>
          <Typography as="p" className={styles.text}>
            {text}
          </Typography>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
