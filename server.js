const supabase = require('./supabase');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// nodemailer es opcional: hasta que no hagas "npm install nodemailer" y configures el
// SMTP en el .env, "Olvidé mi contraseña" sigue funcionando, solo que no envía el correo
// (el enlace queda escrito en esta consola, para que puedas probarlo tú mismo).
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* aún no instalado */ }

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================================
//  CONFIGURACIÓN DE TARIFAS  (cámbialas a tu gusto)
// =====================================================================
const CONFIG = {
    moneda: 'Bs',
    tarifaRetrasoPorDia: 10,      // cobro por cada día de retraso (o fracción)
    horasGracia: 1,               // horas de tolerancia antes de cobrar retraso
    topeMultaRetraso: 100,        // la multa por retraso nunca supera este monto
    adelantoReserva: 25,          // adelanto fijo de la reserva virtual
    multasDano: {                 // escala de daños
        'Ninguno': 0,
        'Leve': 20,
        'Moderado': 50,
        'Grave': 150,
        'Pérdida': 500
    }
};
const ESTADOS_FISICOS = ['Óptimo', 'Desgaste regular', 'En reparación'];
const TIPOS_SOLICITANTE = ['Alumno', 'Profesor', 'Persona común'];

app.use(express.json({ limit: '10mb' }));

// Si existe la carpeta "frontend" se sirve entera. Si todos tus archivos están juntos en una
// sola carpeta, solo se publican los archivos del sitio (NUNCA server.js ni supabase.js).
const DIR_FRONTEND = path.join(__dirname, 'frontend');
const HAY_CARPETA_FRONTEND = fs.existsSync(path.join(DIR_FRONTEND, 'index.html'));
const DIR_PUBLICO = HAY_CARPETA_FRONTEND ? DIR_FRONTEND : __dirname;
if (HAY_CARPETA_FRONTEND) {
    app.use(express.static(DIR_FRONTEND));
} else {
    ['index.html', 'script.js', 'style.css', 'navidad.mp3', 'navidad2.mp3'].forEach((nombre) => {
        app.get('/' + nombre, (req, res, next) => {
            const archivo = path.join(__dirname, nombre);
            return fs.existsSync(archivo) ? res.sendFile(archivo) : next();
        });
    });
}

