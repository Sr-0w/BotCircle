import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
let model: any;
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async () => ({ model, providerOptions: {}, label: 'login-fixture' }), requireDesktopVision: async () => {} }));
const fixture = () => tool({ inputSchema: z.object({}).passthrough(), execute: async () => ({ ok: true }) });
vi.mock('../src/agents/capability-tools.ts', () => ({ buildCapabilityTools: async () => ({ info: { connectors: [], skills: [] }, lazy: { loaded: new Set(), names: new Set(), groups: [] }, tools: { shell_exec: fixture(), computer_screenshot: fixture(), browser_inspect: fixture(), web_fetch_fixture: fixture() } }) }));
import { eq } from 'drizzle-orm';
import { isActionToolPart } from '@opendots/shared';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { runTurn } from '../src/agents/turn.ts';
import { setSetting } from '../src/settings.ts';
import { humanControl } from '../src/computer/desktop.ts';
import { withDesktopAgent } from '../src/computer/session.ts';
import { loadMessages } from '../src/conversations/repo.ts';
import { createTask, getTask } from '../src/tasks/service.ts';
import { runTask } from '../src/tasks/runner.ts';
import { checkLoginUrl, expireSecureLogins, getSecureLogin, pendingSecureLogin, requestSecureLogin, resolveSecureLogin, SECURE_LOGIN_TTL_MS, SecureLoginError } from '../src/securelogin/service.ts';

beforeAll(async () => { await openDatabase({ memory: true }); await setSetting('engine.turnStepLimit', null); });
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const reply = (parts: any[], more: boolean) => ({ warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, ...parts, { type: 'finish', finishReason: { unified: more ? 'tool-calls' : 'stop', raw: more ? 'tool_calls' : 'stop' }, usage }]) c.enqueue(p); c.close(); } }) }) as any;
const text = (value: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: value }, { type: 'text-end', id: 't' }];
const call = (name: string, input: unknown, id: string) => ({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) });
const toolNames = (options: any) => (options.tools as { name: string }[]).map((t) => t.name);
async function agentWithComputer(name: string) {
  const agent = await createAgent({ name });
  await db().update(schema.agents).set({ permissions: { ...agent.permissions, computer: true } }).where(eq(schema.agents.id, agent.id));
  return agent;
}
const wakes = async (agentId: string) => (await db().select().from(schema.jobs).where(eq(schema.jobs.agentId, agentId))).filter((job) => job.type === 'agent.wake');

