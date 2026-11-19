const supabase = require('./supabase');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

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

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

// =====================================================================
//  UTILIDADES
// =====================================================================
function ahoraLocal() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fechaValida = (f) => typeof f === 'string' && f.length >= 16 && !isNaN(new Date(f).getTime());

async function registrarMovimiento(tipo, descripcion, detalles = '') {
    try {
        await supabase.from('historial_movimientos').insert([{
            tipo_movimiento: tipo,
            descripcion,
            detalles_usuario: detalles,
            fecha_hora: ahoraLocal()
        }]);
    } catch (_) {
        // no interrumpir el flujo principal si falla el log
    }
}

const usuarioPublico = (u) => ({
    id: u.id,
    nombre: u.nombre,
    email: u.email,
    tipo: u.tipo,
    ci: u.ci,
    telefono: u.telefono
});

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

// Sesiones en memoria
const sesiones = new Map();
const DURACION_SESION = 8 * 60 * 60 * 1000;

function crearSesion(usuario) {
    const token = crypto.randomBytes(32).toString('hex');
    sesiones.set(token, {
        id: usuario.id,
        tipo: usuario.tipo,
        nombre: usuario.nombre,
        expira: Date.now() + DURACION_SESION
    });
    return token;
}

function autenticar(req, res, next) {
    const cabecera = req.headers.authorization || '';
    const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
    const sesion = token ? sesiones.get(token) : null;
    if (!sesion || sesion.expira < Date.now()) {
        if (token) sesiones.delete(token);
        return res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
    }
    req.usuario = sesion;
    req.token = token;
    next();
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
        res.status(500).json({ error: err.message || 'Error interno del servidor.' });
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
    const { data: admin, error } = await supabase
        .from('usuarios')
        .select('id')
        .eq('email', 'admin@academia.com')
        .maybeSingle();
    if (error) throw error;

    if (!admin) {
        const { error: errInsert } = await supabase
            .from('usuarios')
            .insert([{
                nombre: 'Administrador Principal',
                email: 'admin@academia.com',
                password: hashPassword('admin123'),
                tipo: 'admin'
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
    if (password.length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
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
            telefono
        }])
        .select('id')
        .single();
    if (error) throw error;

    res.json({ mensaje: 'Registro exitoso', id: data.id });
}));

app.post('/api/login', ruta(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('email', email)
        .maybeSingle();
    if (error) throw error;

    if (!usuario || !verificarPassword(password, usuario.password)) {
        return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }
    if (!esHash(usuario.password)) {
        await supabase
            .from('usuarios')
            .update({ password: hashPassword(password) })
            .eq('id', usuario.id);
    }
    res.json({
        mensaje: 'Login exitoso',
        usuario: usuarioPublico(usuario),
        token: crearSesion(usuario)
    });
}));

app.post('/api/logout', autenticar, (req, res) => {
    sesiones.delete(req.token);
    res.json({ mensaje: 'Sesión cerrada' });
});

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

    for (const [token, sesion] of sesiones) {
        if (sesion.id === usuario.id && token !== req.token) sesiones.delete(token);
    }
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
    const numero_serie = String(req.body.numero_serie || '').trim();
    const { estado_fisico } = req.body;
    const imagen = req.body.imagen || '';

    if (!nombre || !tipo || !numero_serie) {
        return res.status(400).json({ error: 'Completa nombre, tipo y número de serie.' });
    }
    if (!ESTADOS_FISICOS.includes(estado_fisico)) {
        return res.status(400).json({ error: 'Estado físico no válido.' });
    }
    if (imagen && !String(imagen).startsWith('data:image/')) {
        return res.status(400).json({ error: 'La imagen no es válida.' });
    }

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
        .insert([{ nombre, tipo, numero_serie, estado_fisico, imagen }])
        .select('id')
        .single();
    if (error) throw error;

    await registrarMovimiento('INSTRUMENTO', `Se registró "${nombre}" (serie ${numero_serie})`, req.usuario.nombre);
    res.json({ mensaje: 'Registrado con éxito', id: data.id });
}));