// =====================================================================
//  UTILIDADES
// =====================================================================
// Hora "de pared" de la academia (por defecto La Paz). Así el servidor funciona igual
// aunque esté alojado en otro país (Render, Railway, etc. usan hora UTC).
const ZONA_HORARIA = process.env.APP_TZ || 'America/La_Paz';
function ahoraLocal() {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: ZONA_HORARIA,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const g = (t) => partes.find((p) => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

const fechaValida = (f) => typeof f === 'string' && f.length >= 16 && !isNaN(new Date(f).getTime());

async function registrarMovimiento(tipo, descripcion, detalles = '') {
    try {
        // supabase NO lanza excepciones: devuelve { error }, por eso se revisa aquí
        const { error } = await supabase.from('historial_movimientos').insert([{
            tipo_movimiento: tipo,
            descripcion,
            detalles_usuario: detalles,
            fecha_hora: ahoraLocal()
        }]);
        if (error) console.error('No se pudo guardar en el historial:', error.message);
    } catch (err) {
        console.error('No se pudo guardar en el historial:', err.message);
    }
}

// Código de cliente: único para cada usuario y con aspecto aleatorio (ej. AM-7K3Q9X).
// Se calcula a partir del ID con una operación que nunca repite resultados, así no hace
// falta guardar nada nuevo en la base de datos y dos usuarios jamás tendrán el mismo código.
function codigoCliente(id) {
    const TOTAL = 36 ** 6; // 2,176,782,336 combinaciones
    const numero = Number(id);
    if (Number.isInteger(numero) && numero >= 0 && numero < TOTAL) {
        // BigInt para que la multiplicación sea exacta; 1500450271 no comparte factores con 36, por eso nunca se repite
        const mezclado = (BigInt(numero) * 1500450271n + 987654321n) % BigInt(TOTAL);
        return 'AM-' + mezclado.toString(36).toUpperCase().padStart(6, '0');
    }
    // Respaldo por si algún día el ID no fuera un número
    return 'AM-' + crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 6).toUpperCase();
}

const usuarioPublico = (u) => ({
    id: u.id,
    nombre: u.nombre,
    email: u.email,
    tipo: u.tipo,
    ci: u.ci,
    telefono: u.telefono,
    codigo_cliente: codigoCliente(u.id),
    foto_url: u.foto_url || null,
    avatar_id: u.avatar_id || null
});

// Mismos 10 IDs que ofrece la galería del frontend, para no aceptar cualquier texto.
const AVATARES_VALIDOS = ['av-1', 'av-2', 'av-3', 'av-4', 'av-5', 'av-6', 'av-7', 'av-8', 'av-9', 'av-10'];

// Sube una imagen en base64 (lo que manda el navegador) a Supabase Storage y devuelve su URL pública
const BUCKET_FOTOS = process.env.SUPABASE_BUCKET_FOTOS || 'academia-fotos';
async function subirImagenBase64(dataUrl, carpeta, nombreFijo) {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
    if (!m) throw Object.assign(new Error('La imagen no es válida.'), { status: 400 });
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buffer = Buffer.from(m[2], 'base64');
    if (buffer.length > 6 * 1024 * 1024) {
        throw Object.assign(new Error('La imagen pesa demasiado (máximo 6 MB).'), { status: 400 });
    }
    const ruta = `${carpeta}/${nombreFijo || crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
        .from(BUCKET_FOTOS)
        .upload(ruta, buffer, { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, upsert: true });
    if (error) {
        throw Object.assign(
            new Error('No se pudo subir la imagen. Revisa que el bucket "' + BUCKET_FOTOS + '" exista y sea público. (' + error.message + ')'),
            { status: 500 }
        );
    }
    return supabase.storage.from(BUCKET_FOTOS).getPublicUrl(ruta).data.publicUrl;
}

// Contraseñas cifradas con scrypt (viene incluido en Node, no hay que instalar nada)
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}
const esHash = (guardado) => /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(guardado || '');
function verificarPassword(password, guardado) {
    if (!guardado) return false;
    if (!esHash(guardado)) return password === guardado;
    const [salt, hash] = guardado.split(':');
    const original = Buffer.from(hash, 'hex');
    const intento = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(original, intento);
}

// Las sesiones viven en la tabla "sesiones" de Supabase (no en memoria), así que
// si reinicias el servidor, nadie pierde su sesión iniciada.
const DURACION_SESION = 8 * 60 * 60 * 1000;

// Límite de intentos de login (frena el que prueba contraseñas una y otra vez)
const intentosLogin = new Map();
const MAX_INTENTOS_LOGIN = 8;
const VENTANA_LOGIN = 15 * 60 * 1000;
const claveIntento = (req, email) => `${req.ip}|${email}`;
function loginBloqueado(clave) {
    const r = intentosLogin.get(clave);
    if (!r) return false;
    if (Date.now() - r.desde > VENTANA_LOGIN) { intentosLogin.delete(clave); return false; }
    return r.cuenta >= MAX_INTENTOS_LOGIN;
}
function registrarFalloLogin(clave) {
    const r = intentosLogin.get(clave);
    if (!r || Date.now() - r.desde > VENTANA_LOGIN) intentosLogin.set(clave, { cuenta: 1, desde: Date.now() });
    else r.cuenta += 1;
}

// Limpia cada 10 minutos las sesiones vencidas (en Supabase) y los intentos viejos (en memoria)
setInterval(() => {
    supabase.from('sesiones').delete().lt('expira', new Date().toISOString())
        .then(({ error }) => { if (error) console.error('No se pudieron limpiar las sesiones vencidas:', error.message); });
    const ahora = Date.now();
    for (const [k, r] of intentosLogin) if (ahora - r.desde > VENTANA_LOGIN) intentosLogin.delete(k);
}, 10 * 60 * 1000).unref();

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Guarda la sesión en Supabase (solo el "hash" del token, nunca el token en texto plano)
// y le entrega al navegador el token real, que es el único lugar donde existe completo.
async function crearSesion(usuario) {
    const token = crypto.randomBytes(32).toString('hex');
    const { error } = await supabase.from('sesiones').insert([{
        token_hash: hashToken(token),
        usuario_id: usuario.id,
        nombre: usuario.nombre,
        tipo: usuario.tipo,
        expira: new Date(Date.now() + DURACION_SESION).toISOString()
    }]);
    if (error) throw error;
    return token;
}

async function autenticar(req, res, next) {
    const cabecera = req.headers.authorization || '';
    const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
    try {
        const tokenHash = hashToken(token);
        const { data: sesion, error } = await supabase.from('sesiones').select('*').eq('token_hash', tokenHash).maybeSingle();
        if (error) throw error;
        if (!sesion || new Date(sesion.expira).getTime() < Date.now()) {
            if (sesion) await supabase.from('sesiones').delete().eq('token_hash', tokenHash);
            return res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
        }
        req.usuario = { id: sesion.usuario_id, tipo: sesion.tipo, nombre: sesion.nombre };
        req.token = token;
        req.tokenHash = tokenHash;
        next();
    } catch (err) {
        console.error('Error al verificar la sesión:', err.message);
        res.status(500).json({ error: 'Error al verificar la sesión.' });
    }
}

function soloAdmin(req, res, next) {
    if (req.usuario.tipo !== 'admin') {
        return res.status(403).json({ error: 'Esta acción es solo para el administrador.' });
    }
    next();
}

const ruta = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor.' });
    });
};

// Calcula multa por retraso (por día, con tope) + multa por daño (según escala)
function calcularMulta(fechaLimite, fechaReal, nivelDano) {
    const ms = new Date(fechaReal).getTime() - new Date(fechaLimite).getTime();
    const horasRetraso = ms > 0 ? ms / 3600000 : 0;
    let diasRetraso = 0;
    let multaRetraso = 0;
    if (horasRetraso > CONFIG.horasGracia) {
        diasRetraso = Math.ceil(horasRetraso / 24);
        multaRetraso = Math.min(diasRetraso * CONFIG.tarifaRetrasoPorDia, CONFIG.topeMultaRetraso);
    }
    const multaDano = CONFIG.multasDano[nivelDano] || 0;
    return {
        horasRetraso: Number(horasRetraso.toFixed(2)),
        diasRetraso,
        multaRetraso,
        multaDano,
        total: multaRetraso + multaDano
    };
}

function haySolape(inicioA, finA, inicioB, finB) {
    return new Date(inicioA).getTime() < new Date(finB).getTime() &&
           new Date(finA).getTime() > new Date(inicioB).getTime();
}

// Revisa que el instrumento no esté ocupado en ese horario
async function hayConflicto(instrumentoId, salida, limite, excluirReservaId = 0) {
    const { data: activos, error: errAct } = await supabase
        .from('prestamos')
        .select('id, fecha_prestamo, fecha_devolucion_limite')
        .eq('instrumento_id', instrumentoId)
        .eq('estado', 'Activo');
    if (errAct) throw errAct;

    const ahoraMs = new Date(ahoraLocal()).getTime();
    const conflictoActivo = (activos || []).some((p) =>
        haySolape(salida, limite, p.fecha_prestamo, p.fecha_devolucion_limite) ||
        new Date(p.fecha_devolucion_limite).getTime() <= ahoraMs
    );
    if (conflictoActivo) {
        return 'El instrumento tiene un préstamo activo en ese horario o todavía no fue devuelto.';
    }

    let queryRes = supabase
        .from('reservas_virtuales')
        .select('id, fecha_prestamo, fecha_devolucion_limite')
        .eq('instrumento_id', instrumentoId)
        .eq('estado_reserva', 'Pendiente');
    if (excluirReservaId) {
        queryRes = queryRes.neq('id', excluirReservaId);
    }
    const { data: pendientes, error: errRes } = await queryRes;
    if (errRes) throw errRes;

    const conflictoPendiente = (pendientes || []).some((r) =>
        haySolape(salida, limite, r.fecha_prestamo, r.fecha_devolucion_limite)
    );
    if (conflictoPendiente) {
        return 'Ya existe una reserva pendiente para ese instrumento en ese horario.';
    }
    return null;
}

async function asegurarAdminInicial() {
    const emailAdmin = String(
        process.env.ADMIN_EMAIL || 'admin@academia.com'
    ).trim().toLowerCase();

    const passwordAdmin = process.env.ADMIN_PASSWORD;

    const { data: admin, error } = await supabase
        .from('usuarios')
        .select('id')
        .eq('email', emailAdmin)
        .maybeSingle();

    if (error) throw error;

    if (!admin) {
        if (!passwordAdmin || passwordAdmin.length < 12) {
            throw new Error(
                'Configura ADMIN_PASSWORD con al menos 12 caracteres.'
            );
        }

        const { error: errInsert } = await supabase
            .from('usuarios')
            .insert([{
                nombre: 'Administrador Principal',
                email: emailAdmin,
                password: hashPassword(passwordAdmin),
                tipo: 'admin',
                email_verificado: true
            }]);

        if (errInsert) throw errInsert;
    }
}

// =====================================================================
//  AUTENTICACIÓN
// =====================================================================
app.post('/api/registro', ruta(async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const ci = String(req.body.ci || '').trim();
    const telefono = String(req.body.telefono || '').trim();

    if (!nombre || !email || !password || !ci || !telefono) {
        return res.status(400).json({ error: 'Completa todos los campos.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Escribe un correo electrónico válido.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    const { data: existente } = await supabase
        .from('usuarios')
        .select('id')
        .eq('email', email)
        .maybeSingle();
    if (existente) {
        return res.status(400).json({ error: 'El correo electrónico ya está registrado.' });
    }

    const { data, error } = await supabase
        .from('usuarios')
        .insert([{
            nombre,
            email,
            password: hashPassword(password),
            tipo: 'cliente',
            ci,
            telefono,
            email_verificado: false
        }])
        .select('*')
        .single();
    if (error) throw error;

    await enviarVerificacionANuevoUsuario(req, data);
    res.json({
        mensaje: 'Registro exitoso. Te enviamos un correo para confirmar tu cuenta antes de iniciar sesión.',
        id: data.id
    });
}));

// Confirma la cuenta cuando el usuario abre el enlace del correo
app.post('/api/verificar-correo', ruta(async (req, res) => {
    const token = String(req.body.token || '');
    if (!token) return res.status(400).json({ error: 'Enlace no válido.' });

    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('id, email_verificado')
        .eq('verif_token_hash', hashToken(token))
        .maybeSingle();
    if (error) throw error;
    if (!usuario) return res.status(400).json({ error: 'El enlace de verificación no es válido o ya fue usado.' });

    if (!usuario.email_verificado) {
        await supabase.from('usuarios').update({ email_verificado: true, verif_token_hash: null }).eq('id', usuario.id);
    }
    res.json({ mensaje: '¡Correo confirmado! Ya puedes iniciar sesión.' });
}));

// Por si el correo no llegó o se perdió el enlace
app.post('/api/reenviar-verificacion', ruta(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const mensajeGenerico = { mensaje: 'Si ese correo está registrado y aún no se confirmó, te reenviamos el enlace de verificación.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json(mensajeGenerico);

    const claveReenvio = claveIntento(req, 'verif:' + email);
    if (loginBloqueado(claveReenvio)) return res.json(mensajeGenerico);
    registrarFalloLogin(claveReenvio);

    const { data: usuario } = await supabase.from('usuarios').select('*').eq('email', email).maybeSingle();
    if (usuario && !usuario.email_verificado) {
        await enviarVerificacionANuevoUsuario(req, usuario);
    }
    res.json(mensajeGenerico);
}));

// Procesa los botones "Sí, soy yo / Aceptar" y "No, no soy yo / Rechazar" del correo
app.get('/api/autorizar-login', ruta(async (req, res) => {
    const token = String(req.query.token || '').trim();
    const accion = String(req.query.accion || '').trim().toLowerCase();

    if (!token || !['aceptar', 'rechazar'].includes(accion)) {
        return res.status(400).send(`
            <html><body style="font-family:Arial,sans-serif;text-align:center;padding:40px;">
                <h2>Enlace no válido</h2>
                <p>El enlace de autorización está incompleto o no es correcto.</p>
            </body></html>
        `);
    }

    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('id, nombre, email, login_token_hash, email_verificado')
        .eq('login_token_hash', hashToken(token))
        .maybeSingle();

    if (error) throw error;

    if (!usuario) {
        return res.status(400).send(`
            <html><body style="font-family:Arial,sans-serif;text-align:center;padding:40px;">
                <h2>Solicitud vencida o ya utilizada</h2>
                <p>Este enlace ya no es válido. Vuelve a intentar iniciar sesión para generar uno nuevo.</p>
            </body></html>
        `);
    }

    const nuevoEstado = accion === 'aceptar' ? 'aprobado' : 'rechazado';
    const updates = { login_estado: nuevoEstado };
    if (accion === 'aceptar') {
        updates.email_verificado = true;
        updates.verif_token_hash = null;
    }

    const { error: errUpd } = await supabase
        .from('usuarios')
        .update(updates)
        .eq('id', usuario.id);
    if (errUpd) throw errUpd;

    if (accion === 'aceptar') {
        return res.send(`
            <html><body style="font-family:Arial,sans-serif;text-align:center;padding:40px;">
                <h2 style="color:#16a34a;">Inicio de sesión autorizado</h2>
                <p>Listo, ${usuario.nombre || usuario.email}. Ya puedes volver a la pantalla de inicio de sesión para entrar al sistema.</p>
            </body></html>
        `);
    }

    return res.send(`
        <html><body style="font-family:Arial,sans-serif;text-align:center;padding:40px;">
            <h2 style="color:#dc2626;">Acceso rechazado</h2>
            <p>Has marcado que no reconoces este intento. El acceso quedó bloqueado.</p>
        </body></html>
    `);
}));

app.post('/api/login', ruta(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const claveLogin = claveIntento(req, email);
    if (loginBloqueado(claveLogin)) {
        return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.' });
    }

    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('email', email)
        .maybeSingle();
    if (error) throw error;

    if (!usuario || !verificarPassword(password, usuario.password)) {
        registrarFalloLogin(claveLogin);
        return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }
    intentosLogin.delete(claveLogin);

    if (!esHash(usuario.password)) {
        await supabase
            .from('usuarios')
            .update({ password: hashPassword(password) })
            .eq('id', usuario.id);
    }

    if (usuario.tipo !== 'admin' && !usuario.email_verificado) {
        await enviarVerificacionANuevoUsuario(req, usuario);
        return res.status(202).json({
            requiere_autorizacion: true,
            estado_autorizacion: 'pendiente',
            mensaje: 'Te enviamos un correo con dos opciones. Pulsa "Sí, soy yo / Aceptar" para continuar.'
        });
    }

    // Limpia cualquier estado previo para evitar bucles en futuros inicios de sesión
    await supabase
        .from('usuarios')
        .update({ login_estado: null, login_token_hash: null })
        .eq('id', usuario.id);

    res.json({
        mensaje: 'Inicio de sesión autorizado',
        usuario: usuarioPublico(usuario),
        token: await crearSesion(usuario)
    });
}));

// Consulta el estado ("pendiente", "aprobado" o "rechazado") mientras el usuario está en el login
app.post('/api/estado-autorizacion', ruta(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).json({ error: 'Faltan credenciales.' });
    }

    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('email', email)
        .maybeSingle();
    if (error) throw error;

    if (!usuario || !verificarPassword(password, usuario.password)) {
        return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }

    if (usuario.login_estado === 'rechazado') {
        await supabase
            .from('usuarios')
            .update({ login_estado: null, login_token_hash: null })
            .eq('id', usuario.id);
        return res.json({
            estado_autorizacion: 'rechazado',
            mensaje: 'Inicio de sesión rechazado.'
        });
    }

    if (usuario.login_estado === 'aprobado' || usuario.email_verificado) {
        await supabase
            .from('usuarios')
            .update({
                email_verificado: true,
                verif_token_hash: null,
                login_estado: null,
                login_token_hash: null
            })
            .eq('id', usuario.id);

        return res.json({
            estado_autorizacion: 'aprobado',
            mensaje: 'Inicio de sesión autorizado',
            usuario: usuarioPublico(usuario),
            token: await crearSesion(usuario)
        });
    }

    return res.json({
        estado_autorizacion: 'pendiente',
        mensaje: 'Esperando que elijas "Sí, soy yo / Aceptar" en tu correo...'
    });
}));

app.post('/api/logout', autenticar, ruta(async (req, res) => {
    await supabase.from('sesiones').delete().eq('token_hash', req.tokenHash);
    res.json({ mensaje: 'Sesión cerrada' });
}));

// Datos actualizados del usuario que tiene la sesión abierta (incluye su código de cliente)
app.get('/api/mi-perfil', autenticar, ruta(async (req, res) => {
    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('id', req.usuario.id)
        .maybeSingle();
    if (error) throw error;
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json(usuarioPublico(usuario));
}));

// Sube la selfie o la foto elegida y la deja como foto de perfil (reemplaza la anterior)
app.post('/api/mi-perfil/foto', autenticar, ruta(async (req, res) => {
    const foto_url = await subirImagenBase64(req.body.imagen, 'perfiles', String(req.usuario.id));
    const { error } = await supabase.from('usuarios').update({ foto_url }).eq('id', req.usuario.id);
    if (error) throw error;
    res.json({ foto_url });
}));

// Elige uno de los 10 avatares de la galería (y deja de usar la selfie, si tenía una)
app.post('/api/mi-perfil/avatar', autenticar, ruta(async (req, res) => {
    const avatar_id = String(req.body.avatar_id || '');
    if (!AVATARES_VALIDOS.includes(avatar_id)) {
        return res.status(400).json({ error: 'Avatar no válido.' });
    }
    const { data: usuario, error } = await supabase
        .from('usuarios')
        .update({ avatar_id, foto_url: null })
        .eq('id', req.usuario.id)
        .select('*')
        .single();
    if (error) throw error;
    res.json(usuarioPublico(usuario));
}));

async function enviarCorreoVerificacion(destino, nombre, enlaceAceptar, enlaceRechazar) {
    const remitente = process.env.SMTP_FROM || process.env.SMTP_USER;
    const asunto = 'Autorización de acceso - Academia de Música';
    const html = `
        <p>Hola ${nombre || ''},</p>
        <p>Se detectó una solicitud de acceso o verificación para tu cuenta. Elige una opción:</p>
        <p>
            <a href="${enlaceAceptar}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:10px;">
                Sí, soy yo / Aceptar
            </a>
            <a href="${enlaceRechazar}" style="display:inline-block;padding:10px 18px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">
                No, no soy yo / Rechazar
            </a>
        </p>
        <p>Si no reconoces esta actividad, pulsa "No, no soy yo / Rechazar".</p>
    `;

    // Usa la API HTTPS de Brevo si está configurada (evita bloqueos de puertos SMTP en Render)
    if (process.env.BREVO_API_KEY) {
        const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': process.env.BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { email: remitente, name: 'Academia de Música' },
                to: [{ email: destino, name: nombre || destino }],
                subject: asunto,
                htmlContent: html
            })
        });
        if (!resp.ok) {
            const detalle = await resp.text();
            throw new Error(`Brevo API error (${resp.status}): ${detalle}`);
        }
        return;
    }

    const transportador = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transportador.sendMail({
        from: remitente,
        to: destino,
        subject: asunto,
        html
    });
}

async function enviarVerificacionANuevoUsuario(req, usuario) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);

    const { error } = await supabase
        .from('usuarios')
        .update({
            verif_token_hash: tokenHash,
            login_token_hash: tokenHash,
            login_estado: 'pendiente'
        })
        .eq('id', usuario.id);
    if (error) throw error;

    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const enlaceAceptar = `${base}/api/autorizar-login?token=${encodeURIComponent(token)}&accion=aceptar`;
    const enlaceRechazar = `${base}/api/autorizar-login?token=${encodeURIComponent(token)}&accion=rechazar`;

    if (process.env.BREVO_API_KEY || smtpConfigurado()) {
        try {
            await enviarCorreoVerificacion(usuario.email, usuario.nombre, enlaceAceptar, enlaceRechazar);
        } catch (err) {
            console.error('No se pudo enviar el correo de verificación:', err.message);
        }
    } else {
        console.warn('✉️  Correo no configurado. Enlaces generados:', { enlaceAceptar, enlaceRechazar });
    }
}

function smtpConfigurado() {
    return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function enviarCorreoPasswordTemporal(destino, nombre, passwordTemporal) {
    const transportador = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transportador.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: destino,
        subject: 'Tu nueva contraseña temporal - Academia de Música',
        html: `
            <p>Hola ${nombre || ''},</p>
            <p>Verificamos tus datos y generamos una contraseña temporal para que puedas entrar de nuevo:</p>
            <p style="font-size:20px;font-weight:bold;letter-spacing:2px;">${passwordTemporal}</p>
            <p>Por tu seguridad, te recomendamos cambiarla apenas inicies sesión (menú "Contraseña").</p>
            <p>Si no fuiste tú quien lo pidió, escríbele al administrador de la academia.</p>
        `
    });
}

// Sin letras ni números que se confunden entre sí (0/O, 1/l/I), para que sea fácil de copiar a mano.
function generarPasswordTemporal() {
    const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let p = '';
    for (const byte of crypto.randomBytes(10)) p += alfabeto[byte % alfabeto.length];
    return p;
}

// Recuperar contraseña verificando la IDENTIDAD de la persona (no un enlace de correo):
// debe escribir el correo, el nombre completo, el CI y el teléfono TAL COMO los registró.
// Si todo coincide, se genera una contraseña temporal nueva y se muestra en pantalla.
app.post('/api/recuperar-password', ruta(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const nombre = String(req.body.nombre || '').trim().toLowerCase();
    const ci = String(req.body.ci || '').trim();
    const telefono = String(req.body.telefono || '').trim();
    const errorGenerico = 'Esos datos no coinciden con ningún usuario registrado. Revísalos e inténtalo de nuevo.';

    if (!email || !nombre || !ci || !telefono) {
        return res.status(400).json({ error: 'Completa el correo, el nombre, el CI y el teléfono.' });
    }

    // Mismo límite que el login: evita que alguien pruebe muchas combinaciones de CI/teléfono
    const claveReset = claveIntento(req, 'reset:' + email);
    if (loginBloqueado(claveReset)) {
        return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' });
    }
    registrarFalloLogin(claveReset);

    const { data: usuario, error } = await supabase.from('usuarios').select('*').eq('email', email).maybeSingle();
    if (error) throw error;

    const coincide = usuario
        && String(usuario.nombre || '').trim().toLowerCase() === nombre
        && String(usuario.ci || '').trim() === ci
        && String(usuario.telefono || '').trim() === telefono;
    if (!coincide) {
        return res.status(400).json({ error: errorGenerico });
    }

    intentosLogin.delete(claveReset);
    const passwordTemporal = generarPasswordTemporal();
    await supabase.from('usuarios').update({ password: hashPassword(passwordTemporal) }).eq('id', usuario.id);
    await supabase.from('sesiones').delete().eq('usuario_id', usuario.id);
    await registrarMovimiento('USUARIO', `Se generó una contraseña temporal para ${usuario.nombre} (verificación de identidad)`);

    if (smtpConfigurado()) {
        enviarCorreoPasswordTemporal(usuario.email, usuario.nombre, passwordTemporal).catch((err) => {
            console.error('No se pudo enviar el correo con la contraseña temporal:', err.message);
        });
    }

    res.json({
        mensaje: 'Verificamos tus datos. Aquí tienes tu contraseña temporal.',
        password_temporal: passwordTemporal
    });
}));

app.post('/api/cambiar-password', autenticar, ruta(async (req, res) => {
    const actual = String(req.body.actual || '');
    const nueva = String(req.body.nueva || '');
    if (nueva.length < 8) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    }
    if (nueva === actual) {
        return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual.' });
    }

    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('id', req.usuario.id)
        .single();
    if (error || !usuario || !verificarPassword(actual, usuario.password)) {
        return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    }

    const { error: errUpd } = await supabase
        .from('usuarios')
        .update({ password: hashPassword(nueva) })
        .eq('id', usuario.id);
    if (errUpd) throw errUpd;

    await supabase.from('sesiones').delete().eq('usuario_id', usuario.id).neq('token_hash', req.tokenHash);
    await registrarMovimiento('USUARIO', 'Cambio de contraseña', req.usuario.nombre);
    res.json({ mensaje: 'Contraseña actualizada' });
}));

app.get('/api/config', (req, res) => res.json(CONFIG));

// =====================================================================
//  INSTRUMENTOS
// =====================================================================
app.get('/api/instrumentos', ruta(async (req, res) => {
    const { data, error } = await supabase
        .from('instrumentos')
        .select('*')
        .order('id', { ascending: false });
    if (error) throw error;
    res.json(data || []);
}));

app.get('/api/instrumentos/:id', autenticar, ruta(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID de instrumento no válido.' });
    }

    const { data, error } = await supabase
        .from('instrumentos')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Instrumento no encontrado.' });

    res.json(data);
}));

app.get('/api/disponibilidad', ruta(async (req, res) => {
    const { data, error } = await supabase
        .from('prestamos')
        .select('instrumento_id, fecha_prestamo')
        .eq('estado', 'Activo');
    if (error) throw error;

    const ahoraMs = new Date(ahoraLocal()).getTime();
    const ocupados = [...new Set(
        (data || [])
            .filter((f) => new Date(f.fecha_prestamo).getTime() <= ahoraMs)
            .map((f) => f.instrumento_id)
    )];
    res.json({ ocupados });
}));

app.post('/api/instrumentos', autenticar, soloAdmin, ruta(async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
const tipo = String(req.body.tipo || '').trim();
const marca = String(req.body.marca || '').trim();
const modelo = String(req.body.modelo || '').trim();
const numero_serie = String(req.body.numero_serie || '').trim();
const { estado_fisico } = req.body;
let imagen = req.body.imagen || '';

if (!nombre || !tipo || !marca || !modelo || !numero_serie) {
    return res.status(400).json({ error: 'Completa nombre, tipo, marca, modelo y número de serie.' });
}
    if (!ESTADOS_FISICOS.includes(estado_fisico)) {
        return res.status(400).json({ error: 'Estado físico no válido.' });
    }
    if (imagen && !String(imagen).startsWith('data:image/')) {
        return res.status(400).json({ error: 'La imagen no es válida.' });
    }
    if (imagen) imagen = await subirImagenBase64(imagen, 'instrumentos');

    const { data: dup } = await supabase
        .from('instrumentos')
        .select('id')
        .eq('numero_serie', numero_serie)
        .maybeSingle();
    if (dup) {
        return res.status(400).json({ error: 'El número de serie ya existe.' });
    }

    const { data, error } = await supabase
    .from('instrumentos')
    .insert([{ nombre, tipo, marca, modelo, numero_serie, estado_fisico, imagen }])
    .select('id')
    .single();
    if (error) throw error;

    await registrarMovimiento('INSTRUMENTO', `Se registró "${nombre}" (serie ${numero_serie})`, req.usuario.nombre);
    res.json({ mensaje: 'Registrado con éxito', id: data.id });
}));

app.put('/api/instrumentos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID de instrumento no válido.' });
    }

    const { data: actual, error: errBus } = await supabase
        .from('instrumentos')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (errBus) throw errBus;
    if (!actual) return res.status(404).json({ error: 'Instrumento no encontrado.' });

    const estado_fisico = req.body.estado_fisico !== undefined
        ? req.body.estado_fisico
        : actual.estado_fisico;
    if (!ESTADOS_FISICOS.includes(estado_fisico)) {
        return res.status(400).json({ error: 'Estado físico no válido.' });
    }

    const nombre = req.body.nombre !== undefined
        ? String(req.body.nombre || '').trim()
        : actual.nombre;
    const tipo = req.body.tipo !== undefined
        ? String(req.body.tipo || '').trim()
        : actual.tipo;
    const marca = req.body.marca !== undefined
        ? String(req.body.marca || '').trim()
        : actual.marca;
    const modelo = req.body.modelo !== undefined
        ? String(req.body.modelo || '').trim()
        : actual.modelo;
    const numero_serie = req.body.numero_serie !== undefined
        ? String(req.body.numero_serie || '').trim()
        : actual.numero_serie;

    if (!nombre || !tipo || !numero_serie) {
        return res.status(400).json({ error: 'Nombre, tipo y número de serie son obligatorios.' });
    }

    if (numero_serie !== actual.numero_serie) {
        const { data: dup, error: errDup } = await supabase
            .from('instrumentos')
            .select('id')
            .eq('numero_serie', numero_serie)
            .neq('id', id)
            .maybeSingle();
        if (errDup) throw errDup;
        if (dup) {
            return res.status(400).json({ error: 'Ya existe otro instrumento con ese número de serie.' });
        }
    }

    const cambios = { nombre, tipo, marca, modelo, numero_serie, estado_fisico };

    if (req.body.imagen !== undefined) {
        let imagen = String(req.body.imagen || '');
        if (imagen && !imagen.startsWith('data:image/')) {
            return res.status(400).json({ error: 'La imagen no es válida.' });
        }
        if (imagen) imagen = await subirImagenBase64(imagen, 'instrumentos');
        cambios.imagen = imagen;
    }

    const { error } = await supabase
        .from('instrumentos')
        .update(cambios)
        .eq('id', id);
    if (error) throw error;

    await registrarMovimiento(
        'INSTRUMENTO',
        `Instrumento #${id} ("${nombre}", serie ${numero_serie}) actualizado — Estado: "${estado_fisico}"`,
        req.usuario.nombre
    );
    res.json({ mensaje: 'Instrumento actualizado con éxito' });
}));

