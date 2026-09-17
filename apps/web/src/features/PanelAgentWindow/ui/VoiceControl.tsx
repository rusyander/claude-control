import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeechRecognition } from '@shared/hooks/use-speech-recognition';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { isDictating, isVoiceProblem, voiceView } from '../model/voiceInput';
import type { VoiceControlProps } from './VoiceControl.types';
import styles from './PanelAgent.module.scss';

/**
 * Микрофон окна агента. Распознаватель — тот же, что у чата и помощника форм
 * (`useSpeechRecognition` поверх Web Speech API); второго здесь нет. Звук
 * распознаёт браузер, панель получает только текст.
 *
 * Надиктованное попадает в поле, а не в разговор: отправляет человек, и дальше
 * текст идёт тем же путём, что набранный, — через маску данных сервера.
 */
export function VoiceControl({ onDictated, disabled, onViewChange }: VoiceControlProps) {
  const { t, i18n } = useTranslation();
  const speech = useSpeechRecognition(i18n.language === 'en' ? 'en-US' : 'ru-RU');
  const [attempted, setAttempted] = useState(false);
  const captionId = useId();

  const view = voiceView({
    state: speech.state,
    supported: speech.supported,
    error: speech.error,
    attempted,
  });
  const dictating = isDictating(view);

  // Колбэки в ref: в зависимостях эффект срабатывал бы на каждом рендере окна и
  // дописывал распознанное повторно.
  const latest = useRef({ onDictated, reset: speech.reset, onViewChange });
  latest.current = { onDictated, reset: speech.reset, onViewChange };

  const transcript = speech.transcript;
  useEffect(() => {
    if (!transcript) return;
    latest.current.onDictated(transcript);
    latest.current.reset();
  }, [transcript]);

  useEffect(() => {
    latest.current.onViewChange?.(view);
  }, [view]);

  const toggle = (): void => {
    if (dictating) {
      speech.stop();
      return;
    }
    setAttempted(true);
    speech.start();
  };

  const caption = ((): string => {
    if (view === 'listening') return speech.partial || t('panelAgent.voice.listening');
    if (view === 'finalizing') return t('panelAgent.voice.finalizing');
    if (view === 'idle') return '';
    return t(`panelAgent.voice.${view}`);
  })();
  const problem = isVoiceProblem(view);
  // Кнопка без поддержки остаётся в порядке Tab (`aria-disabled`, не `disabled`):
  // с клавиатуры иначе не узнать, почему диктовки нет.
  const unavailable = !speech.supported;

  return (
    <>
      <Button
        variant={dictating ? 'secondary' : 'ghost'}
        iconOnly
        icon={<Icon name={dictating ? 'stop' : 'mic'} size={24} />}
        aria-label={t(dictating ? 'panelAgent.voice.stop' : 'panelAgent.voice.start')}
        aria-pressed={dictating}
        aria-disabled={unavailable || undefined}
        aria-describedby={caption ? captionId : undefined}
        className={unavailable ? styles.voiceUnavailable : undefined}
        data-agent-voice={view}
        onClick={toggle}
        disabled={disabled || view === 'finalizing'}
      />
      {/* Живая область стоит всегда: вставленную вместе с текстом скринридер
          пропустил бы. Пустая схлопывается стилем. */}
      <Typography
        id={captionId}
        variant="caption"
        color={problem ? 'danger' : 'muted'}
        role={problem ? 'alert' : 'status'}
        className={styles.voiceCaption}
        data-agent-voice-caption={view}
      >
        {caption}
      </Typography>
    </>
  );
}
