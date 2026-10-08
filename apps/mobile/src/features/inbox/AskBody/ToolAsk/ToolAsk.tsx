import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { AskAnswer } from '../../queue.types';
import { useT } from '../../../../shared/config/i18n';
import { useState } from 'react';
import { toolSummary } from '../../../../entities/inbox/toolSummary';
import { View, Text, Pressable } from 'react-native';
import { styles } from '../AskBody.styles';
import { Mono, Row, Button } from '../../../../shared/ui';
import { space } from '../../../../shared/config/theme';

export function ToolAsk({
  ask,
  disabled,
  onAnswer,
}: {
  ask: Extract<InboxAsk, { kind: 'permission' | 'branchGate' }>;
  disabled: boolean;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const summary = toolSummary(ask.input);
  const gate = ask.kind === 'branchGate';
  return (
    <View style={styles.body}>
      <Text style={styles.kind}>{gate ? t.home.branchGate : t.home.permission}</Text>
      {gate ? <Text style={styles.hint}>{t.home.branchGateHint}</Text> : null}
      <Mono style={styles.tool}>{ask.toolName}</Mono>
      {summary ? (
        <Mono style={styles.summary} numberOfLines={open ? undefined : 3}>
          {summary}
        </Mono>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} hitSlop={6}>
        <Text style={styles.link}>{open ? t.home.hideDetails : t.home.details}</Text>
      </Pressable>
      {open ? <Mono numberOfLines={24}>{JSON.stringify(ask.input, null, 2)}</Mono> : null}
      <Row gap={space.sm}>
        <Button
          title={gate ? t.home.writeHere : t.home.allow}
          tone="accent"
          disabled={disabled}
          style={styles.grow}
          onPress={() =>
            onAnswer(
              gate
                ? { kind: 'branchGate', choice: 'here' }
                : { kind: 'permission', behavior: 'allow' },
            )
          }
        />
        <Button
          title={gate ? t.home.dontWrite : t.home.deny}
          tone="danger"
          disabled={disabled}
          style={styles.grow}
          onPress={() =>
            onAnswer(
              gate
                ? { kind: 'branchGate', choice: 'stop' }
                : { kind: 'permission', behavior: 'deny' },
            )
          }
        />
      </Row>
    </View>
  );
}