app.delete('/api/instrumentos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID de instrumento no válido.' });
    }

    const { count: cPrestamos, error: errP } = await supabase
        .from('prestamos')
        .select('*', { count: 'exact', head: true })
        .eq('instrumento_id', id);
    if (errP) throw errP;

    const { count: cReservas, error: errR } = await supabase
        .from('reservas_virtuales')
        .select('*', { count: 'exact', head: true })
        .eq('instrumento_id', id);
    if (errR) throw errR;

    if ((cPrestamos || 0) + (cReservas || 0) > 0) {
        return res.status(400).json({
            error: 'Este instrumento tiene historial de préstamos o reservas, no se puede eliminar. Cámbialo a "En reparación" para retirarlo del préstamo.'
        });
    }

    const { error } = await supabase.from('instrumentos').delete().eq('id', id);
    if (error) throw error;

    await registrarMovimiento('INSTRUMENTO', `Se eliminó el instrumento #${id}`, req.usuario.nombre);
    res.json({ mensaje: 'Eliminado con éxito' });
}));

// =====================================================================
//  RESERVAS VIRTUALES
// =====================================================================
app.post('/api/reservas', autenticar, ruta(async (req, res) => {
    const {
        instrumento_id, tipo_solicitante, clase_evento,
        fecha_prestamo, fecha_devolucion_limite, ci, telefono,
        metodo_pago, tarjeta_ultimos4
    } = req.body;

    if (!instrumento_id || !clase_evento || !ci || !telefono || !fechaValida(fecha_prestamo) || !fechaValida(fecha_devolucion_limite)) {
        return res.status(400).json({ error: 'Faltan campos obligatorios para la reserva.' });
    }
    if (new Date(fecha_devolucion_limite) <= new Date(fecha_prestamo)) {
        return res.status(400).json({ error: 'La fecha límite debe ser posterior a la fecha de salida.' });
    }
    if (new Date(fecha_devolucion_limite) <= new Date(ahoraLocal())) {
        return res.status(400).json({ error: 'La fecha límite ya pasó.' });
    }

    const { data: instrumento } = await supabase
        .from('instrumentos')
        .select('*')
        .eq('id', instrumento_id)
        .maybeSingle();
    if (!instrumento) return res.status(404).json({ error: 'Instrumento no encontrado.' });
    if (instrumento.estado_fisico === 'En reparación') {
        return res.status(400).json({ error: 'El instrumento está en reparación y no se puede reservar.' });
    }

    const conflicto = await hayConflicto(instrumento.id, fecha_prestamo, fecha_devolucion_limite);
    if (conflicto) return res.status(400).json({ error: conflicto });

    const metodo = metodo_pago === 'qr' ? 'qr' : 'tarjeta';
    const ultimos4 = metodo === 'tarjeta' ? String(tarjeta_ultimos4 || '') : null;
    if (metodo === 'tarjeta' && !/^\d{4}$/.test(ultimos4)) {
        return res.status(400).json({ error: 'Faltan los datos de la tarjeta.' });
    }

    const { data, error } = await supabase
        .from('reservas_virtuales')
        .insert([{
            instrumento_id: instrumento.id,
            usuario_id: req.usuario.id,
            solicitante: req.usuario.nombre,
            tipo_solicitante: TIPOS_SOLICITANTE.includes(tipo_solicitante) ? tipo_solicitante : 'Alumno',
            clase_evento,
            fecha_prestamo,
            fecha_devolucion_limite,
            ci,
            telefono,
            metodo_pago: metodo,
            monto_adelanto: CONFIG.adelantoReserva,
            tarjeta_ultimos4: ultimos4,
            estado_reserva: 'Pendiente'
        }])
        .select('id')
        .single();
    if (error) throw error;

    await registrarMovimiento('RESERVA', `Reserva #${data.id} de "${instrumento.nombre}"`, req.usuario.nombre);
    res.json({ mensaje: 'Reserva virtual enviada con éxito', id: data.id });
}));

