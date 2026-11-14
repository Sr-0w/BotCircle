import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/client.ts';
import { createAgent } from '../src/agents/repo.ts';
import { ArtifactError, artifactFor, artifactHistory, createArtifact, deleteArtifact, detectMediaType, getArtifact, grantArtifact, listArtifacts, readArtifact, revokeGrant, sanitizeName } from '../src/artifacts/service.ts';
import { artifactTools, shareArtifactsWith } from '../src/artifacts/tools.ts';
import { hydrateMessageImages, validateMessageParts } from '../src/attachments/service.ts';
import { sendTeamMessage } from '../src/team/service.ts';
import { loadMessages, pairConversationId } from '../src/conversations/repo.ts';
import { artifactUrl, presentAssistantTurn } from '@opendots/shared';

beforeAll(async () => { await openDatabase({ memory: true }); });
afterAll(async () => { await closeDatabase(); });

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]);
const run = (tools: any, name: string, input: unknown) => tools[name].execute(input, { toolCallId: 't', messages: [] });

describe('artefacts', () => {
  it('garde le fichier inchangé, détecte son type et assainit son nom', async () => {
    const row = await createArtifact({ bytes: pdf, name: '../../etc/rapport final.pdf', authorKind: 'user', source: 'upload' });
    expect(row.name).toBe('rapport final.pdf');
    expect(row.mediaType).toBe('application/pdf');
    expect((await readArtifact('user', row.id)).bytes.equals(pdf)).toBe(true);
    expect(sanitizeName('..\\..\\secret\u0000.txt')).toBe('secret_.txt');
    expect(detectMediaType('notes.md', Buffer.from('# Titre'))).toBe('text/markdown');
  });

  it('refuse les exécutables et les fichiers vides', async () => {
    await expect(createArtifact({ bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), name: 'outil', authorKind: 'user', source: 'upload' })).rejects.toMatchObject({ status: 'rejected' });
    await expect(createArtifact({ bytes: Buffer.from('MZ\u0090\u0000'), name: 'photo.png', authorKind: 'user', source: 'upload' })).rejects.toBeInstanceOf(ArtifactError);
    await expect(createArtifact({ bytes: Buffer.from('echo'), name: 'setup.exe', authorKind: 'user', source: 'upload' })).rejects.toMatchObject({ status: 'rejected' });
    await expect(createArtifact({ bytes: Buffer.alloc(0), name: 'vide.txt', authorKind: 'user', source: 'upload' })).rejects.toMatchObject({ status: 'rejected' });
  });

  it("un compagnon ne lit que ce qui lui a été remis, et une révocation coupe l'accès", async () => {
    const ari = await createAgent({ name: 'Ari' });
    const homey = await createAgent({ name: 'Homey' });
    const row = await createArtifact({ bytes: Buffer.from('chiffres : 1, 2, 3'), name: 'report.txt', authorKind: 'user', source: 'upload' });
    await expect(artifactFor(ari.id, row.id)).rejects.toMatchObject({ status: 'not_found' });
    await grantArtifact(row.id, ari.id, 'user', 'upload');
    expect((await readArtifact(ari.id, row.id)).bytes.toString()).toContain('chiffres');
    await expect(readArtifact(homey.id, row.id)).rejects.toMatchObject({ status: 'not_found' });
    expect((await listArtifacts({ agentId: homey.id })).length).toBe(0);
    await revokeGrant(row.id, ari.id);
    await expect(readArtifact(ari.id, row.id)).rejects.toMatchObject({ status: 'not_found' });
    const history = await artifactHistory(row.id);
    expect(history.grants[0].revokedAt).not.toBeNull();
    expect(history.access.map((a) => a.action)).toEqual(expect.arrayContaining(['create', 'share', 'read', 'denied', 'revoke']));
  });

  it("partage entre compagnons par référence : lecture seule, révision séparée, contenu stocké une fois", async () => {
    const ari = await createAgent({ name: 'Ari2' });
    const homey = await createAgent({ name: 'Homey2' });
    const stranger = await createAgent({ name: 'Autre' });
    const ariTools = artifactTools({ agent: ari, conversationId: 'cv_a', isMain: true, userTurn: true, depth: 0, tz: 'UTC', publishArtifact: async () => 'cv_a' } as any);
    const homeyTools = artifactTools({ agent: homey, conversationId: 'cv_h', isMain: true, userTurn: false, depth: 1, tz: 'UTC' } as any);
    const created = await run(ariTools, 'artifact_create', { name: 'report.csv', content: 'a,b\n1,2' });
    expect(created.status).toBe('created');
    // Sans partage, le destinataire ne peut rien lire, même en connaissant l'identifiant.
    expect((await run(homeyTools, 'artifact_read', { artifact_id: created.artifact.id })).status).toBe('not_found');
    // Un compagnon ne peut pas transmettre un fichier qu'il n'a pas.
    const foreign = await createArtifact({ bytes: Buffer.from('privé'), name: 'prive.txt', authorKind: 'user', source: 'upload' });
    await expect(shareArtifactsWith(ari.id, homey.id, [foreign.id], {})).rejects.toMatchObject({ status: 'not_found' });

    const tm = await sendTeamMessage({ fromAgentId: ari.id, toAgentId: homey.id, content: 'Vérifie les chiffres', expectsReply: false, replyToConversationId: null, depth: 1, artifacts: await shareArtifactsWith(ari.id, homey.id, [created.artifact.id], {}) });
    const thread = await loadMessages(await pairConversationId(ari.id, homey.id), { limit: 5, includeHidden: true });
    expect(thread.messages.at(-1)!.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'file', url: artifactUrl(created.artifact.id), filename: 'report.csv' })]));
    expect(tm.id).toMatch(/^tm_/);

    const read = await run(homeyTools, 'artifact_read', { artifact_id: created.artifact.id });
    expect(read.text).toBe('a,b\n1,2');
    const revised = await run(homeyTools, 'artifact_create', { name: 'revised.csv', content: 'a,b\n1,3', revision_of: created.artifact.id });
    expect(revised.artifact.revisionOf).toBe(created.artifact.id);
    expect((await readArtifact('user', created.artifact.id)).bytes.toString()).toBe('a,b\n1,2');
    expect((await run(artifactTools({ agent: stranger, conversationId: 'cv_s', isMain: true, userTurn: true, depth: 0, tz: 'UTC' } as any), 'artifact_read', { artifact_id: created.artifact.id })).status).toBe('not_found');

    // Même contenu, deux artefacts : une seule empreinte.
    const twin = await run(homeyTools, 'artifact_create', { name: 'copie.csv', content: 'a,b\n1,2' });
    expect((await getArtifact(twin.artifact.id))!.sha256).toBe((await getArtifact(created.artifact.id))!.sha256);
    await deleteArtifact(twin.artifact.id);
    expect((await readArtifact('user', created.artifact.id)).bytes.toString()).toBe('a,b\n1,2');

    const status = await run(ariTools, 'artifact_get_status', { artifact_id: created.artifact.id });
    expect(status.readableBy).toEqual(expect.arrayContaining(['Ari2', 'Homey2']));
    expect(status.published).toBe(false);
    const published = await run(ariTools, 'artifact_publish_to_chat', { artifact_id: created.artifact.id });
    expect(published.status).toBe('published');
    expect((await run(ariTools, 'artifact_get_status', { artifact_id: created.artifact.id })).published).toBe(true);
    expect((await run(ariTools, 'artifact_publish_to_chat', { artifact_id: 'art_inconnu' })).status).toBe('not_found');
  });

  it("un fichier joint à un message reste une référence : ses octets n'entrent pas dans le contexte", async () => {
    const row = await createArtifact({ bytes: pdf, name: 'contrat.pdf', authorKind: 'user', source: 'upload' });
    const parts = await validateMessageParts([{ type: 'text', text: 'Lis ça' }, { type: 'file', url: artifactUrl(row.id), filename: 'x', mediaType: 'x/y' }]);
    expect(parts[1]).toEqual({ type: 'file', url: artifactUrl(row.id), filename: 'contrat.pdf', mediaType: 'application/pdf' });
    await expect(validateMessageParts([{ type: 'file', url: artifactUrl('art_absent') }])).rejects.toThrow();
    const [hydrated] = await hydrateMessageImages([{ id: 'm', role: 'user', parts } as any]);
    expect(hydrated.parts[1].type).toBe('text');
    expect((hydrated.parts[1] as { text: string }).text).toContain(`artifact_id: ${row.id}`);
    expect(JSON.stringify(hydrated)).not.toContain('%PDF');
  });

  it("une publication confirmée devient une pièce jointe du fil ; un échec reste dans le travail", () => {
    const view = presentAssistantTurn([
      { type: 'tool-artifact_publish_to_chat', state: 'output-available', toolCallId: 'a', input: {}, output: { ok: true, status: 'published', artifact: { id: 'art_x', url: artifactUrl('art_x'), name: 'report.pdf', mediaType: 'application/pdf', size: 1234 } } },
      { type: 'tool-artifact_publish_to_chat', state: 'output-available', toolCallId: 'b', input: {}, output: { ok: false, status: 'not_found', error: 'absent' } },
      { type: 'file', url: artifactUrl('art_y'), filename: 'notes.md', mediaType: 'text/markdown' },
    ]);
    expect(view.bubbles.map((b) => ('file' in b ? b.file.filename : ''))).toEqual(['report.pdf', 'notes.md']);
    expect(view.work).toHaveLength(1);
  });
});
