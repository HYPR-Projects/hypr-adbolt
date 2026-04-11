import { create } from 'zustand';
import { supabase } from '@/services/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  isLoading: true,
  error: null,

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (session?.user) {
        const validated = validateUser(session.user);
        if (validated) {
          set({ user: session.user, session, isLoading: false });
          return;
        }
        // Invalid domain — sign out
        await supabase.auth.signOut();
      }

      // Listen for auth state changes (handles redirect callback)
      supabase.auth.onAuthStateChange((_event, session) => {
        if (_event === 'SIGNED_IN' && session?.user) {
          const validated = validateUser(session.user);
          if (validated) {
            set({ user: session.user, session, isLoading: false, error: null });
          } else {
            supabase.auth.signOut();
            set({
              user: null,
              session: null,
              isLoading: false,
              error: `Acesso restrito a @hypr.mobi. Você entrou com: ${session.user.email}`,
            });
          }
        }
        if (_event === 'SIGNED_OUT') {
          set({ user: null, session: null });
        }
      });

      set({ isLoading: false });
    } catch (e) {
      console.error('Auth init error:', e);
      set({ isLoading: false });
    }
  },

  loginWithGoogle: async () => {
    set({ error: null });
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { hd: 'hypr.mobi' },
      },
    });
    if (error) {
      set({ error: 'Erro: ' + error.message });
    }
  },

  logout: async () => {
    await supabase.auth.signOut();
    set({ user: null, session: null });
  },

  clearError: () => set({ error: null }),
}));

// ── Helpers ──

function validateUser(user: User): boolean {
  return !!user.email?.endsWith('@hypr.mobi');
}

/** Get display name from user metadata */
export function getUserDisplayName(user: User | null): string {
  if (!user) return '';
  const meta = user.user_metadata || {};
  return meta.full_name || meta.name || user.email || '';
}

/** Get avatar URL from user metadata */
export function getUserAvatarUrl(user: User | null): string {
  if (!user) return '';
  const meta = user.user_metadata || {};
  return meta.avatar_url || meta.picture || '';
}

/** Get initials from display name */
export function getUserInitials(user: User | null): string {
  const name = getUserDisplayName(user);
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
}
