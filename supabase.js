const { createClient } = require('@supabase/supabase-js');

// Credenciales de tu proyecto de Academia de Música en Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'https://pbsgeaiianihotqvesdw.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_BLRoDcdyjK8XXF854573Nw_wEFbm5Ln';

if (!supabaseUrl || !supabaseKey || supabaseKey.includes('PEGA_AQUI')) {
  console.warn('⚠️ Advertencia: Configura tu SUPABASE_KEY completa en supabase.js o en variables de entorno.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

module.exports = supabase;