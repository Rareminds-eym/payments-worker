/**
 * User authentication helper - validates Supabase JWT from Authorization header
 */

import type { Env } from '../types';
import { createSupabaseClient } from './supabase';

export interface AuthResult {
  user: { id: string; email?: string; user_metadata?: Record<string, unknown> };
}

export async function authenticateUser(request: Request, env: Env): Promise<AuthResult | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const supabase = createSupabaseClient(env, authHeader);
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  return { user };
}
