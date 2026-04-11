import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://adfnabuwzmojxbhcpdpe.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkZm5hYnV3em1vanhiaGNwZHBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MTcxODcsImV4cCI6MjA5MTA5MzE4N30.sU9EZAnQ2mClIsMwfccR5__nbTYnfzkt3IvP-llxpno';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
