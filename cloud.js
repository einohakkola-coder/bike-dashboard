// Login + cloud storage via Supabase. Disabled until config.js is filled in.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const enabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
let sb = null;

export async function init() {
  if (!enabled) return null;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

// returns { user, session } — session is null when the project requires email confirmation
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await sb.auth.signOut();
}

export async function pull(userId) {
  const { data, error } = await sb.from('user_data').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function push(userId, blob) {
  const { error } = await sb.from('user_data').upsert({
    user_id: userId,
    routes: blob.routes,
    rides: blob.rides,
    settings: blob.settings,
    updated_at: new Date(blob.updatedAt || Date.now()).toISOString()
  });
  if (error) throw error;
}
