import { ACTIVE_TASK_STATUSES, type TaskDTO } from '@opendots/shared';

export function codeSessionKey(task: TaskDTO) {
  return task.external?.instanceId && task.external.sessionId
    ? JSON.stringify([task.external.instanceId, task.external.sessionId])
    : task.id;
}

export function canonicalCodeTasks(tasks: readonly TaskDTO[]) {
  const sessions = new Map<string, TaskDTO>();
  for (const task of tasks) {
    if (task.provider !== 'opencode') continue;
    const key = codeSessionKey(task);
    const previous = sessions.get(key);
    if (!previous || task.createdAt > previous.createdAt || (task.createdAt === previous.createdAt && task.id > previous.id)) {
      sessions.set(key, task);
    }
  }
  return [...sessions.values()];
}

export function codeStatus(task: TaskDTO, synchronized: boolean) {
  if (ACTIVE_TASK_STATUSES.includes(task.status) && (!synchronized || task.external?.unreachable)) return 'disconnected';
  if (task.status === 'paused' && task.external?.quota?.kind === 'quota') return 'quota';
  if (task.status === 'waiting_for_user' && task.phase === 'Action requise') return 'attention';
  if (task.status === 'waiting_for_user' && task.blocker?.startsWith('OpenCode pose une question')) return 'question';
  return task.status;
}

export const isActiveCode = (task: TaskDTO) => ACTIVE_TASK_STATUSES.includes(task.status);
export const isFinishedCode = (task: TaskDTO) => (['completed', 'failed', 'cancelled'] as const).find((status) => status === task.status);
export const CODE_ACTIVITY_GRACE_MS = 3200;
