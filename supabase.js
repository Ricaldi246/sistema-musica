const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://pbsgeaiianihotqvesdw.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en las variables de entorno.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

module.exports = supabase;
