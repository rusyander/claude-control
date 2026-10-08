import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { Button, Mono, Muted, Row, Title } from '../../shared/ui';
import { space } from '../../shared/config/theme';
import { useT, useLanguage } from '../../shared/config/i18n';
import { ApiError } from '../../shared/api/client';
import { panelText } from '../../entities/panel-agent/panelText';
import { useDecidePanelAction } from '../../entities/panel-agent/useDecidePanelAction';
import { PANEL_AGENT_KEYS } from '../../entities/panel-agent/api.constants';
import { isFinalRefusal } from '../../entities/panel-agent/isFinalRefusal';
import { cardPreview } from '../../entities/panel-agent/cardPreview';
import { isDanger } from '../../entities/panel-agent/isDanger';
import { canApprove } from '../../entities/panel-agent/canApprove';
import { decisionProblem } from '../../entities/panel-agent/decisionProblem';
import type { CardText } from '../../entities/panel-agent/model.types';
import { cardSummary } from '../../entities/panel-agent/cardSummary';
import { cardFields } from '../../entities/panel-agent/cardFields';
import { formatClock } from '../../shared/lib/formatClock';
import { DECISION_ARM_MS } from './AgentPendingCard.constants';
import { styles } from './AgentPendingCard.styles';

/**
 * Карточка подтверждения агента на телефоне — то же решение, что в окне панели:
 * без нажатия здесь или там ничего не выполняется. Поля и дифф показаны целиком
 * (длинное — в прокрутке): «Выполнить» нажимают по тому, что будет сделано.
 */
export function AgentPendingCard({ pending }: { pending: PanelPendingAction }) {
  const t = useT();
  const queryClient = useQueryClient();
  const decide = useDecidePanelAction();
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState(false);
  const [approveRefused, setApproveRefused] = useState(false);
  const mountedAt = useRef(Date.now());
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), DECISION_ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  const danger = isDanger(pending);
  const approvable = canApprove(pending) && !approveRefused;
  const language = useLanguage();
  const text: CardText = (code, params, fallback) =>
    panelText(t.panelTexts, language, code, params, fallback);
  const fields = cardFields(pending, text, language);
  const diff = cardPreview(pending, language).diff;

  const send = (decision: 'approve' | 'reject'): void => {
    if (Date.now() - mountedAt.current < DECISION_ARM_MS) return;
    if (decision === 'approve' && !approvable) return;
    setProblem('');
    decide.mutate(
      { id: pending.id, decision },
      {
        onSuccess: () => {
          setSent(true);
          void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.pending });
          void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.journal });
        },
        onError: (error) => {
          const refusal =
            error instanceof ApiError
              ? { status: error.status, code: error.code, message: error.message }
              : { message: error instanceof Error ? error.message : String(error) };
          if (refusal.code === 'preview_truncated') setApproveRefused(true);
          setProblem(
            decisionProblem(refusal, {
              truncated: t.agent.card.truncatedRefused,
              alreadyDecided: t.agent.card.alreadyDecided,
              gone: t.agent.card.gone,
              failed: t.agent.card.failed,
            }),
          );
          if (isFinalRefusal(refusal)) {
            void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.pending });
          }
        },
      },
    );
  };

  // Язык интерфейса, а не системы телефона (F-323).
  const expires = formatClock(pending.expiresAt, language);
  const busy = decide.isPending || sent;

  return (
    <View style={[styles.card, danger && styles.danger]} accessibilityRole="summary">
      <Title>{danger ? t.agent.card.dangerHeading : t.agent.card.heading}</Title>
      <Mono style={danger ? styles.dangerText : styles.name}>{pending.name}</Mono>
      <Muted>{cardSummary(pending, text, language)}</Muted>

      {fields.map((field, index) => (
        <View key={`${field.label}-${index}`} style={styles.field}>
          <Mono style={styles.label}>{field.label}</Mono>
          {field.long ? (
            <ScrollView style={styles.long} nestedScrollEnabled>
              <Mono>{field.value}</Mono>
            </ScrollView>
          ) : (
            <Mono>{field.value}</Mono>
          )}
        </View>
      ))}

      {diff ? (
        <View style={styles.field}>
          <Mono style={styles.label}>{t.agent.card.diff}</Mono>
          <ScrollView style={styles.long} nestedScrollEnabled>
            <Mono>{diff}</Mono>
          </ScrollView>
        </View>
      ) : null}

      {!canApprove(pending) ? (
        <Mono style={styles.dangerText}>{t.agent.card.truncated}</Mono>
      ) : null}
      <Muted>{t.agent.card.expires(expires)}</Muted>
      {sent ? <Muted>{t.agent.card.sent}</Muted> : null}
      {problem ? <Mono style={styles.dangerText}>{problem}</Mono> : null}

      {/* Отклонить — первой: у опасного действия отказ и есть ответ по умолчанию. */}
      <Row gap={space.sm}>
        <Button
          title={t.agent.card.reject}
          onPress={() => send('reject')}
          busy={decide.isPending && decide.variables?.decision === 'reject'}
          disabled={busy || !armed}
          style={styles.grow}
        />
        <Button
          title={t.agent.card.approve}
          tone={danger ? 'danger' : 'accent'}
          onPress={() => send('approve')}
          busy={decide.isPending && decide.variables?.decision === 'approve'}
          disabled={busy || !armed || !approvable}
          style={styles.grow}
        />
      </Row>
    </View>
  );
}