app.get('/api/reservas', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data, error } = await supabase
        .from('reservas_virtuales')
        .select('*, instrumentos(nombre, numero_serie)')
        .order('id', { ascending: false });
    if (error) throw error;

    const formateado = (data || []).map((r) => ({
        ...r,
        instrumento_nombre: r.instrumentos ? r.instrumentos.nombre : null,
        numero_serie: r.instrumentos ? r.instrumentos.numero_serie : null,
        instrumentos: undefined
    }));
    res.json(formateado);
}));

app.get('/api/mis-reservas', autenticar, ruta(async (req, res) => {
    const { data, error } = await supabase
        .from('reservas_virtuales')
        .select('*, instrumentos(nombre, numero_serie)')
        .eq('usuario_id', req.usuario.id)
        .order('id', { ascending: false });
    if (error) throw error;

    const formateado = (data || []).map((r) => ({
        ...r,
        instrumento_nombre: r.instrumentos ? r.instrumentos.nombre : null,
        numero_serie: r.instrumentos ? r.instrumentos.numero_serie : null,
        instrumentos: undefined
    }));
    res.json(formateado);
}));

app.post('/api/mis-reservas/:id/cancelar', autenticar, ruta(async (req, res) => {
    const reservaId = Number(req.params.id);
    if (!Number.isInteger(reservaId) || reservaId <= 0) {
        return res.status(400).json({ error: 'ID de reserva no válido.' });
    }

    // Solo puede cancelar el dueño de la reserva
    const { data: reserva, error: errBuscar } = await supabase
        .from('reservas_virtuales')
        .select('*')
        .eq('id', reservaId)
        .eq('usuario_id', req.usuario.id)
        .maybeSingle();
    if (errBuscar) throw errBuscar;
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada.' });

    if (!['Pendiente', 'Aceptada'].includes(reserva.estado_reserva)) {
        return res.status(400).json({ error: `Esta reserva ya está ${String(reserva.estado_reserva).toLowerCase()}, no se puede cancelar.` });
    }

    // Si ya fue aceptada, también se anula SU préstamo (y solo ese)
    if (reserva.estado_reserva === 'Aceptada') {
        const ahoraMs = new Date(ahoraLocal()).getTime();
        if (new Date(reserva.fecha_prestamo).getTime() <= ahoraMs) {
            return res.status(400).json({
                error: 'El horario de esta reserva ya comenzó. Comunícate con el administrador para cancelarla.'
            });
        }

        const { data: activos, error: errAct } = await supabase
            .from('prestamos')
            .select('id, fecha_prestamo, fecha_devolucion_limite, solicitante')
            .eq('instrumento_id', reserva.instrumento_id)
            .eq('es_virtual', 1)
            .eq('estado', 'Activo');
        if (errAct) throw errAct;

        const mismoMomento = (a, b) => new Date(a).getTime() === new Date(b).getTime();
        const idsPrestamo = (activos || [])
            .filter((p) =>
                p.solicitante === reserva.solicitante &&
                mismoMomento(p.fecha_prestamo, reserva.fecha_prestamo) &&
                mismoMomento(p.fecha_devolucion_limite, reserva.fecha_devolucion_limite)
            )
            .map((p) => p.id);

        if (idsPrestamo.length > 0) {
            const { error: errPrest } = await supabase
                .from('prestamos')
                .update({ estado: 'Cancelado' })
                .in('id', idsPrestamo);
            if (errPrest) throw errPrest;
        }
    }

    const { data: actualizada, error: errUpdate } = await supabase
        .from('reservas_virtuales')
        .update({ estado_reserva: 'Cancelada' })
        .eq('id', reservaId)
        .select()
        .single();
    if (errUpdate) throw errUpdate;

    await registrarMovimiento('RESERVA', `Reserva #${reservaId} cancelada por el cliente`, req.usuario.nombre);
    res.json({
        ok: true,
        reserva: actualizada,
        estado_label_admin: 'Solicitud / Reserva cancelada'
    });
}));

