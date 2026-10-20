import { useTranslation } from 'react-i18next';
import { setMascotPrefs } from '@shared/lib/mascot';
import { toast } from '@shared/lib/toast';
import { Mascot } from '@shared/ui/mascot';
import { Button } from '@shared/ui/button';
import { Toggle } from '@shared/ui/toggle';
import type { ChatTarget } from '../../model/chatTargets.types';
import type { MascotPanelProps, TargetListProps } from './MascotPanel.types';
import styles from './MascotPanel.module.scss';

/** Столько разговоров видно в каждом списке; остальные — строкой «и ещё N». */
const SHOWN = 3;

function TargetList({ title, tone, targets, onOpen, kind }: TargetListProps) {
  const { t } = useTranslation();
  if (targets.length === 0) return null;
  const rest = targets.length - SHOWN;

  return (
    <section className={styles.section} data-mascot-list={kind}>
      <h3 className={styles.sectionTitle} data-tone={tone}>
        {title} · {targets.length}
      </h3>
      <ul className={styles.list}>
        {targets.slice(0, SHOWN).map((target) => (
          <li key={target.chatId}>
            <button type="button" className={styles.row} onClick={() => onOpen(target)}>
              <span className={styles.rowName}>{target.name || t('mascot.panel.untitled')}</span>
              <span className={styles.rowAction}>{t('mascot.panel.open')}</span>
            </button>
          </li>
        ))}
      </ul>
      {rest > 0 && <p className={styles.more}>{t('mascot.panel.more', { count: rest })}</p>}
    </section>
  );
}

/**
 * Сводка Деки — что делается с агентами прямо сейчас, одним взглядом: ждущие
 * ответа (первыми — работа стоит), упавшие, работающие; каждый разговор —
 * переход в него. Ниже совет по месту и рычаги самого маскота: реплики и
 * «Спрятать». Escape закрывает и возвращает фокус на Деку.
 */
export function MascotPanel({ ref, style, companion, onClose, onNavigate }: MascotPanelProps) {
  const { t } = useTranslation();
  const { lists, status, mood, prefs } = companion;
  const quiet = lists.waiting.length + lists.errors.length + lists.running.length === 0;

  const open = (target: ChatTarget): void => {
    onNavigate();
    companion.openChat(target);
  };

  const hide = (): void => {
    setMascotPrefs({ enabled: false });
    toast.info(t('mascot.panel.hidden'));
  };

  return (
    <div
      ref={ref}
      className={styles.panel}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label={t('mascot.panel.title')}
      data-mascot-panel
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header className={styles.header}>
        <Mascot mood={mood} size={36} />
        <div>
          <p className={styles.title}>{t('mascot.panel.title')}</p>
          <p className={styles.subtitle}>
            {t('mascot.panel.subtitle')}:{' '}
            {t(`mascot.status.${status.key}`, { count: status.count })}
          </p>
        </div>
      </header>

      <TargetList
        kind="waiting"
        tone="waiting"
        title={t('mascot.panel.waiting')}
        targets={lists.waiting}
        onOpen={open}
      />
      <TargetList
        kind="errors"
        tone="error"
        title={t('mascot.panel.errors')}
        targets={lists.errors}
        onOpen={open}
      />
      <TargetList
        kind="running"
        tone="working"
        title={t('mascot.panel.running')}
        targets={lists.running}
        onOpen={open}
      />
      {quiet && <p className={styles.quiet}>{t('mascot.panel.allQuiet')}</p>}

      <section className={styles.tip} data-mascot-panel-tip={companion.tip}>
        <span className={styles.tipLabel}>{t('mascot.panel.tipTitle')}</span>
        <span>{t(`mascot.tips.${companion.tip}`)}</span>
        <button
          type="button"
          className={styles.tipNext}
          onClick={companion.nextTip}
          data-mascot-next-tip
        >
          {t('mascot.panel.nextTip')}
        </button>
      </section>

      <footer className={styles.footer}>
        <label className={styles.toggleRow}>
          <Toggle
            size="sm"
            checked={prefs.chatty}
            onCheckedChange={(chatty) => setMascotPrefs({ chatty })}
            aria-label={t('mascot.panel.chatty')}
          />
          <span>{t('mascot.panel.chatty')}</span>
        </label>
        <Button variant="ghost" size="sm" onClick={hide} data-mascot-hide>
          {t('mascot.panel.hide')}
        </Button>
      </footer>
    </div>
  );
}
