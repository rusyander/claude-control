import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import { TextField } from '@shared/ui/text-field';
import { normalizeProjectPath } from '@shared/lib/workspace';
import type { ParallelLaunchProps } from './ParallelLaunch.types';
import styles from './ParallelLaunch.module.scss';

/**
 * Запуск одного запроса сразу в нескольких проектах. Отмечаешь проекты, пишешь
 * одну задачу — в каждом стартует свой агент. За ними потом видно из пульта и по
 * цветным точкам на табах. Правки по умолчанию разрешены — как и в обычном чате
 * (`chatPrefsStore`): агент, которому нельзя писать, в проекте бесполезен, а
 * выключить тумблер перед запуском можно тут же.
 */
export function ParallelLaunch({ isOpen, onOpenChange, projects, onLaunch }: ParallelLaunchProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [allowEdits, setAllowEdits] = useState(true);

  // При каждом открытии — с чистого листа.
  useEffect(() => {
    if (isOpen) {
      setSelected(new Set());
      setPrompt('');
      setAllowEdits(false);
    }
  }, [isOpen]);

  // Запускать можно только в существующих на диске проектах.
  const available = useMemo(() => projects.filter((project) => project.exists), [projects]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const chosen = available.filter((project) => selected.has(normalizeProjectPath(project.path)));
  const canLaunch = chosen.length > 0 && prompt.trim().length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('parallel.title')}
      description={t('parallel.hint')}
      size="md"
      footer={
        <Stack
          direction="row"
          justify="between"
          align="center"
          gap="var(--spacing-sm)"
          width="100%"
        >
          <Stack
            as="label"
            direction="row"
            align="center"
            gap="var(--spacing-2xs)"
            className={styles.editsToggle}
          >
            <Toggle
              size="sm"
              checked={allowEdits}
              onCheckedChange={setAllowEdits}
              aria-label={t('chat.allowEdits')}
            />
            <Typography variant="caption" color={allowEdits ? 'default' : 'subtle'} as="span">
              {allowEdits ? t('chat.editsAllowed') : t('chat.readOnly')}
            </Typography>
          </Stack>
          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!canLaunch}
              leftIcon={<Icon name="send" size={20} />}
              onClick={() => onLaunch(chosen, prompt.trim(), allowEdits)}
            >
              {t('parallel.launch', { count: chosen.length })}
            </Button>
          </Stack>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        <TextField
          label={t('parallel.prompt')}
          value={prompt}
          onChange={setPrompt}
          placeholder={t('parallel.promptPlaceholder')}
          multiline
          rows={3}
        />

        <Typography variant="caption" color="subtle">
          {t('parallel.pickProjects', { count: chosen.length })}
        </Typography>

        <div className={styles.list}>
          {available.map((project) => {
            const id = normalizeProjectPath(project.path);
            const isOn = selected.has(id);
            return (
              <button
                key={project.path}
                type="button"
                className={`${styles.item} ${isOn ? styles.itemOn : ''}`}
                onClick={() => toggle(id)}
                title={project.path}
              >
                <span className={styles.check}>{isOn && <Icon name="check" size={14} />}</span>
                <Stack gap="0" className={styles.itemText}>
                  <Typography variant="body-sm" as="span" truncate>
                    {project.name}
                  </Typography>
                  <Typography
                    variant="mono"
                    color="subtle"
                    as="span"
                    truncate
                    className={styles.path}
                  >
                    {project.path}
                  </Typography>
                </Stack>
              </button>
            );
          })}
        </div>
      </Stack>
    </Modal>
  );
}
