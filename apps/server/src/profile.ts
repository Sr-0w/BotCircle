import { getSetting, setSetting } from './settings.ts';

/** #54: how the user wants to be called. Per account (each account has its own database); both parts optional. */
export interface UserProfile { firstName: string | null; lastName: string | null }

const clean = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return text || null;
};

export async function getUserProfile(): Promise<UserProfile> {
  const stored = await getSetting('user.profile');
  return { firstName: stored?.firstName ?? null, lastName: stored?.lastName ?? null };
}

export async function setUserProfile(input: { firstName?: unknown; lastName?: unknown }): Promise<UserProfile> {
  const profile = { firstName: clean(input.firstName), lastName: clean(input.lastName) };
  await setSetting('user.profile', profile);
  return profile;
}

/**
 * Trusted, user-scoped context for every agent working for this user (Circles, workers, general chats). Guidance,
 * not an order: the user's own wishes in a conversation come first. Without a name, agents must not guess one.
 */
export function userContext(profile: UserProfile): string {
  if (!profile.firstName && !profile.lastName) return `The user has not given their name. Do not guess it (not from an email address, an account or a file); if it matters, you may ask.`;
  const full = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  return profile.firstName
    ? `The user's name, as they set it in their BotCircle profile: ${full}. Call them by their first name, ${profile.firstName}, in ordinary conversation, not by their full name. If they ask to be addressed differently, do as they ask.`
    : `The user's last name, as they set it in their BotCircle profile: ${profile.lastName}. They gave no first name: do not invent one. If they ask to be addressed differently, do as they ask.`;
}