app.post('/api/reservas/:id/aceptar', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data: reserva, error: errRes } = await supabase
        .from('reservas_virtuales')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
    if (errRes) throw errRes;
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (reserva.estado_reserva !== 'Pendiente') {
        return res.status(400).json({ error: 'Esta reserva ya fue procesada.' });
    }

    const { data: instrumento, error: errInst } = await supabase
        .from('instrumentos')
        .select('*')
        .eq('id', reserva.instrumento_id)
        .maybeSingle();
    if (errInst) throw errInst;
    if (!instrumento) return res.status(400).json({ error: 'El instrumento ya no existe.' });
    if (instrumento.estado_fisico === 'En reparación') {
        return res.status(400).json({ error: 'El instrumento está en reparación.' });
    }

    if (new Date(reserva.fecha_devolucion_limite) <= new Date(ahoraLocal())) {
        return res.status(400).json({
            error: 'La fecha límite de esta reserva ya pasó. Recházala o pídele al cliente que reserve de nuevo.'
        });
    }

    const conflicto = await hayConflicto(
        reserva.instrumento_id,
        reserva.fecha_prestamo,
        reserva.fecha_devolucion_limite,
        reserva.id
    );
    if (conflicto) return res.status(400).json({ error: conflicto });

    const nuevoPrestamo = {
        instrumento_id: reserva.instrumento_id,
        solicitante: reserva.solicitante,
        ci_solicitante: reserva.ci_solicitante ?? reserva.ci ?? '',
        telefono: reserva.telefono ?? '',
        clase_evento: reserva.clase_evento ?? '',
        fecha_prestamo: reserva.fecha_prestamo,
        fecha_devolucion_limite: reserva.fecha_devolucion_limite,
        firma_digital: `Reserva virtual - adelanto ${CONFIG.moneda} ${reserva.monto_adelanto ?? 0}`,
        estado: 'Activo',
        multa: 0,
        es_virtual: 1,
        estado_salida: instrumento.estado_fisico
    };

    const { data: prestamoCreado, error: errIns } = await supabase
        .from('prestamos')
        .insert([nuevoPrestamo])
        .select()
        .single();
    if (errIns) throw errIns;

    const { error: errUpd } = await supabase
        .from('reservas_virtuales')
        .update({ estado_reserva: 'Aceptada' })
        .eq('id', reserva.id);
    if (errUpd) throw errUpd;

    try {
        await registrarMovimiento(
            'RESERVA',
            `Reserva #${reserva.id} aceptada y convertida en préstamo #${prestamoCreado.id}`,
            req.usuario.nombre
        );
    } catch (errMov) {
        console.error('Error al registrar movimiento al aceptar reserva:', errMov);
    }

    res.json({
        mensaje: 'Reserva aceptada y registrada como préstamo virtual',
        prestamo: prestamoCreado
    });
}));

