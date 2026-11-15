import { describe, expect, it } from 'vitest';
import { cleanModelText, presentAssistantTurn } from '@opendots/shared';
import { finalText, messageText } from '../src/conversations/repo.ts';

describe('annotations du transcript recopiées par un modèle', () => {
  it('ne sont ni affichées, ni transmises à un autre compagnon', () => {
    expect(cleanModelText('[message msg_a4141ex3i3b1u] La correction est prête.')).toBe('La correction est prête.');
    expect(cleanModelText('[message msg_1]\n[replying to msg_0: salut]\nBonjour.')).toBe('Bonjour.');
    expect(cleanModelText('Voir [la doc](https://x.test) et [ici].')).toBe('Voir [la doc](https://x.test) et [ici].');
    const parts = [{ type: 'text', text: '[message msg_x]\nRésultat : 3 fichiers.' }] as any;
    expect(presentAssistantTurn(parts).bubbles).toEqual([{ key: 'text-0', text: 'Résultat : 3 fichiers.' }]);
    expect(messageText({ parts })).toBe('Résultat : 3 fichiers.');
    expect(finalText({ parts })).toBe('Résultat : 3 fichiers.');
  });
});
