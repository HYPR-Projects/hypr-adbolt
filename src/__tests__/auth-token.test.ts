import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase BEFORE importing the module under test
vi.mock('@/services/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

import { getFreshToken } from '@/lib/auth-token';
import { supabase } from '@/services/supabase';

describe('getFreshToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the access_token from the current session', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'fresh-token-abc' } },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    const token = await getFreshToken();
    expect(token).toBe('fresh-token-abc');
  });

  it('always queries the current session (no caching)', async () => {
    // Token muda entre chamadas — simula refresh background
    vi.mocked(supabase.auth.getSession)
      .mockResolvedValueOnce({
        data: { session: { access_token: 'token-1' } },
        error: null,
      } as Awaited<ReturnType<typeof supabase.auth.getSession>>)
      .mockResolvedValueOnce({
        data: { session: { access_token: 'token-2' } },
        error: null,
      } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    const a = await getFreshToken();
    const b = await getFreshToken();
    expect(a).toBe('token-1');
    expect(b).toBe('token-2');
    expect(supabase.auth.getSession).toHaveBeenCalledTimes(2);
  });

  it('throws if session is null (logged out)', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    await expect(getFreshToken()).rejects.toThrow(/Sessão expirou/);
  });

  it('throws if getSession returns an error', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: { message: 'network error', name: 'AuthError' } as unknown as Error,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    await expect(getFreshToken()).rejects.toThrow(/Sessão expirou/);
  });

  it('throws if access_token is missing on the session', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: '' } },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    await expect(getFreshToken()).rejects.toThrow(/Sessão expirou/);
  });
});
