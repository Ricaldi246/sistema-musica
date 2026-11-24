// ARCHIVO: supabase.js
// Sirve para conectar el servidor (server.js) con la base de datos Supabase.
// Solo se crea la conexión aquí y se exporta para que server.js la use con require('./supabase').
// No es necesario tocarlo, salvo que cambies de proyecto de Supabase.
// Trae la herramienta oficial de Supabase (instalada con npm install @supabase/supabase-js).
const { createClient } = require('@supabase/supabase-js');

// Dirección (URL) de tu proyecto en Supabase. Primero busca SUPABASE_URL en el archivo .env;
// si no existe, usa la dirección escrita aquí. Cambia el texto entre comillas si usas otro proyecto.
const supabaseUrl = process.env.SUPABASE_URL || 'https://pbsgeaiianihotqvesdw.supabase.co';
// Llave secreta para entrar a la base de datos. Se lee del archivo .env (SUPABASE_SERVICE_KEY).
// NUNCA la escribas directamente aquí ni la compartas.
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// Si falta la URL o la llave, muestra este aviso en la consola para que sepas que debes revisar el .env.
if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en las variables de entorno.');
}

// Crea la conexión con la base de datos usando la URL y la llave de arriba.
const supabase = createClient(supabaseUrl, supabaseKey, {
  // Opciones de autenticación de Supabase: se desactivan porque las sesiones las maneja server.js con su propia tabla.
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

// Comparte la conexión con otros archivos (server.js hace: const supabase = require('./supabase')).
module.exports = supabase;