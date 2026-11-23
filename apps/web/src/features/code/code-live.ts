import { ACTIVE_TASK_STATUSES, type TaskDTO } from '@opendots/shared';
import { useStore } from '@/lib/store';

export type CodeFilter = 'all' | 'mine' | 'circles';

/** A coding session counts as live while OpenCode can still work or needs Robin, and its machine answers. */
export function isLiveCodeSession(task: TaskDTO) {
  return task.provider === 'opencode' && ACTIVE_TASK_STATUSES.includes(task.status) && !task.external?.unreachable;
}

/** #72: the real number of live coding sessions, for the sidebar's Code item (no decorative count). */
export function useLiveCodeSessions() {
  return useStore((s) => s.tasks.filter(isLiveCodeSession).length);
}