describe('connexion sécurisée', () => {
  it("n'accepte qu'une origine HTTPS sans identifiants, et affiche celle que le serveur a analysée", () => {
    expect(checkLoginUrl('https://service.example/login?next=%2Fhome#frag')).toEqual({ origin: 'https://service.example', url: 'https://service.example/login?next=%2Fhome' });
    expect(checkLoginUrl('http://localhost:8080/login').origin).toBe('http://localhost:8080');
    expect(() => checkLoginUrl('http://service.example/login')).toThrow(SecureLoginError);
    expect(() => checkLoginUrl('https://user:secret@service.example/')).toThrow(SecureLoginError);
    expect(() => checkLoginUrl('javascript:alert(1)')).toThrow(SecureLoginError);
    // Un domaine trompeur reste affiché tel qu'il est réellement.
    expect(checkLoginUrl('https://service.example.evil.test/login').origin).toBe('https://service.example.evil.test');
  });

  it("suspend les outils d'ordinateur du compagnon dès la demande, sans bloquer la conversation", async () => {
    const agent = await agentWithComputer('Connexion');
    const conv = await mainConversationId(agent.id);
    const seen: string[][] = [];
    let i = 0;
    model = new MockLanguageModelV4({ doStream: async (options: any) => {
      seen.push(toolNames(options));
      return [
        () => reply([call('request_secure_login', { url: 'https://service.example/login', reason: 'Lire la facture' }, 'a')], true),
        () => reply(text('Une connexion est nécessaire sur service.example.'), false),
        () => reply(text('Il est 10 h.'), false),
      ][Math.min(i++, 2)]();
    } });
    const first = await runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_login_1', role: 'user', parts: [{ type: 'text', text: 'Récupère ma facture.' }] } }).done;
    expect(first.text).toContain('connexion est nécessaire');
    const pending = (await pendingSecureLogin(agent.id))!;
    expect(pending).toMatchObject({ origin: 'https://service.example', status: 'pending', reason: 'Lire la facture' });
    // Avant la demande le compagnon a ses outils ; à l'étape suivante ils ont disparu, les autres restent.
    expect(seen[0]).toEqual(expect.arrayContaining(['shell_exec', 'computer_screenshot', 'browser_inspect', 'request_secure_login']));
    for (const name of ['shell_exec', 'computer_screenshot', 'browser_inspect']) expect(seen[1]).not.toContain(name);
    expect(seen[1]).toContain('web_fetch_fixture');
    // La frontière est aussi tenue au niveau du bureau : captures et actions du modèle sont refusées.
    expect(await withDesktopAgent(agent.id, humanControl)).toBe(true);
    // La carte reste dans le fil, et le compagnon répond toujours à autre chose, sans ses outils d'ordinateur.
    const stored = (await loadMessages(conv, { limit: 5 })).messages.at(-1)!;
    expect(stored.parts.some((part) => isActionToolPart(part as any))).toBe(true);
    const other = await runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_login_2', role: 'user', parts: [{ type: 'text', text: 'Quelle heure est-il ?' }] } }).done;
    expect(other.text).toBe('Il est 10 h.');
    expect(seen[2]).not.toContain('shell_exec');
    // Une seconde demande ne crée pas une seconde carte.
    expect((await requestSecureLogin({ agentId: agent.id, conversationId: conv, url: 'https://other.example/login', reason: 'x' })).id).toBe(pending.id);
    await resolveSecureLogin(pending.id, 'cancelled');
  });

  it('ne rend au compagnon qu’un statut, une seule fois, et lui redonne la main', async () => {
    const agent = await agentWithComputer('Statut');
    const conv = await mainConversationId(agent.id);
    const row = await requestSecureLogin({ agentId: agent.id, conversationId: conv, url: 'https://service.example/login', reason: 'Lire la facture' });
    const done = await resolveSecureLogin(row.id, 'authenticated');
    expect(done.status).toBe('authenticated');
    expect(await withDesktopAgent(agent.id, humanControl)).toBe(false);
    expect(await pendingSecureLogin(agent.id)).toBeNull();
    const jobs = await wakes(agent.id);
    expect(jobs).toHaveLength(1);
    const payload = jobs[0].payload as { text: string; event: { title: string } };
    expect(payload.text).toContain('status = authenticated');
    expect(payload.text).toContain('never ask for or repeat any credential');
    expect(payload.event.title).toBe('Connexion : service.example');
    // Une seconde réponse (double clic, second appareil) ne change rien et ne réveille personne.
    expect((await resolveSecureLogin(row.id, 'cancelled')).status).toBe('authenticated');
    expect(await wakes(agent.id)).toHaveLength(1);
    // La table ne peut contenir aucun secret : seules ces colonnes existent.
    expect(Object.keys((await getSecureLogin(row.id))!).sort()).toEqual(['agentId', 'conversationId', 'createdAt', 'id', 'origin', 'reason', 'resolvedAt', 'status', 'taskId', 'url']);
  });

  it('expire une demande restée sans réponse et le dit au compagnon', async () => {
    const agent = await agentWithComputer('Expiration');
    const row = await requestSecureLogin({ agentId: agent.id, conversationId: await mainConversationId(agent.id), url: 'https://service.example/login', reason: 'x' });
    expect(await expireSecureLogins(Date.now())).toBe(0);
    expect(await expireSecureLogins(Date.now() + SECURE_LOGIN_TTL_MS + 60_000)).toBe(1);
    expect((await getSecureLogin(row.id))!.status).toBe('expired');
    expect(await withDesktopAgent(agent.id, humanControl)).toBe(false);
    expect(((await wakes(agent.id))[0].payload as { text: string }).text).toContain('status = expired');
  });

  it('suspend seulement la tâche concernée, puis la reprend avec le statut', async () => {
    const agent = await agentWithComputer('Worker');
    const conv = await mainConversationId(agent.id);
    const task = await createTask({ agentId: agent.id, conversationId: conv, title: 'Facture', instruction: 'Télécharge la facture.', requestedBy: 'agent' });
    let i = 0;
    model = new MockLanguageModelV4({ doStream: async () => [
      () => reply([call('request_secure_login', { url: 'https://service.example/login', reason: 'Télécharger la facture' }, 'a')], true),
      () => reply(text('Une connexion est nécessaire pour continuer.'), false),
    ][Math.min(i++, 1)]() });
    await runTask(task.id);
    const waiting = (await getTask(task.id))!;
    expect(waiting.status).toBe('waiting_for_user');
    expect(waiting.blocker).toBe('Connexion requise sur https://service.example');
    const login = (await pendingSecureLogin(agent.id))!;
    expect(login.taskId).toBe(task.id);
    await resolveSecureLogin(login.id, 'authenticated');
    expect((await getTask(task.id))!.status).toBe('running');
    const prompts: string[] = [];
    model = new MockLanguageModelV4({ doStream: async (options: any) => { prompts.push(JSON.stringify(options.prompt)); return reply(text('Facture téléchargée.'), false); } });
    await runTask(task.id);
    expect(prompts[0]).toContain('status = authenticated');
    expect((await getTask(task.id))!.status).toBe('completed');
    // Reprise par la tâche, pas par un réveil du compagnon en plus.
    expect(await wakes(agent.id)).toHaveLength(0);
  });
});
