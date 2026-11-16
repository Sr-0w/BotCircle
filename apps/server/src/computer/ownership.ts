import { and, eq } from 'drizzle-orm';
import { accountKey } from '../auth/context.ts';
import { db, schema } from '../db/client.ts';
import { KeyedMutex } from '../util.ts';

/**
 * One controller at a time on a companion's computer (#61). Tools that change its state (clicks, keys, shell) are
 * enforced here, at execution, not by the prompt:
 * - while a worker task of the companion is running, the computer belongs to that task: the conversation can watch
 *   (screenshots, inspection) and steer the task, but cannot act on the computer itself, even if the task was
 *   started during the same turn;
 * - every state-changing action of any executor of the companion runs one at a time, so two commands never
 *   interleave on the same desktop.
 */
export const COMPUTER_CONTROL_TOOLS = ['computer_action', 'computer_target', 'computer_keyboard', 'shell_exec'] as const;

const control = new KeyedMutex();

export async function runningWorkerTask(agentId: string) {
  const [row] = await db().select({ id: schema.tasks.id, title: schema.tasks.title }).from(schema.tasks)
    .where(and(eq(schema.tasks.agentId, agentId), eq(schema.tasks.status, 'running'), eq(schema.tasks.provider, 'worker'))).limit(1);
  return row ?? null;
}

type ExecutableTool = { execute?: (...args: any[]) => any };

export function guardComputerControl(tools: Record<string, ExecutableTool | undefined>, agentId: string, owner: { taskId?: string }) {
  for (const name of COMPUTER_CONTROL_TOOLS) {
    const item = tools[name];
    if (typeof item?.execute !== 'function') continue;
    const execute = item.execute;
    item.execute = async (input: unknown, options: unknown) => {
      if (!owner.taskId) {
        const task = await runningWorkerTask(agentId);
        if (task) return {
          ok: false,
          status: 'computer_owned_by_task',
          taskId: task.id,
          error: `Ton ordinateur est piloté par ta tâche « ${task.title} » (${task.id}). Tu as délégué ce travail : ne le fais pas toi-même et n'agis pas sur cet ordinateur en parallèle. Suis-la avec task_status, transmets une consigne avec task_send_instruction, ou mets-la en pause si l'utilisateur te demande d'intervenir toi-même.`,
        };
      }
      return control.run(`${accountKey()}:${agentId}`, () => execute(input, options));
    };
  }
}
