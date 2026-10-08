import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { Typography } from '@shared/ui/typography';
import {
  ImageAttachButton,
  ImageAttachTray,
  ImageAttachZone,
  useImageAttach,
} from '@shared/ui/image-attach';
import { usePanelAgentConversations } from '@entities/PanelAgent';
import { actionTitle } from '../../model/actionTitle';
import { splitPending } from '../../model/conversation';
import { PendingActionCard } from '../PendingActionCard/PendingActionCard';
import { VoiceControl } from '../VoiceControl/VoiceControl';
import type { ConversationViewProps } from '../ConversationView.types';
import styles from './ConversationView.module.scss';
import { noteReturnedFocus } from '../../model/focusAnchor';
import { appendDictation } from '../../model/appendDictation';
import type { VoiceView } from '../../model/voiceInput.types';
import { isDictating } from '../../model/isDictating';
import { UserText } from './UserText/UserText';

/**
 * Разговор: лента реплик и шагов, ждущие карточки под ней и поле ввода.
 * Карточки стоят в самом низу, над полем: именно там взгляд человека после
 * отправки, и агент всё равно стоит, пока по ним нет решения.
 */
export function ConversationView({
  session,
  pending,
  deciding,
  decideErrors,
  approveRefused,
  onDecide,
  pageLabel,
  projectLabel,
  onSend,
  onOpenConversation,
}: ConversationViewProps) {
  const { t, i18n } = useTranslation();
  const [input, setInput] = useState('');
  const [voice, setVoice] = useState<VoiceView>('idle');
  // Пока идёт диктовка, распознанное ещё не в поле: отправка сейчас ушла бы без него.
  const dictating = isDictating(voice);
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Фокус стоял в карточке: кадр итога снимает её вместе с кнопкой, и фокус
  // падает на тело страницы — с клавиатуры человек выпал бы из окна.
  const cardHadFocusRef = useRef(false);
  const { state } = session;
  // Картинки уходят с репликой блоками в самом запросе: у агента панели нет
  // файловой системы, путь к файлу ему бесполезен.
  const attach = useImageAttach({ disabled: state.running });
  // Список ожиданий у панели общий: карточки других разговоров идут отдельно и
  // помечены, иначе их отклоняли из нового разговора, приняв за свои.
  const { own, foreign } = splitPending(pending, session.isOwn);
  const { data: conversations } = usePanelAgentConversations(foreign.length > 0);
  const titleOf = (id?: string): string | undefined =>
    conversations?.find((item) => item.id === id)?.title;

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [state.feed.length, pending.length]);

  useEffect(() => {
    if (!cardHadFocusRef.current || document.activeElement !== document.body) return;
    cardHadFocusRef.current = false;
    inputRef.current?.focus();
    noteReturnedFocus(inputRef.current);
  }, [pending]);

  const send = (): void => {
    const text = input.trim();
    if (!text || state.running || dictating || attach.isPreparing) return;
    setInput('');
    onSend(text, attach.images);
    attach.clear();
  };

  return (
    <>
      <div className={styles.context}>
        <Badge tone="neutral">{t('panelAgent.context', { page: pageLabel })}</Badge>
        {projectLabel && (
          <Badge tone="neutral">{t('panelAgent.contextProject', { project: projectLabel })}</Badge>
        )}
      </div>

      <div
        className={styles.scroll}
        ref={feedRef}
        data-agent-feed
        onFocusCapture={(event) => {
          cardHadFocusRef.current = Boolean(
            (event.target as Element).closest('[data-agent-pending]'),
          );
        }}
      >
        {state.feed.length === 0 && own.length === 0 && (
          <Typography variant="body-sm" color="subtle">
            {t('panelAgent.emptyConversation')}
          </Typography>
        )}

        {state.feed.map((item) => {
          if (item.kind === 'user' || item.kind === 'assistant') {
            return (
              <div
                key={item.id}
                className={[
                  styles.message,
                  item.kind === 'user' ? styles.user : styles.assistant,
                ].join(' ')}
                data-agent-message={item.kind}
              >
                {item.kind === 'user' ? (
                  <UserText text={item.text} />
                ) : (
                  <div
                    className={styles.markdown}
                    // Модель отвечает разметкой (**имя**, `ключ`, списки) — без разбора
                    // звёздочки стояли в тексте. markdown-it с выключенным сырым html.
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
                  />
                )}
              </div>
            );
          }
          if (item.kind === 'tool' || item.kind === 'tool-error') {
            return (
              <div key={item.id} className={styles.step}>
                <Icon name={item.kind === 'tool' ? 'commands' : 'warning'} size={16} />
                <Typography variant="caption" color={item.kind === 'tool' ? 'muted' : 'danger'}>
                  {t(item.kind === 'tool' ? 'panelAgent.toolCalled' : 'panelAgent.toolFailed', {
                    name: actionTitle(item.text, t, (key) => i18n.exists(key)),
                  })}
                </Typography>
              </div>
            );
          }
          return (
            <Typography
              key={item.id}
              variant="caption"
              color={item.kind === 'error' ? 'danger' : 'muted'}
              role={item.kind === 'error' ? 'alert' : undefined}
              data-agent-notice={item.kind}
            >
              {item.text}
            </Typography>
          );
        })}

        {state.running && (
          <Typography variant="caption" color="muted" role="status">
            {t('panelAgent.thinking')}
          </Typography>
        )}

        {own.map((item, index) => (
          <PendingActionCard
            key={item.id}
            pending={item}
            isDeciding={deciding.has(item.id)}
            error={decideErrors[item.id]}
            approveRefused={approveRefused.has(item.id)}
            onDecide={(decision) => onDecide(item.id, decision)}
            autoFocus={index === 0}
          />
        ))}

        {foreign.length > 0 && (
          <section className={styles.foreignGroup} aria-label={t('panelAgent.foreign.title')}>
            <Typography variant="body-sm" weight="semibold" as="h3">
              {t('panelAgent.foreign.title')}
            </Typography>
            <Typography variant="caption" color="muted">
              {t('panelAgent.foreign.hint')}
            </Typography>
            {foreign.map((item) => {
              const id = item.conversationId;
              // Разговор, ещё не сохранённый (идёт первый ход), открыть нечем.
              const origin = titleOf(id);
              return (
                <PendingActionCard
                  key={item.id}
                  pending={item}
                  isDeciding={deciding.has(item.id)}
                  error={decideErrors[item.id]}
                  approveRefused={approveRefused.has(item.id)}
                  onDecide={(decision) => onDecide(item.id, decision)}
                  autoFocus={false}
                  foreign={{
                    origin,
                    onOpenConversation:
                      id && origin && onOpenConversation && !state.running
                        ? () => onOpenConversation(id)
                        : undefined,
                  }}
                />
              );
            })}
          </section>
        )}
      </div>

      <ImageAttachTray attach={attach} />
      <ImageAttachZone attach={attach} className={styles.composer}>
        <textarea
          ref={inputRef}
          className={styles.input}
          data-agent-input
          onFocus={() => {
            cardHadFocusRef.current = false;
          }}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter отправляет, Shift+Enter переносит строку — как в чате панели.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={t('panelAgent.inputPlaceholder')}
          aria-label={t('panelAgent.inputLabel')}
          rows={2}
        />
        <ImageAttachButton attach={attach} />
        <VoiceControl
          disabled={state.running}
          onViewChange={setVoice}
          onDictated={(heard) => {
            setInput((current) => appendDictation(current, heard));
            // В поле — только если человек всё ещё в окне: ушёл на страницу — не дёргаем.
            if (document.activeElement?.closest('[data-panel-agent-window]')) {
              inputRef.current?.focus();
            }
          }}
        />
        {state.running ? (
          <Button
            variant="secondary"
            iconOnly
            icon={<Icon name="stop" size={24} />}
            aria-label={t('panelAgent.stop')}
            onClick={session.stop}
          />
        ) : (
          <Button
            variant="primary"
            iconOnly
            icon={<Icon name="send" size={24} />}
            aria-label={t('panelAgent.send')}
            onClick={send}
            disabled={!input.trim() || dictating || attach.isPreparing}
          />
        )}
      </ImageAttachZone>
    </>
  );
}
