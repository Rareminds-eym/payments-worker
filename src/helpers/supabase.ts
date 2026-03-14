/**
 * Supabase helper for razorpay-api worker
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';

export function createSupabaseAdmin(env: Env): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key, { auth: { persistSession: false } });
}

export function createSupabaseClient(env: Env, authHeader: string): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
}
