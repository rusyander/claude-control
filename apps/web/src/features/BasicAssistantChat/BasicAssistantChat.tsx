import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantRunResult } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { useProviderRunner } from '@entities/ProviderKeys';
import { useRunAssistant } from '@entities/Assistant';
import styles from './BasicAssistantChat.module.scss';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Basic-чат мультимодельного ассистента (Ф6b) для НЕ-claude провайдеров.
 *
 * Claude сюда не попадает — у него отдельный богатый стриминговый чат (регресс-
 * ноль). Здесь простой текст: история сообщений уходит на `/api/assistant/run`,
 * сервер по switch запускает CLI провайдера (one-shot) или его модельный API и
 * возвращает ответ. Режим CLI помечается «экспериментально» (не stream-json).
 *
 * При режиме `none` (нет подписки/CLI и нет ключа) модалка `AssistantKeyGate`
 * покажет инструкцию: сперва вход в CLI провайдера (подписка), затем API-ключ.
 *
 * IDEA-8: наружу уходит ещё и `conversationId` — устойчивый id ЭТОГО диалога.
 * Он включает сессионный режим у тех CLI, кто его заявил (сейчас OpenCode с
 * `opencode serve`): контекст держит сам CLI, панель шлёт только новое сообщение.
 * Провайдеры без сессии его просто игнорируют — история по-прежнему уезжает
 * одним промптом. Что сработало на самом деле, видно по метке в шапке.
 */
export function BasicAssistantChat() {
  const { t } = useTranslation();
  const { data: runner } = useProviderRunner();
  const run = useRunAssistant();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [transport, setTransport] = useState<AssistantRunResult['transport']>();
  const listRef = useRef<HTMLDivElement>(null);

  // Id живёт столько же, сколько смонтированный чат: перезагрузили страницу —
  // начали новый диалог, и сессия CLI начинается заново. Придумывать ему
  // «вечное» хранилище нельзя: на той стороне сессия умирает вместе с сервером.
  const conversationId = useMemo(
    () => `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const providerName = runner?.providerName ?? '';
  const isNone = runner?.mode === 'none';

  const scrollDown = (): void => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  };

  const send = (): void => {
    const prompt = input.trim();
    if (!prompt || run.isPending || isNone) return;

    const history: ChatTurn[] = [...turns, { role: 'user', content: prompt }];
    setTurns(history);
    setInput('');
    scrollDown();

    run.mutate(
      { messages: history, conversationId },
      {
        onSuccess: (result: AssistantRunResult) => {
          if (result.ok) {
            setTurns((prev) => [...prev, { role: 'assistant', content: result.reply }]);
            setTransport(result.transport);
          } else {
            toast.error(
              result.error ?? t(`basicChat.reason.${result.reason}`, t('basicChat.failed')),
            );
          }
          scrollDown();
        },
        onError: () => toast.error(t('basicChat.failed')),
      },
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className={styles.shell}>
      <Stack
        direction="row"
        align="center"
        justify="between"
        gap="var(--spacing-sm)"
        wrap
        padding="var(--spacing-sm) var(--spacing-xl)"
        className={styles.header}
      >
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium">
            {t('basicChat.title', { provider: providerName })}
          </Typography>
          <Badge tone="warning" withDot>
            {t('basicChat.experimental')}
          </Badge>
          {runner && runner.mode !== 'none' && (
            <Badge tone="neutral">{t(`basicChat.mode.${runner.mode}`)}</Badge>
          )}
          {transport && <Badge tone="neutral">{t(`basicChat.transport.${transport}`)}</Badge>}
        </Stack>
      </Stack>

      <Typography variant="caption" color="subtle" className={styles.disclaimer}>
        {t('basicChat.experimentalHint')}
      </Typography>

      <div className={styles.list} ref={listRef}>
        {turns.length === 0 ? (
          <Stack
            align="center"
            justify="center"
            flex={1}
            gap="var(--spacing-sm)"
            className={styles.empty}
          >
            <Icon name="chat" size={40} />
            <Typography variant="heading-sm">
              {t('basicChat.title', { provider: providerName })}
            </Typography>
            <Typography color="muted" className={styles.emptyText}>
              {isNone ? t('basicChat.noneHint') : t('basicChat.empty')}
            </Typography>
          </Stack>
        ) : (
          <Stack gap="var(--spacing-sm)" padding="var(--spacing-md) var(--spacing-xl)">
            {turns.map((turn, index) => (
              <Stack
                key={index}
                gap="var(--spacing-3xs)"
                className={turn.role === 'user' ? styles.userTurn : styles.assistantTurn}
              >
                <Typography variant="caption" color="subtle" as="span">
                  {turn.role === 'user' ? t('basicChat.you') : providerName}
                </Typography>
                <Typography className={styles.turnText}>{turn.content}</Typography>
              </Stack>
            ))}
            {run.isPending && (
              <Typography variant="body-sm" color="subtle">
                {t('basicChat.thinking')}
              </Typography>
            )}
          </Stack>
        )}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.textarea}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('basicChat.placeholder')}
          rows={2}
          disabled={isNone}
        />
        <Button
          variant="primary"
          onClick={send}
          isLoading={run.isPending}
          disabled={!input.trim() || isNone}
          leftIcon={<Icon name="send" size={18} />}
        >
          {t('basicChat.send')}
        </Button>
      </div>
    </div>
  );
}
