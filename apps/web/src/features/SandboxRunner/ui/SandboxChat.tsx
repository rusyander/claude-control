import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { useSandboxRun } from '@entities/Sandbox';
import { toast } from '@shared/lib/toast';
import { useDraft } from '@shared/lib/draft';
import { buildTestPrompts } from '../model/buildTestPrompt';
import type { SandboxChatProps } from './SandboxChat.types';
import styles from './SandboxModal.module.scss';

/**
 * Разговор внутри песочницы.
 *
 * Для правил и скиллов это единственный способ проверки: они не запускаются
 * сами, а меняют поведение модели — значит увидеть их действие можно только
 * в ответе. Готовые запросы подобраны так, чтобы проверяемое проявилось.
 */
export function SandboxChat({ sandboxId, kind, title, context }: SandboxChatProps) {
  const { t } = useTranslation();
  const { state, run, stop } = useSandboxRun();
  // Черновик запроса переживает перезагрузку: у каждой песочницы — свой.
  const [prompt, setPrompt] = useDraft(`sandbox:${sandboxId}`);

  // Запросы собираются из самой настройки, поэтому проверяют именно её.
  const suggestions = useMemo(
    () => buildTestPrompts(kind, { title, ...context }),
    [kind, title, context],
  );

  return (
    <Stack gap="var(--spacing-sm)">
      <Typography variant="body-sm" color="muted">
        {t('sandbox.chatHint')}
      </Typography>

      {/* Готовые запросы: нажатие подставляет текст, вторая кнопка копирует —
          тот же запрос бывает нужен снаружи, в терминале. */}
      <Stack direction="row" gap="var(--spacing-2xs)" wrap>
        {suggestions.map((suggestion) => (
          <span key={suggestion.label} className={styles.chip} title={suggestion.prompt}>
            <button
              type="button"
              className={styles.chipText}
              onClick={() => setPrompt(suggestion.prompt)}
            >
              {suggestion.label}
            </button>
            <button
              type="button"
              className={styles.chipCopy}
              aria-label={`${t('chat.copyMessage')}: ${suggestion.label}`}
              onClick={() =>
                void navigator.clipboard.writeText(suggestion.prompt).then(() => {
                  toast.success(t('toasts.copied'));
                })
              }
            >
              <Icon name="copy" size={14} />
            </button>
          </span>
        ))}
      </Stack>

      <TextField
        label={t('sandbox.prompt')}
        value={prompt}
        onChange={setPrompt}
        multiline
        rows={3}
        placeholder={t('sandbox.promptPlaceholder')}
      />

      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        {state.isRunning ? (
          <Button
            variant="secondary"
            leftIcon={<Icon name="stop" size={20} />}
            onClick={() => stop(sandboxId)}
          >
            {t('chat.stop')}
          </Button>
        ) : (
          <Button
            variant="primary"
            leftIcon={<Icon name="send" size={24} />}
            onClick={() => void run(sandboxId, prompt)}
            disabled={!prompt.trim()}
          >
            {t('sandbox.runPrompt')}
          </Button>
        )}

        {state.costUsd !== undefined && <Badge tone="neutral">${state.costUsd.toFixed(3)}</Badge>}

        {state.tools.length > 0 && (
          <Stack direction="row" gap="var(--spacing-3xs)" wrap>
            {[...new Set(state.tools)].map((tool) => (
              <Badge key={tool} tone="info">
                {tool}
              </Badge>
            ))}
          </Stack>
        )}
      </Stack>

      {state.error && (
        <Typography variant="body-sm" color="danger">
          {state.error}
        </Typography>
      )}

      <div className={styles.answer}>
        {state.text || (
          <Typography color="subtle">
            {state.isRunning ? t('sandbox.waiting') : t('sandbox.answerPlaceholder')}
          </Typography>
        )}
      </div>
    </Stack>
  );
}
