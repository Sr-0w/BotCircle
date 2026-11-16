import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { avatarPath } from '@opendots/shared';
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent, getAgent, mainConversationId, toAgentDTO } from '../src/agents/repo.ts';
import { AVATAR_PRESETS, resolveAvatar } from '../src/agents/avatars.ts';
import { buildTools } from '../src/agents/tools.ts';
import { resolveApproval } from '../src/approvals/service.ts';
import { restoreAvatar } from '../src/agents/avatar-actions.ts';

beforeAll(async () => { await openDatabase({ memory: true }); });
afterAll(async () => { await closeDatabase(); });

describe('#50 : silhouettes des Circles', () => {
  it('chaque preset est une forme valide qui laisse la place aux yeux', () => {
    for (const [id, preset] of Object.entries(AVATAR_PRESETS)) {
      expect(() => resolveAvatar({ points: preset.points, roundness: preset.roundness }), id).not.toThrow();
      expect(avatarPath(preset.points, preset.roundness)).toMatch(/^M[\d.,]+(C[\d., ]+)+Z$/);
    }
  });

  it('une forme personnalisée est validée et normalisée — jamais de SVG libre', () => {
    const triangle = resolveAvatar({ points: [[50, 2], [98, 96], [2, 96]], roundness: 0.4 });
    expect(triangle).toMatchObject({ preset: null, roundness: 0.4 });
    expect(() => resolveAvatar({ points: [[10, 10], [90, 90], [90, 10], [10, 90]] })).toThrow(/se croise/);
    expect(() => resolveAvatar({ points: [[0, 0], [20, 0], [0, 20]] })).toThrow(/trop petite|yeux/);
    expect(() => resolveAvatar({ points: [[0, 0], [100, 0], [100, 30], [0, 30]] })).toThrow(/yeux/);
    expect(() => resolveAvatar({ points: [[0, 0], [200, 0], [0, 100]] })).toThrow(/0–100/);
    expect(() => resolveAvatar({ points: '<svg onload=alert(1)>' })).toThrow();
    expect(() => resolveAvatar({ preset: 'rocket' })).toThrow(/Forme inconnue/);
  });

  it('un Circle propose sa silhouette : aperçu à valider, puis appliquée, puis restaurable', async () => {
    const homey = await createAgent({ name: 'Homey' });
    const conv = await mainConversationId(homey.id);
    const tools = buildTools({ agent: homey, conversationId: conv, isMain: true, userTurn: true, depth: 0, tz: 'UTC' } as any) as any;
    expect(tools.avatar_propose).toBeDefined();
    const proposed = await tools.avatar_propose.execute({ preset: 'house', reason: 'la maison' }, { toolCallId: 't1' });
    expect(proposed).toMatchObject({ ok: true, status: 'pending_approval' });
    expect((await getAgent(homey.id))!.avatar).toBeNull();
    const approved = await resolveApproval(proposed.approvalId, 'approve', { by: 'ui', notifyAgent: false });
    expect(approved.status).toBe('executed');
    const dto = await toAgentDTO((await getAgent(homey.id))!);
    expect(dto.avatar).toMatchObject({ preset: 'house' });
    const bad = await tools.avatar_propose.execute({ points: [[10, 10], [90, 90], [90, 10], [10, 90]] }, { toolCallId: 't2' });
    expect(bad).toMatchObject({ ok: false });
    await restoreAvatar(homey.id);
    expect((await getAgent(homey.id))!.avatar).toBeNull();
  });
});