app.put('/api/instrumentos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const { estado_fisico } = req.body;
    if (!ESTADOS_FISICOS.includes(estado_fisico)) {
        return res.status(400).json({ error: 'Estado físico no válido.' });
    }

    const { data, error } = await supabase
        .from('instrumentos')
        .update({ estado_fisico })
        .eq('id', req.params.id)
        .select('id')
        .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Instrumento no encontrado.' });

    await registrarMovimiento('INSTRUMENTO', `Instrumento #${req.params.id} cambió a "${estado_fisico}"`, req.usuario.nombre);
    res.json({ mensaje: 'Estado actualizado' });
}));

app.delete('/api/instrumentos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const { count: cPrestamos } = await supabase
        .from('prestamos')
        .select('*', { count: 'exact', head: true })
        .eq('instrumento_id', req.params.id);

    const { count: cReservas } = await supabase
        .from('reservas_virtuales')
        .select('*', { count: 'exact', head: true })
        .eq('instrumento_id', req.params.id);

    if ((cPrestamos || 0) + (cReservas || 0) > 0) {
        return res.status(400).json({
            error: 'Este instrumento tiene historial de préstamos o reservas, no se puede eliminar. Cámbialo a "En reparación" para retirarlo del préstamo.'
        });
    }

    const { error } = await supabase.from('instrumentos').delete().eq('id', req.params.id);
    if (error) throw error;

    await registrarMovimiento('INSTRUMENTO', `Se eliminó el instrumento #${req.params.id}`, req.usuario.nombre);
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
    if (new Date(fecha_devolucion_limite) <= new Date()) {
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
            tipo_solicitante: tipo_solicitante || 'Alumno',
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

app.post('/api/reservas/:id/aceptar', autenticar, soloAdmin, ruta(async (req, res) => {
    const { data: reserva } = await supabase
        .from('reservas_virtuales')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (reserva.estado_reserva !== 'Pendiente') {
        return res.status(400).json({ error: 'Esta reserva ya fue procesada.' });
    }

    const { data: instrumento } = await supabase
        .from('instrumentos')
        .select('*')
        .eq('id', reserva.instrumento_id)
        .maybeSingle();
    if (!instrumento) return res.status(400).json({ error: 'El instrumento ya no existe.' });
    if (instrumento.estado_fisico === 'En reparación') {
        return res.status(400).json({ error: 'El instrumento está en reparación.' });
    }

    const conflicto = await hayConflicto(
        reserva.instrumento_id,
        reserva.fecha_prestamo,
        reserva.fecha_devolucion_limite,
        reserva.id
    );
    if (conflicto) return res.status(400).json({ error: conflicto });

    const { error: errIns } = await supabase.from('prestamos').insert([{
        instrumento_id: reserva.instrumento_id,
        solicitante: reserva.solicitante,
        ci_solicitante: reserva.ci,
        telefono: reserva.telefono,
        clase_evento: reserva.clase_evento,
        fecha_prestamo: reserva.fecha_prestamo,
        fecha_devolucion_limite: reserva.fecha_devolucion_limite,
        firma_digital: `Reserva virtual - adelanto ${CONFIG.moneda} ${reserva.monto_adelanto}`,
        estado: 'Activo',
        multa: 0,
        es_virtual: 1,
        estado_salida: instrumento.estado_fisico
    }]);
    if (errIns) throw errIns;

    const { error: errUpd } = await supabase
        .from('reservas_virtuales')
        .update({ estado_reserva: 'Aceptada' })
        .eq('id', reserva.id);
    if (errUpd) throw errUpd;

    await registrarMovimiento('RESERVA', `Reserva #${reserva.id} aceptada`, req.usuario.nombre);
    res.json({ mensaje: 'Reserva aceptada y registrada como préstamo virtual' });
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
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
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