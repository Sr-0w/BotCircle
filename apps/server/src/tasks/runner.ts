import { artifactUrl, type MessageMetadata } from '@opendots/shared';
import { getAgent } from '../agents/repo.ts';
import { runTurn } from '../agents/turn.ts';
import { artifactsByIds } from '../artifacts/service.ts';
import { getConversation, saveMessage } from '../conversations/repo.ts';
import { log } from '../journal.ts';
import { errorMessage, newId, truncate } from '../util.ts';
import { addTaskEvent, getTask, startNextTask, updateTask, type TaskRow } from './service.ts';

/**
 * Exécute une tâche jusqu'à ce qu'elle rende la main : terminée, échouée, annulée, en pause ou en
 * attente de l'utilisateur. Appelé par la file de jobs, donc hors de toute requête HTTP : fermer
 * l'application ou perdre le réseau n'arrête rien.
 */
export async function runTask(taskId: string) {
  const task = await getTask(taskId);
  if (!task || task.status !== 'running') return;
  const agent = await getAgent(task.agentId);
  if (!agent || agent.archived) { await conclude(task, 'failed', { error: 'Compagnon introuvable.' }); return; }

  // Reprise : après une pause, une attente, ou un redémarrage du serveur en cours de tâche.
  const resumed = task.completedSteps > 0;
  if (resumed) await addTaskEvent(taskId, 'status', 'Reprise du travail');
  let result;
  try {
    result = await runTurn(task.agentId, task.workConversationId, {
      kind: 'task', taskId,
      note: resumed ? 'Le travail a été interrompu (pause, attente de l’utilisateur ou redémarrage du serveur). Reprends là où tu t’étais arrêté : vérifie l’état réel avant de refaire une action, et tiens compte des consignes ajoutées.' : undefined,
    }).done;
  } catch (error) {
    result = { messageId: null, text: '', silent: true, error: errorMessage(error) };
  }

  const after = await getTask(taskId);
  if (!after) return;
  // Annulée ou mise en pause pendant l'exécution : l'état a déjà été posé par l'action de l'utilisateur.
  if (after.status === 'cancelled' || after.status === 'paused') { await startNextTask(after.agentId); return; }
  if (after.status === 'waiting_for_user') {
    await post(after, result.text.trim() || after.blocker || 'J’ai besoin de toi pour continuer.');
    await startNextTask(after.agentId);
    return;
  }
  // Arrêt imposé par un garde-fou (boucle, budget) : c'est un échec, avec le compte rendu du worker.
  if (after.error) await conclude(after, 'failed', { error: `${after.error}${result.text.trim() ? ` ${result.text.trim()}` : ''}` });
  else if (result.error) await conclude(after, 'failed', { error: result.error });
  else await conclude(after, 'completed', { result: result.text.trim() });
}

async function conclude(task: TaskRow, status: 'completed' | 'failed', outcome: { result?: string; error?: string }) {
  const done = await updateTask(task.id, { status, result: outcome.result ?? null, error: outcome.error ? truncate(outcome.error, 1000) : null, finishedAt: new Date(), currentAction: null, requiresUserInput: false });
  await addTaskEvent(task.id, status === 'completed' ? 'status' : 'error', status === 'completed' ? 'Terminée' : `Échec : ${truncate(outcome.error ?? '', 300)}`);
  await log(task.agentId, `task.${status}`, `${status === 'completed' ? 'Tâche terminée' : 'Tâche échouée'} : ${task.title}`, { taskId: task.id });
  await post(done, status === 'completed'
    ? outcome.result || `La tâche « ${task.title} » est terminée.`
    : `La tâche « ${task.title} » n'a pas abouti : ${truncate(outcome.error ?? 'erreur inconnue', 600)}`);
  await startNextTask(task.agentId);
}

/**
 * Un seul message dans la conversation d'origine par événement utile (résultat, échec, blocage), signé du
 * compagnon, avec les fichiers réellement produits en pièces jointes.
 */
async function post(task: TaskRow, text: string) {
  if (!await getConversation(task.conversationId)) return;
  const files = task.status === 'completed' ? await artifactsByIds(task.artifacts) : [];
  const metadata: MessageMetadata = { kind: 'chat', agentId: task.agentId, autonomous: true, createdAt: new Date().toISOString(), taskId: task.id };
  await saveMessage(task.conversationId, {
    id: newId('msg'), role: 'assistant',
    parts: [{ type: 'text', text }, ...files.map((a) => ({ type: 'file' as const, url: artifactUrl(a.id), filename: a.name, mediaType: a.mediaType }))],
    metadata,
  }, { author: 'agent', agentId: task.agentId });
}
