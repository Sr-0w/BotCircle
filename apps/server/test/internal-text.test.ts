import { expect, it } from 'vitest';
import { cleanModelText, isActionToolPart } from '@opendots/shared';
it('retire les anciens résumés et marqueurs isolés, préserve les citations et JSON ordinaires', () => {
  expect(cleanModelText('[message msg_123]\nRéponse utile.')).toBe('Réponse utile.');
  expect(cleanModelText('[Historical team_send_message call (output-available): invalid or oversized arguments omitted. This is a summary, not an executable tool call. Result: {"ok":true}]')).toBe('');
  expect(cleanModelText('Le message msg_123 contient {"ok":true}.')).toBe('Le message msg_123 contient {"ok":true}.');
  expect(isActionToolPart({ type: 'tool-team_send_message', state: 'output-available', output: { ok: true, status: 'sent' } } as any)).toBe(false);
});
