import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import type { BranchGateCardProps } from './BranchGateCard.types';
import styles from './ChatMessages.module.scss';

/**
 * Первая правка в основной рабочей копии: агент стоит, пока человек не скажет,
 * ГДЕ работать.
 *
 * Имя ветки в поле, а не в вопросе «да/нет»: копия живёт дольше разговора, её
 * имя увидят в списке веток и в запросе на слияние, и предложение панели —
 * только заготовка. Кнопок три, и «писать здесь» не спрятана: чат в проекте без
 * параллельной работы — обычное дело, и заставлять его заводить копию было бы
 * ровно той церемонией, от которой ворота и должны избавлять.
 */
export function BranchGateCard({ gates, onDecide }: BranchGateCardProps) {
  const { t } = useTranslation();
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (gates.length === 0) return null;

  const decide = async (
    toolUseId: string,
    choice: 'copy' | 'here' | 'stop',
    branch?: string,
  ): Promise<void> => {
    setBusy(toolUseId);
    const result = await onDecide(toolUseId, choice, branch);
    setBusy(undefined);
    // Ошибку показываем В КАРТОЧКЕ, а не всплывашкой: отказ git («ветка уже
    // есть») чинится правкой имени прямо здесь, и текст должен лежать рядом с
    // полем, а не улететь через три секунды.
    setErrors((current) =>
      result.ok
        ? current
        : { ...current, [toolUseId]: result.error ?? t('chat.branchGate.failed') },
    );
  };

  return (
    <div className={`${styles.question} ${styles.branchGate}`}>
      <Stack
        direction="row"
        align="center"
        gap="var(--spacing-2xs)"
        className={`${styles.questionHead} ${styles.branchGateHead}`}
      >
        <Icon name="branch" size={20} />
        <Typography as="span" variant="body-sm" weight="semibold" color="accent">
          {t('chat.branchGate.title')}
        </Typography>
      </Stack>

      {gates.map((gate) => {
        const name = names[gate.toolUseId] ?? gate.branch;
        const pending = busy === gate.toolUseId;
        // Работа отдана группам (Д15): главный путь — передать правку им, а не
        // заводить третью копию на ту же задачу.
        const handed = gate.children && gate.children.length > 0 ? gate.children : undefined;
        return (
          <div key={gate.toolUseId} className={styles.questionItem}>
            <Typography variant="body-sm" color="muted">
              {t('chat.branchGate.reason', { tool: gate.toolName })}
            </Typography>
            <pre className={styles.permissionInput}>{gate.cwd}</pre>
            {handed && (
              <Stack gap="var(--spacing-3xs)" marginTop="var(--spacing-2xs)">
                <Typography variant="body-sm" weight="semibold">
                  {t('chat.branchGate.handedTitle')}
                </Typography>
                {handed.map((child) => (
                  <Typography key={child.number} variant="body-sm">
                    {t('chat.branchGate.handedChild', {
                      number: child.number,
                      title: child.title,
                      branch: child.branch,
                    })}
                  </Typography>
                ))}
                <Typography variant="body-sm" color="muted">
                  {t('chat.branchGate.handedHint')}
                </Typography>
              </Stack>
            )}
            {gate.base && (
              <Typography variant="body-sm" color="muted">
                {t('chat.branchGate.base', { base: gate.base })}
              </Typography>
            )}
            <TextField
              label={t('chat.branchGate.branchLabel')}
              value={name}
              onChange={(value) => setNames((current) => ({ ...current, [gate.toolUseId]: value }))}
              hint={t('chat.branchGate.branchHint')}
              isMono
              disabled={pending}
              {...(errors[gate.toolUseId] ? { error: errors[gate.toolUseId] } : {})}
            />
            <Stack
              direction="row"
              justify="end"
              gap="var(--spacing-2xs)"
              marginTop="var(--spacing-2xs)"
              wrap
            >
              <Button
                size="sm"
                variant={handed ? 'primary' : 'ghost'}
                disabled={pending}
                onClick={() => void decide(gate.toolUseId, 'stop')}
              >
                {handed ? t('chat.branchGate.handOff') : t('chat.branchGate.stop')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => void decide(gate.toolUseId, 'here')}
              >
                {t('chat.branchGate.here')}
              </Button>
              <Button
                size="sm"
                variant={handed ? 'secondary' : 'primary'}
                disabled={pending || name.trim().length === 0}
                onClick={() => void decide(gate.toolUseId, 'copy', name.trim())}
              >
                {pending ? t('chat.branchGate.working') : t('chat.branchGate.copy')}
              </Button>
            </Stack>
          </div>
        );
      })}
    </div>
  );
}
