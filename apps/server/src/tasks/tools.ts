import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolContext } from '../agents/tools.ts';
import { errorMessage } from '../util.ts';
import { checkModel } from '../models/gateway.ts';
import { searchModels } from '../models/available.ts';
import { ArtifactError, artifactFor } from '../artifacts/service.ts';
import { addTaskEvent, cancelTask, createTask, getTask, listTasks, pauseTask, resumeTask, sendInstruction, taskEvents, TaskError, toTaskDTO, updateTask, waitForUser, type TaskRow } from './service.ts';

const fail = (error: unknown) => ({ ok: false as const, error: errorMessage(error) });

/** Ce que le compagnon a le droit d'affirmer sur une tâche : uniquement des données observées. */
async function observed(row: TaskRow) {
  const dto = await toTaskDTO(row);
  return {
    taskId: dto.id, title: dto.title, status: dto.status, phase: dto.phase, currentAction: dto.currentActionSummary,
    completedSteps: dto.completedSteps, totalSteps: dto.totalSteps, blocker: dto.blocker, requiresUserInput: dto.requiresUserInput,
    artifacts: dto.artifacts.map((a) => ({ id: a.id, name: a.name })), lastHeartbeat: dto.lastHeartbeat, startedAt: dto.startedAt, finishedAt: dto.finishedAt,
    result: dto.result, error: dto.error,
    recentSteps: (await taskEvents(row.id, 6)).map((e) => e.summary),
    note: 'Données observées au moment de l’appel. N’ajoute aucun pourcentage ni résultat qui n’y figure pas.',
  };
}

/** Outils du compagnon au premier plan : il délègue, suit et pilote ses workers. */
export function taskTools(ctx: ToolContext): ToolSet {
  const mine = async (taskId?: string): Promise<TaskRow> => {
    const row = taskId ? await getTask(taskId) : (await listTasks({ agentId: ctx.agent.id, limit: 1 }))[0];
    if (!row || row.agentId !== ctx.agent.id) throw new TaskError('Aucune tâche correspondante.');
    return row;
  };
  return {
    task_start: tool({
      description: "Confie un travail long à un worker en arrière-plan (bureau ou navigateur, recherche longue, code, traitement de fichiers) : la conversation reste disponible. L'instruction doit être complète et autonome : le worker ne voit pas cette conversation. Une carte de tâche s'affiche et le résultat arrivera ici à la fin. Réponds ensuite en une phrase, sans faire le travail toi-même.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe('Titre court affiché sur la carte'),
        instruction: z.string().min(1).max(8000).describe('Consigne complète : objectif, contraintes, résultat attendu'),
        artifacts: z.array(z.string()).max(8).optional().describe("Ids d'artefacts à remettre au worker"),
        model: z.object({ provider: z.enum(['openrouter', 'ollama', 'codex']), model: z.string().min(1) }).strict().optional()
          .describe("Modèle explicite pour cette tâche, seulement si l'utilisateur le demande ou si la tâche l'exige (vision, raisonnement). Choisis-le avec models_available. Sans : ton propre modèle."),
      }).strict(),
      execute: async ({ title, instruction, artifacts, model }) => {
        try {
          for (const id of artifacts ?? []) await artifactFor(ctx.agent.id, id);
          // An explicit model must exist and be usable: never a silent substitute.
          if (model) {
            const check = await checkModel(model);
            if (!check.ok) return { ok: false as const, status: 'model_unavailable', error: `${check.error ?? 'Modèle indisponible.'} Aucune tâche créée. Utilise models_available pour trouver un modèle valide, ou crée la tâche sans modèle (ton propre modèle).` };
          }
          const row = await createTask({ agentId: ctx.agent.id, conversationId: ctx.conversationId, title, instruction, requestedBy: 'agent', artifacts, model: model ?? null });
          return { ok: true, status: row.status, taskId: row.id, title: row.title, model: model ? `${model.provider}:${model.model}` : 'companion default' };
        } catch (error) { return error instanceof TaskError || error instanceof ArtifactError ? fail(error) : (() => { throw error; })(); }
      },
    }),
    models_available: tool({
      description: "Liste les modèles réellement disponibles (fournisseurs configurés), favoris de l'utilisateur en premier, avec ce qu'ils savent faire (outils, vision, raisonnement). À utiliser avant de choisir un modèle explicite pour une tâche.",
      inputSchema: z.object({ query: z.string().max(100).optional().describe('Filtre sur le nom ou l’identifiant (ex. "sonnet", "qwen", "vision")') }).strict(),
      execute: async ({ query }) => ({ ok: true, ...(await searchModels(query)) }),
    }),
    task_list: tool({
      description: 'Liste tes tâches récentes (en file, en cours, en pause, en attente, terminées) avec leur état réel.',
      inputSchema: z.object({}).strict(),
      execute: async () => ({ ok: true, tasks: (await listTasks({ agentId: ctx.agent.id, limit: 12 })).map((t) => ({ taskId: t.id, title: t.title, status: t.status, phase: t.phase, completedSteps: t.completedSteps, blocker: t.blocker })) }),
    }),
    task_status: tool({
      description: "Consulte l'état RÉEL d'une tâche, à l'instant : phase, action en cours, étapes exécutées, blocage, fichiers produits. À appeler chaque fois que l'utilisateur demande où ça en est. Sans task_id : ta tâche la plus récente.",
      inputSchema: z.object({ task_id: z.string().optional() }).strict(),
      execute: async ({ task_id }) => { try { return { ok: true, ...(await observed(await mine(task_id))) }; } catch (error) { return fail(error); } },
    }),
    task_send_instruction: tool({
      description: "Transmet au worker une nouvelle consigne de l'utilisateur (précision, contrainte, changement de priorité, réponse à sa question). Elle s'applique dès sa prochaine étape ; une tâche en pause ou en attente reprend.",
      inputSchema: z.object({ task_id: z.string(), instruction: z.string().min(1).max(2000) }).strict(),
      execute: async ({ task_id, instruction }) => { try { await mine(task_id); return { ok: true, delivered: true, ...(await observed(await sendInstruction(task_id, instruction))) }; } catch (error) { return fail(error); } },
    }),
    task_pause: tool({
      description: "Met une tâche en pause, à la demande de l'utilisateur. Le travail déjà fait est conservé.",
      inputSchema: z.object({ task_id: z.string() }).strict(),
      execute: async ({ task_id }) => { try { await mine(task_id); return { ok: true, ...(await observed(await pauseTask(task_id))) }; } catch (error) { return fail(error); } },
    }),
    task_resume: tool({
      description: 'Reprend une tâche en pause ou en attente.',
      inputSchema: z.object({ task_id: z.string() }).strict(),
      execute: async ({ task_id }) => { try { await mine(task_id); return { ok: true, ...(await observed(await resumeTask(task_id))) }; } catch (error) { return fail(error); } },
    }),
    task_cancel: tool({
      description: "Annule une tâche, à la demande de l'utilisateur : le worker s'arrête et libère le bureau.",
      inputSchema: z.object({ task_id: z.string() }).strict(),
      execute: async ({ task_id }) => { try { await mine(task_id); return { ok: true, ...(await observed(await cancelTask(task_id))) }; } catch (error) { return fail(error); } },
    }),
  };
}