app.post('/api/reservas/:id/rechazar', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data: reserva } = await supabase
        .from('reservas_virtuales')
        .select('estado_reserva')
        .eq('id', req.params.id)
        .maybeSingle();
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (reserva.estado_reserva !== 'Pendiente') {
        return res.status(400).json({ error: 'Esta reserva ya fue procesada.' });
    }

    const { error } = await supabase
        .from('reservas_virtuales')
        .update({ estado_reserva: 'Rechazada' })
        .eq('id', req.params.id);
    if (error) throw error;

    await registrarMovimiento('RESERVA', `Reserva #${req.params.id} rechazada`, req.usuario.nombre);
    res.json({ mensaje: 'Reserva rechazada' });
}));

// =====================================================================
//  PRÉSTAMOS Y DEVOLUCIONES
// =====================================================================
app.get('/api/prestamos', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data, error } = await supabase
        .from('prestamos')
        .select(`
            id, instrumento_id, solicitante, ci_solicitante, telefono, clase_evento,
            fecha_prestamo, fecha_devolucion_limite, fecha_devolucion_real, estado,
            multa, multa_retraso, multa_dano, nivel_dano, estado_salida, estado_retorno,
            es_virtual,
            instrumentos(nombre, numero_serie)
        `)
        .order('id', { ascending: false });
    if (error) throw error;

    const formateado = (data || []).map((p) => ({
        ...p,
        nombre: p.instrumentos ? p.instrumentos.nombre : null,
        numero_serie: p.instrumentos ? p.instrumentos.numero_serie : null,
        instrumentos: undefined
    }));
    res.json(formateado);
}));

