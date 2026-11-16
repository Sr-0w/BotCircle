/**
 * #62 / #63 with a REAL model, through the real job queue: a general chat asks @Ari, Ari answers as a task, and the
 * chat's assistant resumes by itself with Ari's real answer. Ari's own thread shows the request and the answer.
 *
 *   OPENROUTER_API_KEY=… pnpm --filter @opendots/server exec tsx scripts/live-chat-handoff-check.ts
 *
 * Isolated: temporary data folder, in-memory database. No computer needed.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.log('OPENROUTER_API_KEY absent : essai ignoré.'); process.exit(0); }
const MODEL = { provider: 'openrouter' as const, model: process.env.OPENDOTS_LIVE_MODEL ?? 'z-ai/glm-5.3-flash', reasoning: 'low' as const };
const dir = await mkdtemp(join(tmpdir(), 'bc-live-handoff-'));
process.env.OPENDOTS_DATA_DIR = dir;

const { openDatabase, closeDatabase } = await import('../src/db/client.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { loadMessages, messageText } = await import('../src/conversations/repo.ts');
const { createChat } = await import('../src/chats/repo.ts');
const { runChatTurn } = await import('../src/chats/turn.ts');
const { startQueue, stopQueue } = await import('../src/jobs/queue.ts');
const { registerLifeHandlers } = await import('../src/life/engine.ts');

await openDatabase({ memory: true });
await setOpenRouterKey(key);
await setSetting('onboarding.done', true);
await setSetting('models.default', MODEL);
await setSetting('engine.turnStepLimit', 20);
registerLifeHandlers();
await startQueue();

let failed = false;
try {
  const ari = await createAgent({ name: 'Ari', description: 'Compagnon de test.' });
  const chat = await createChat();
  const sent = await runChatTurn(chat.id, { id: 'msg_live_chat', role: 'user', parts: [{ type: 'text', text: '@Ari quel est le résultat de 17 × 23 ? Donne seulement le nombre. Ensuite je voudrais savoir s’il est pair.' }] }).done;
  assert.equal(sent.interventions.length, 1, 'une intervention attendue');

  // Wait for Ari's answer AND the chat's own continuation, with no new user message.
  let thread = (await loadMessages(chat.id)).messages;
  const started = Date.now();
  const resumed = () => {
    const iAri = thread.findIndex((m) => m.role === 'assistant' && m.metadata?.agentId === ari.id);
    return iAri >= 0 && thread.slice(iAri + 1).some((m) => m.role === 'assistant' && !m.metadata?.agentId && messageText(m).trim());
  };
  while (!resumed() && Date.now() - started < 240_000) { await new Promise((r) => setTimeout(r, 2000)); thread = (await loadMessages(chat.id)).messages; }
  console.log(thread.map((m) => `${m.role}${m.metadata?.agentId ? '(Ari)' : ''}: ${messageText(m).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n'));
  assert.ok(resumed(), 'le chat devait reprendre seul après la réponse d’Ari');
  assert.equal(thread.filter((m) => m.role === 'user').length, 1, 'aucun message utilisateur ajouté');
  const continuation = messageText(thread.at(-1)!);
  assert.match(continuation, /391/, 'la reprise doit s’appuyer sur le vrai résultat');
  assert.match(continuation, /impair/i, 'la reprise doit poursuivre la demande (parité)');

  const own = (await loadMessages(await mainConversationId(ari.id))).messages;
  assert.ok(own.some((m) => m.metadata?.event?.type === 'chat_request' && m.metadata.event.chatId === chat.id), 'demande visible dans le fil d’Ari');
  assert.ok(own.some((m) => m.metadata?.event?.type === 'chat_reply' && /391/.test(messageText(m))), 'réponse visible dans le fil d’Ari');
  console.log(`✓ passage réel chat → Ari → reprise du chat (${continuation.replace(/\s+/g, ' ').slice(0, 160)})`);
} catch (error) {
  failed = true;
  console.log(`✗ passage réel — ${(error as Error).message}`);
} finally {
  await stopQueue().catch(() => {});
  await closeDatabase().catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
