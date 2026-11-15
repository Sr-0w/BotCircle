import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolContext } from '../agents/tools.ts';
import { getTask, listTasks, cancelTask, TaskError, type TaskRow } from '../tasks/service.ts';
import { errorMessage } from '../util.ts';
import { OpencodeHttpError, OpencodeUnreachable } from './client.ts';
import { checkInstance, findInstance, instanceProjects, instanceSessions, instructOpencode, listInstances, OpencodeError, sessionDiffs, startOpencodeTask, syncTask, type InstanceRow } from './service.ts';

const fail = (error: unknown) => {
  if (error instanceof OpencodeUnreachable) return { ok: false as const, status: 'unreachable', error: `${error.message} L'état de la machine est inconnu : ne conclus ni à un succès ni à un échec.` };
  if (error instanceof OpencodeHttpError || error instanceof OpencodeError || error instanceof TaskError) return { ok: false as const, status: 'rejected', error: error.message };
  return { ok: false as const, status: 'failed', error: errorMessage(error) };
};

/** Outils par lesquels un compagnon autorisé délègue du développement à OpenCode et suit la même session. */
export function opencodeTools(ctx: ToolContext): ToolSet {
  /** Sans nom : la seule instance connectée. Plusieurs instances : le compagnon doit choisir, jamais deviner. */
  async function pick(ref?: string): Promise<InstanceRow> {
    const all = await listInstances();
    if (!all.length) throw new OpencodeError('Aucune instance OpenCode n’est connectée. L’utilisateur lance `opencode pair --remote` sur sa machine, puis colle le lien (ou scanne le QR code) dans Paramètres → OpenCode → Jumeler. Un mot de passe ne se donne jamais dans la conversation.');
    if (ref) { const found = await findInstance(ref); if (!found) throw new OpencodeError(`Instance « ${ref} » inconnue. Instances : ${all.map((i) => i.name).join(', ')}.`); return found; }
    if (all.length > 1) throw new OpencodeError(`Plusieurs instances sont connectées (${all.map((i) => i.name).join(', ')}) : demande à l'utilisateur laquelle utiliser, puis précise instance.`);
    return all[0];
  }
  async function mine(taskId?: string): Promise<TaskRow> {
    const row = taskId ? await getTask(taskId) : (await listTasks({ agentId: ctx.agent.id, limit: 20 })).find((t) => t.provider === 'opencode');
    if (!row || row.agentId !== ctx.agent.id || row.provider !== 'opencode') throw new OpencodeError('Aucune tâche OpenCode correspondante.');
    return row;
  }
  const observed = (t: TaskRow) => ({ taskId: t.id, title: t.title, status: t.status, phase: t.phase, currentAction: t.currentAction, completedSteps: t.completedSteps, blocker: t.blocker, result: t.result, error: t.error, sessionId: t.external?.sessionId, directory: t.external?.directory, stateKnown: !t.external?.unreachable, note: 'Observed on the instance just now; anything else is unknown.' });

  return {
    opencode_instances: tool({
      description: "Liste les instances OpenCode connectées par l'utilisateur (machines de développement), avec leur état réel contrôlé à l'instant : en ligne ou injoignable, version, dossier par défaut, tâches en cours.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        try {
          const rows = await Promise.all((await listInstances()).map(checkInstance));
          return { ok: true as const, instances: rows.map((i) => ({ name: i.name, online: !i.lastError, error: i.lastError, version: i.version, defaultDirectory: i.defaultDirectory })) };
        } catch (error) { return fail(error); }
      },
    }),
    opencode_projects: tool({
      description: "Projets connus d'une instance OpenCode et, pour un dossier, ses sessions récentes (y compris celles créées hors d'BotCircle). Sert à choisir le bon projet ou à retrouver une session à poursuivre.",
      inputSchema: z.object({ instance: z.string().optional().describe('Nom de l’instance ; inutile s’il n’y en a qu’une'), directory: z.string().optional().describe('Dossier du projet dont lister les sessions') }).strict(),
      execute: async ({ instance, directory }) => {
        try {
          const row = await pick(instance);
          const [projects, sessions] = await Promise.all([instanceProjects(row), instanceSessions(row, directory)]);
          return { ok: true as const, instance: row.name, projects: projects.slice(0, 30), sessions: sessions.slice(0, 20).map((s) => ({ sessionId: s.id, title: s.title, directory: s.directory, busy: s.busy, changedFiles: s.files })) };
        } catch (error) { return fail(error); }
      },
    }),
    opencode_start: tool({
      description:
        "Confie une tâche de développement à OpenCode (correction, fonctionnalité, revue, tests) : il travaille sur la machine de l'utilisateur, en arrière-plan, et la conversation reste disponible. " +
        "Une carte unique s'affiche et se met à jour ; le résultat réel te sera remis à la fin. L'instruction doit être complète et autonome (objectif, contraintes, fichiers, critères d'acceptation) : OpenCode ne voit pas cette conversation. " +
        "N'y mets que ce qui est utile à la tâche, jamais de secret. session_id poursuit une session existante au lieu d'en créer une. Réponds ensuite en une phrase, sans décrire un travail que tu n'as pas observé.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe('Titre court affiché sur la carte'),
        instruction: z.string().min(1).max(12000).describe('Consigne complète réellement envoyée à OpenCode'),
        user_request: z.string().max(4000).optional().describe("La demande d'origine de l'utilisateur, mot pour mot, si ta consigne la reformule ou la complète"),
        instance: z.string().optional().describe('Nom de l’instance ; inutile s’il n’y en a qu’une'),
        directory: z.string().optional().describe('Dossier du projet sur la machine ; par défaut celui de l’instance'),
        session_id: z.string().optional().describe('Session OpenCode existante à poursuivre'),
      }).strict(),
      execute: async ({ title, instruction, user_request, instance, directory, session_id }) => {
        try {
          const row = await startOpencodeTask({ agentId: ctx.agent.id, conversationId: ctx.conversationId, instance: await pick(instance), directory, sessionId: session_id, title, instruction, original: user_request, requestedBy: 'agent' });
          return { ok: true as const, status: row.status, taskId: row.id, title: row.title, sessionId: row.external!.sessionId, note: 'The instruction was accepted by the instance. You will be handed the real result when the session stops; do not announce any result before that.' };
        } catch (error) { return fail(error); }
      },
    }),
    opencode_status: tool({
      description: "État RÉEL d'une tâche OpenCode, relu sur l'instance à l'instant : en cours, en attente d'une autorisation, terminée, ou inconnu si la machine est injoignable. À appeler quand l'utilisateur demande où ça en est. Sans task_id : ta tâche OpenCode la plus récente.",
      inputSchema: z.object({ task_id: z.string().optional() }).strict(),
      execute: async ({ task_id }) => { try { const row = await mine(task_id); await syncTask(row); return { ok: true as const, ...observed((await getTask(row.id))!) }; } catch (error) { return fail(error); } },
    }),
    opencode_send: tool({
      description:
        "Envoie une consigne à LA MÊME session OpenCode : précision, contrainte, correction, « lance les tests », ou suite après la fin. " +
        "Elle n'interrompt jamais l'étape en cours : dis « je lui ai transmis », pas « il s'est arrêté ». Si la session était terminée, elle repart dans le même contexte.",
      inputSchema: z.object({
        task_id: z.string().optional(), instruction: z.string().min(1).max(8000),
        user_request: z.string().max(4000).optional().describe("Les mots de l'utilisateur, si tu les reformules"),
        mode: z.enum(['steer', 'queue']).optional().describe("Si la session travaille (OpenCode 2) : steer = intégrée au travail en cours dès son étape suivante (une correction, une contrainte) ; queue = traitée après la fin du travail en cours (une tâche de plus). Par défaut steer."),
      }).strict(),
      execute: async ({ task_id, instruction, user_request, mode }) => {
        try {
          const row = await mine(task_id);
          const { queued, delivery } = await instructOpencode(row, instruction, 'companion', user_request, mode ?? 'steer');
          return { ok: true as const, delivered: true, queued, delivery, taskId: row.id, note: !queued ? 'The session was idle and has been restarted with this instruction.' : delivery === 'steer' ? 'Folded into the work in progress from its next step; nothing was interrupted.' : 'Queued: handled after the current work ends; it does not interrupt it.' };
        } catch (error) { return fail(error); }
      },
    }),
    opencode_stop: tool({
      description: "Arrête l'exécution d'une tâche OpenCode. N'annonce l'arrêt que si le résultat le confirme : si la machine est injoignable, l'arrêt n'a pas été transmis.",
      inputSchema: z.object({ task_id: z.string().optional() }).strict(),
      execute: async ({ task_id }) => { try { const row = await mine(task_id); return { ok: true as const, ...observed(await cancelTask(row.id)) }; } catch (error) { return fail(error); } },
    }),
    opencode_changes: tool({
      description: "Fichiers réellement modifiés par la session OpenCode d'une tâche, avec les lignes ajoutées et retirées, et un extrait du diff. Sert à relire le travail avant d'en parler.",
      inputSchema: z.object({ task_id: z.string().optional(), file: z.string().optional().describe('Chemin exact pour obtenir le diff complet de ce fichier') }).strict(),
      execute: async ({ task_id, file }) => {
        try {
          const diffs = await sessionDiffs(await mine(task_id));
          if (file) { const one = diffs.find((d) => d.path === file); return one ? { ok: true as const, file: one.path, status: one.status, patch: one.patch.slice(0, 20_000) } : { ok: false as const, status: 'not_found', error: 'Ce fichier ne fait pas partie des changements de la session.' }; }
          return { ok: true as const, files: diffs.map((d) => ({ path: d.path, status: d.status, additions: d.additions, deletions: d.deletions })), note: diffs.length ? undefined : 'OpenCode reports no changed file for this session.' };
        } catch (error) { return fail(error); }
      },
    }),
  };
}