// Anula un préstamo activo o borra del registro uno ya devuelto/cancelado
app.delete('/api/prestamos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID de préstamo no válido.' });
    }

    const { data: prestamo, error: errBus } = await supabase
        .from('prestamos')
        .select('id, estado, solicitante')
        .eq('id', id)
        .maybeSingle();
    if (errBus) throw errBus;
    if (!prestamo) return res.status(404).json({ error: 'Registro de préstamo no encontrado.' });

    const { error: errDel } = await supabase.from('prestamos').delete().eq('id', id);
    if (errDel) throw errDel;

    await registrarMovimiento(
        'PRÉSTAMO',
        prestamo.estado === 'Activo'
            ? `Se anuló/eliminó el préstamo activo #${id} de ${prestamo.solicitante}`
            : `Se borró el registro del préstamo #${id} (${prestamo.estado}) de ${prestamo.solicitante}`,
        req.usuario.nombre
    );
    res.json({ ok: true, id, mensaje: 'Préstamo eliminado con éxito' });
}));

app.delete('/api/reservas/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'ID de reserva no válido.' });
    }

    const { data: reserva, error: errBus } = await supabase
        .from('reservas_virtuales')
        .select('id, solicitante, estado_reserva')
        .eq('id', id)
        .maybeSingle();
    if (errBus) throw errBus;
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada.' });

    const { error: errDel } = await supabase.from('reservas_virtuales').delete().eq('id', id);
    if (errDel) {
        return res.status(400).json({
            error: `No se pudo eliminar la reserva (${errDel.message || 'revisa dependencias en base de datos'}).`
        });
    }

    await registrarMovimiento(
        'RESERVA',
        `Se eliminó la reserva #${id} (${reserva.estado_reserva}) de ${reserva.solicitante}`,
        req.usuario.nombre
    );
    res.json({ mensaje: 'Reserva eliminada con éxito' });
}));

app.get('/api/prestamos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data: prestamo, error } = await supabase
        .from('prestamos')
        .select('*, instrumentos(nombre, numero_serie)')
        .eq('id', req.params.id)
        .maybeSingle();
    if (error) throw error;
    if (!prestamo) return res.status(404).json({ error: 'Préstamo no encontrado.' });

    res.json({
        ...prestamo,
        nombre: prestamo.instrumentos ? prestamo.instrumentos.nombre : null,
        numero_serie: prestamo.instrumentos ? prestamo.instrumentos.numero_serie : null,
        instrumentos: undefined
    });
}));