/** Outil du worker : sa progression structurée, à la place de phrases dans le fil. */
export function workerTools(taskId: string): ToolSet {
  return {
    task_report: tool({
      description: "Signale où en est ta tâche : la phase en cours (quelques mots), et, si tu ne peux pas continuer sans l'utilisateur, requires_user_input avec le blocage précis. Les étapes sont comptées automatiquement : n'invente ni total ni pourcentage.",
      inputSchema: z.object({
        phase: z.string().min(1).max(120).describe('Phase en cours, ex. « Paramètres XFCE »'),
        total_steps: z.number().int().positive().max(1000).optional().describe('Seulement si le nombre total d’étapes est réellement connu'),
        requires_user_input: z.boolean().optional(),
        blocker: z.string().max(500).optional().describe('Ce qui te bloque, ou la question posée à l’utilisateur'),
      }).strict(),
      execute: async ({ phase, total_steps, requires_user_input, blocker }) => {
        if (requires_user_input) {
          await updateTask(taskId, { phase });
          await waitForUser(taskId, blocker?.trim() || 'Une précision de l’utilisateur est nécessaire.');
          return { ok: true, status: 'waiting_for_user', note: 'Tâche suspendue. Termine maintenant par une phrase qui explique ce dont tu as besoin.' };
        }
        await updateTask(taskId, { phase, ...(total_steps ? { totalSteps: total_steps } : {}), blocker: blocker?.trim() || null, lastHeartbeat: new Date() });
        await addTaskEvent(taskId, 'note', `Phase : ${phase}${blocker ? ` — ${blocker}` : ''}`);
        return { ok: true, status: 'running' };
      },
    }),
  };
}
