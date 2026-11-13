import { trackUserCard } from '../team/handoff.ts';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolContext } from '../agents/tools.ts';
import { waitForUser } from '../tasks/service.ts';
import { requestSecureLogin, SecureLoginError } from './service.ts';

/** L'outil par lequel un compagnon signale une page de connexion. Il ne transporte aucun secret, dans aucun sens. */
export function secureLoginTools(ctx: ToolContext): ToolSet {
  return {
    request_secure_login: tool({
      description:
        "Quand une page de ton navigateur exige une connexion (identifiant, mot de passe, code 2FA, passkey, SSO, CAPTCHA) : appelle cet outil avec l'URL exacte de la page et la raison. " +
        "L'utilisateur voit une carte de confiance, prend la main sur ton navigateur et s'authentifie lui-même ; tes outils d'ordinateur sont suspendus pendant ce temps. " +
        "Tu ne reçois ensuite qu'un statut (authenticated, cancelled, failed, expired). Ne demande JAMAIS un identifiant, un mot de passe ou un code dans la conversation, et ne tente jamais de les saisir toi-même. " +
        "Après l'appel, arrête-toi : dis en une phrase qu'une connexion est nécessaire, puis attends.",
      inputSchema: z.object({
        url: z.string().min(1).max(2000).describe('URL exacte de la page de connexion affichée'),
        reason: z.string().min(1).max(500).describe('Pourquoi cette connexion est nécessaire à la tâche, sans aucun secret'),
      }).strict(),
      execute: async ({ url, reason }) => {
        try {
          const row = await requestSecureLogin({ agentId: ctx.agent.id, conversationId: ctx.conversationId, taskId: ctx.taskId ?? null, url, reason }, ctx.delegation);
          if (ctx.taskId) await waitForUser(ctx.taskId, `Connexion requise sur ${row.origin}`);
          const output = { ok: true as const, status: 'waiting_for_secure_login', loginId: row.id, origin: row.origin, note: 'The user is signing in themselves. Your computer tools are suspended until they hand control back. Stop now and wait; you will be told the outcome.' };
          await trackUserCard(ctx, { kind: 'secure_login', detail: `Il te demande de te connecter sur ${row.origin}.`, tool: 'request_secure_login', output });
          return output;
        } catch (error) {
          if (error instanceof SecureLoginError) return { ok: false as const, status: 'rejected', error: error.message };
          throw error;
        }
      },
    }),
  };
}