app.post('/api/prestamos', autenticar, soloAdmin, ruta(async (req, res) => {
    const { instrumento_id, clase_evento, fecha_prestamo, fecha_devolucion_limite, firma_digital } = req.body;
    const solicitante = String(req.body.solicitante || '').trim();
    const ci_solicitante = String(req.body.ci_solicitante || '').trim();
    const telefono = String(req.body.telefono || '').trim();

    if (!instrumento_id || !solicitante || !clase_evento || !fechaValida(fecha_prestamo) || !fechaValida(fecha_devolucion_limite)) {
        return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }
    if (new Date(fecha_devolucion_limite) <= new Date(fecha_prestamo)) {
        return res.status(400).json({ error: 'La fecha límite debe ser posterior a la fecha de salida.' });
    }
    if (!firma_digital || !String(firma_digital).startsWith('data:image/')) {
        return res.status(400).json({ error: 'Falta la firma digital del solicitante.' });
    }

    const { data: instrumento } = await supabase
        .from('instrumentos')
        .select('*')
        .eq('id', instrumento_id)
        .maybeSingle();
    if (!instrumento) return res.status(404).json({ error: 'Instrumento no encontrado.' });
    if (instrumento.estado_fisico === 'En reparación') {
        return res.status(400).json({ error: 'El instrumento está en reparación y no se puede prestar.' });
    }

    const conflicto = await hayConflicto(instrumento.id, fecha_prestamo, fecha_devolucion_limite);
    if (conflicto) return res.status(400).json({ error: conflicto });

    const { data, error } = await supabase
        .from('prestamos')
        .insert([{
            instrumento_id: instrumento.id,
            solicitante,
            ci_solicitante,
            telefono,
            clase_evento,
            fecha_prestamo,
            fecha_devolucion_limite,
            firma_digital,
            estado: 'Activo',
            multa: 0,
            es_virtual: 0,
            estado_salida: instrumento.estado_fisico
        }])
        .select('id')
        .single();
    if (error) throw error;

    await registrarMovimiento('PRÉSTAMO', `Préstamo #${data.id} de "${instrumento.nombre}" a ${solicitante}`, req.usuario.nombre);
    res.json({ mensaje: 'Préstamo registrado', id: data.id });
}));

app.post('/api/prestamos/:id/previsualizar-multa', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data: prestamo } = await supabase
        .from('prestamos')
        .select('fecha_devolucion_limite')
        .eq('id', req.params.id)
        .maybeSingle();
    if (!prestamo) return res.status(404).json({ error: 'Préstamo no encontrado.' });

    const fechaReal = fechaValida(req.body.fecha_devolucion_real) ? req.body.fecha_devolucion_real : ahoraLocal();
    res.json(calcularMulta(prestamo.fecha_devolucion_limite, fechaReal, req.body.nivel_dano));
}));

app.put('/api/prestamos/:id/devolver', autenticar, soloAdmin, ruta(async (req, res) => {
    const { estado_fisico_retorno, nivel_dano } = req.body;
    const observaciones = String(req.body.observaciones || '').trim();
    const fechaReal = fechaValida(req.body.fecha_devolucion_real) ? req.body.fecha_devolucion_real : ahoraLocal();

    if (!ESTADOS_FISICOS.includes(estado_fisico_retorno)) {
        return res.status(400).json({ error: 'Estado físico no válido.' });
    }
    if (!(nivel_dano in CONFIG.multasDano)) {
        return res.status(400).json({ error: 'Nivel de daño no válido.' });
    }

    const { data: prestamo } = await supabase
        .from('prestamos')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
    if (!prestamo) return res.status(404).json({ error: 'Préstamo no encontrado.' });
    if (prestamo.estado !== 'Activo') {
        return res.status(400).json({ error: 'Este préstamo ya fue devuelto.' });
    }

    const m = calcularMulta(prestamo.fecha_devolucion_limite, fechaReal, nivel_dano);

    const { error: errDev } = await supabase
        .from('prestamos')
        .update({
            estado: 'Devuelto',
            multa: m.total,
            multa_retraso: m.multaRetraso,
            multa_dano: m.multaDano,
            nivel_dano,
            estado_retorno: estado_fisico_retorno,
            fecha_devolucion_real: fechaReal,
            observaciones
        })
        .eq('id', prestamo.id);
    if (errDev) throw errDev;

    const { error: errInst } = await supabase
        .from('instrumentos')
        .update({ estado_fisico: estado_fisico_retorno })
        .eq('id', prestamo.instrumento_id);
    if (errInst) throw errInst;

    await registrarMovimiento(
        'DEVOLUCIÓN',
        `Préstamo #${prestamo.id} devuelto. Multa total: ${CONFIG.moneda} ${m.total}`,
        req.usuario.nombre
    );
    res.json({ mensaje: 'Devolución registrada', multa: m.total, detalle: m });
}));

// =====================================================================
//  QR DE PAGOS
// =====================================================================
const RUTAS_QR_POR_DEFECTO = [
    path.join(__dirname, 'frontend', 'qr.png'),
    path.join(__dirname, 'qr.png'),
    path.join(__dirname, 'backend', 'qr.png')
];
const archivoQrPorDefecto = () => RUTAS_QR_POR_DEFECTO.find((rutaArchivo) => fs.existsSync(rutaArchivo));

app.get('/api/qr', ruta(async (req, res) => {
    const { data: fila } = await supabase
        .from('configuracion')
        .select('clave')
        .eq('clave', 'qr_pago')
        .maybeSingle();
    res.json({ existe: Boolean(fila || archivoQrPorDefecto()), subido: Boolean(fila) });
}));

app.get('/api/qr/imagen', ruta(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { data: fila } = await supabase
        .from('configuracion')
        .select('valor')
        .eq('clave', 'qr_pago')
        .maybeSingle();

    if (fila && fila.valor) {
        const coma = fila.valor.indexOf(',');
        const tipo = fila.valor.slice(5, fila.valor.indexOf(';'));
        res.type(tipo);
        return res.send(Buffer.from(fila.valor.slice(coma + 1), 'base64'));
    }
    const archivo = archivoQrPorDefecto();
    if (archivo) return res.sendFile(archivo);
    res.status(404).json({ error: 'Aún no hay un código QR configurado.' });
}));

app.put('/api/qr', autenticar, soloAdmin, ruta(async (req, res) => {
    const imagen = String(req.body.imagen || '');
    if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(imagen)) {
        return res.status(400).json({ error: 'Sube una imagen válida (PNG o JPG).' });
    }

    const { error } = await supabase
        .from('configuracion')
        .upsert([{ clave: 'qr_pago', valor: imagen }], { onConflict: 'clave' });
    if (error) throw error;

    await registrarMovimiento('CONFIGURACIÓN', 'Se actualizó el código QR de pagos', req.usuario.nombre);
    res.json({ mensaje: 'QR guardado' });
}));

app.delete('/api/qr', autenticar, soloAdmin, ruta(async (req, res) => {
    const { error } = await supabase.from('configuracion').delete().eq('clave', 'qr_pago');
    if (error) throw error;

    await registrarMovimiento('CONFIGURACIÓN', 'Se quitó el QR subido', req.usuario.nombre);
    res.json({ mensaje: 'QR eliminado' });
}));

// =====================================================================
//  HISTORIAL Y VARIOS
// =====================================================================
app.get('/api/historial', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data, error } = await supabase
        .from('historial_movimientos')
        .select('*')
        .order('id', { ascending: false })
        .limit(200);
    if (error) throw error;
    res.json(data || []);
}));

app.get('/api/estado', (req, res) => {
    res.json({ mensaje: 'El servidor y Supabase están funcionando 🎵', qr: true });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(DIR_PUBLICO, 'index.html'));
});

asegurarAdminInicial()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Servidor corriendo en http://localhost:${PORT} (conectado a Supabase)`);
            const qr = archivoQrPorDefecto();
            console.log(`QR de pagos: ${qr ? 'archivo encontrado en ' + qr : 'sin qr.png (puedes subirlo desde el panel del admin)'}`);
        });
    })
    .catch((err) => {
        console.error('No se pudo conectar o inicializar Supabase:', err);
        process.exit(1);
    });