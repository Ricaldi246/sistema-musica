const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

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
//  BASE DE DATOS
// =====================================================================
const dbFile = path.join(__dirname, 'backend', 'database.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Error al conectar con la base de datos:', err.message);
    else console.log('Conectado a la Base de Datos SQL exitosamente 🗄️');
});

const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
    });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

async function agregarColumna(tabla, columna, definicion) {
    try { await run(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`); }
    catch (e) { /* la columna ya existe */ }
}

async function iniciarBD() {
    await run(`CREATE TABLE IF NOT EXISTS instrumentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        numero_serie TEXT UNIQUE NOT NULL,
        estado_fisico TEXT NOT NULL,
        imagen TEXT
    )`);
    await agregarColumna('instrumentos', 'imagen', 'TEXT');

    await run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        tipo TEXT NOT NULL,
        ci TEXT,
        telefono TEXT
    )`);

    await run(`CREATE TABLE IF NOT EXISTS reservas_virtuales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrumento_id INTEGER,
        usuario_id INTEGER,
        solicitante TEXT NOT NULL,
        tipo_solicitante TEXT NOT NULL,
        clase_evento TEXT NOT NULL,
        fecha_prestamo TEXT NOT NULL,
        fecha_devolucion_limite TEXT NOT NULL,
        ci TEXT NOT NULL,
        telefono TEXT NOT NULL,
        metodo_pago TEXT NOT NULL,
        monto_adelanto REAL NOT NULL,
        estado_reserva TEXT DEFAULT 'Pendiente',
        FOREIGN KEY(instrumento_id) REFERENCES instrumentos(id),
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS prestamos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrumento_id INTEGER,
        solicitante TEXT NOT NULL,
        ci_solicitante TEXT,
        clase_evento TEXT NOT NULL,
        fecha_prestamo TEXT NOT NULL,
        fecha_devolucion_limite TEXT NOT NULL,
        firma_digital TEXT,
        estado TEXT DEFAULT 'Activo',
        multa REAL DEFAULT 0,
        es_virtual INTEGER DEFAULT 0,
        FOREIGN KEY(instrumento_id) REFERENCES instrumentos(id)
    )`);
    await agregarColumna('prestamos', 'es_virtual', 'INTEGER DEFAULT 0');
    await agregarColumna('prestamos', 'telefono', 'TEXT');
    await agregarColumna('prestamos', 'estado_salida', 'TEXT');
    await agregarColumna('prestamos', 'estado_retorno', 'TEXT');
    await agregarColumna('prestamos', 'nivel_dano', 'TEXT');
    await agregarColumna('prestamos', 'fecha_devolucion_real', 'TEXT');
    await agregarColumna('prestamos', 'multa_retraso', 'REAL DEFAULT 0');
    await agregarColumna('prestamos', 'multa_dano', 'REAL DEFAULT 0');
    await agregarColumna('prestamos', 'observaciones', 'TEXT');

    await run(`CREATE TABLE IF NOT EXISTS historial_movimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo_movimiento TEXT NOT NULL,
        descripcion TEXT NOT NULL,
        detalles_usuario TEXT,
        fecha_hora TEXT NOT NULL
    )`);

    await run(`CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor TEXT
    )`);
    await agregarColumna('reservas_virtuales', 'tarjeta_ultimos4', 'TEXT');

    const admin = await get(`SELECT id FROM usuarios WHERE email = 'admin@academia.com'`);
    if (!admin) {
        await run(`INSERT INTO usuarios (nombre, email, password, tipo) VALUES (?, ?, ?, 'admin')`,
            ['Administrador Principal', 'admin@academia.com', hashPassword('admin123')]);
    }
}

// =====================================================================
//  UTILIDADES
// =====================================================================
function ahoraLocal() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fechaValida = (f) => typeof f === 'string' && f.length >= 16 && !isNaN(new Date(f).getTime());

function registrarMovimiento(tipo, descripcion, detalles = '') {
    return run(`INSERT INTO historial_movimientos (tipo_movimiento, descripcion, detalles_usuario, fecha_hora) VALUES (?, ?, ?, ?)`,
        [tipo, descripcion, detalles, ahoraLocal()]).catch(() => {});
}

const usuarioPublico = (u) => ({ id: u.id, nombre: u.nombre, email: u.email, tipo: u.tipo, ci: u.ci, telefono: u.telefono });

// Contraseñas cifradas con scrypt (viene incluido en Node, no hay que instalar nada)
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}
const esHash = (guardado) => /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(guardado);
function verificarPassword(password, guardado) {
    if (!esHash(guardado)) return password === guardado; // cuentas antiguas en texto plano
    const [salt, hash] = guardado.split(':');
    const original = Buffer.from(hash, 'hex');
    const intento = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(original, intento);
}

// Sesiones en memoria (se pierden si reinicias el servidor)
const sesiones = new Map();
const DURACION_SESION = 8 * 60 * 60 * 1000;

function crearSesion(usuario) {
    const token = crypto.randomBytes(32).toString('hex');
    sesiones.set(token, { id: usuario.id, tipo: usuario.tipo, nombre: usuario.nombre, expira: Date.now() + DURACION_SESION });
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
    if (req.usuario.tipo !== 'admin') return res.status(403).json({ error: 'Esta acción es solo para el administrador.' });
    next();
}

const ruta = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor.' });
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

// Revisa que el instrumento no esté ocupado en ese horario
async function hayConflicto(instrumentoId, salida, limite, excluirReservaId = 0) {
    const activo = await get(
        `SELECT id FROM prestamos
         WHERE instrumento_id = ? AND estado = 'Activo'
           AND ((fecha_prestamo < ? AND fecha_devolucion_limite > ?) OR fecha_devolucion_limite <= ?)
         LIMIT 1`,
        [instrumentoId, limite, salida, ahoraLocal()]
    );
    if (activo) return 'El instrumento tiene un préstamo activo en ese horario o todavía no fue devuelto.';

    const pendiente = await get(
        `SELECT id FROM reservas_virtuales
         WHERE instrumento_id = ? AND estado_reserva = 'Pendiente' AND id != ?
           AND fecha_prestamo < ? AND fecha_devolucion_limite > ?
         LIMIT 1`,
        [instrumentoId, excluirReservaId, limite, salida]
    );
    if (pendiente) return 'Ya existe una reserva pendiente para ese instrumento en ese horario.';
    return null;
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
    try {
        const r = await run(`INSERT INTO usuarios (nombre, email, password, tipo, ci, telefono) VALUES (?, ?, ?, 'cliente', ?, ?)`,
            [nombre, email, hashPassword(password), ci, telefono]);
        res.json({ mensaje: 'Registro exitoso', id: r.lastID });
    } catch (err) {
        if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'El correo electrónico ya está registrado.' });
        throw err;
    }
}));

app.post('/api/login', ruta(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const usuario = await get(`SELECT * FROM usuarios WHERE lower(email) = ?`, [email]);
    if (!usuario || !verificarPassword(password, usuario.password)) {
        return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }
    if (!esHash(usuario.password)) {
        await run(`UPDATE usuarios SET password = ? WHERE id = ?`, [hashPassword(password), usuario.id]);
    }
    res.json({ mensaje: 'Login exitoso', usuario: usuarioPublico(usuario), token: crearSesion(usuario) });
}));

app.post('/api/logout', autenticar, (req, res) => {
    sesiones.delete(req.token);
    res.json({ mensaje: 'Sesión cerrada' });
});

// Cambiar la propia contraseña (admin o usuario)
app.post('/api/cambiar-password', autenticar, ruta(async (req, res) => {
    const actual = String(req.body.actual || '');
    const nueva = String(req.body.nueva || '');
    if (nueva.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    if (nueva === actual) return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual.' });

    const usuario = await get(`SELECT * FROM usuarios WHERE id = ?`, [req.usuario.id]);
    if (!usuario || !verificarPassword(actual, usuario.password)) {
        return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    }
    await run(`UPDATE usuarios SET password = ? WHERE id = ?`, [hashPassword(nueva), usuario.id]);
    // se cierran las demás sesiones abiertas de esta cuenta
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
    res.json(await all(`SELECT * FROM instrumentos ORDER BY id DESC`));
}));

// IDs de instrumentos que están en uso en este momento (dato público, sin datos personales)
app.get('/api/disponibilidad', ruta(async (req, res) => {
    const filas = await all(
        `SELECT DISTINCT instrumento_id FROM prestamos WHERE estado = 'Activo' AND fecha_prestamo <= ?`,
        [ahoraLocal()]
    );
    res.json({ ocupados: filas.map((f) => f.instrumento_id) });
}));

app.post('/api/instrumentos', autenticar, soloAdmin, ruta(async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
    const tipo = String(req.body.tipo || '').trim();
    const numero_serie = String(req.body.numero_serie || '').trim();
    const { estado_fisico } = req.body;
    const imagen = req.body.imagen || '';

    if (!nombre || !tipo || !numero_serie) return res.status(400).json({ error: 'Completa nombre, tipo y número de serie.' });
    if (!ESTADOS_FISICOS.includes(estado_fisico)) return res.status(400).json({ error: 'Estado físico no válido.' });
    if (imagen && !String(imagen).startsWith('data:image/')) return res.status(400).json({ error: 'La imagen no es válida.' });

    try {
        const r = await run(`INSERT INTO instrumentos (nombre, tipo, numero_serie, estado_fisico, imagen) VALUES (?, ?, ?, ?, ?)`,
            [nombre, tipo, numero_serie, estado_fisico, imagen]);
        await registrarMovimiento('INSTRUMENTO', `Se registró "${nombre}" (serie ${numero_serie})`, req.usuario.nombre);
        res.json({ mensaje: 'Registrado con éxito', id: r.lastID });
    } catch (err) {
        if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'El número de serie ya existe.' });
        throw err;
    }
}));

app.put('/api/instrumentos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const { estado_fisico } = req.body;
    if (!ESTADOS_FISICOS.includes(estado_fisico)) return res.status(400).json({ error: 'Estado físico no válido.' });
    const r = await run(`UPDATE instrumentos SET estado_fisico = ? WHERE id = ?`, [estado_fisico, req.params.id]);
    if (!r.changes) return res.status(404).json({ error: 'Instrumento no encontrado.' });
    await registrarMovimiento('INSTRUMENTO', `Instrumento #${req.params.id} cambió a "${estado_fisico}"`, req.usuario.nombre);
    res.json({ mensaje: 'Estado actualizado' });
}));

app.delete('/api/instrumentos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const uso = await get(
        `SELECT (SELECT COUNT(*) FROM prestamos WHERE instrumento_id = ?) +
                (SELECT COUNT(*) FROM reservas_virtuales WHERE instrumento_id = ?) AS total`,
        [req.params.id, req.params.id]
    );
    if (uso.total > 0) {
        return res.status(400).json({ error: 'Este instrumento tiene historial de préstamos o reservas, no se puede eliminar. Cámbialo a "En reparación" para retirarlo del préstamo.' });
    }
    await run(`DELETE FROM instrumentos WHERE id = ?`, [req.params.id]);
    await registrarMovimiento('INSTRUMENTO', `Se eliminó el instrumento #${req.params.id}`, req.usuario.nombre);
    res.json({ mensaje: 'Eliminado con éxito' });
}));

// =====================================================================
//  RESERVAS VIRTUALES
// =====================================================================
app.post('/api/reservas', autenticar, ruta(async (req, res) => {
    const { instrumento_id, tipo_solicitante, clase_evento, fecha_prestamo, fecha_devolucion_limite, ci, telefono, metodo_pago, tarjeta_ultimos4 } = req.body;

    if (!instrumento_id || !clase_evento || !ci || !telefono || !fechaValida(fecha_prestamo) || !fechaValida(fecha_devolucion_limite)) {
        return res.status(400).json({ error: 'Faltan campos obligatorios para la reserva.' });
    }
    if (new Date(fecha_devolucion_limite) <= new Date(fecha_prestamo)) {
        return res.status(400).json({ error: 'La fecha límite debe ser posterior a la fecha de salida.' });
    }
    if (new Date(fecha_devolucion_limite) <= new Date()) {
        return res.status(400).json({ error: 'La fecha límite ya pasó.' });
    }

    const instrumento = await get(`SELECT * FROM instrumentos WHERE id = ?`, [instrumento_id]);
    if (!instrumento) return res.status(404).json({ error: 'Instrumento no encontrado.' });
    if (instrumento.estado_fisico === 'En reparación') {
        return res.status(400).json({ error: 'El instrumento está en reparación y no se puede reservar.' });
    }
    const conflicto = await hayConflicto(instrumento.id, fecha_prestamo, fecha_devolucion_limite);
    if (conflicto) return res.status(400).json({ error: conflicto });

    const metodo = metodo_pago === 'qr' ? 'qr' : 'tarjeta';
    // Nunca se recibe ni se guarda el número completo ni el CVV: solo los últimos 4 dígitos
    const ultimos4 = metodo === 'tarjeta' ? String(tarjeta_ultimos4 || '') : null;
    if (metodo === 'tarjeta' && !/^\d{4}$/.test(ultimos4)) {
        return res.status(400).json({ error: 'Faltan los datos de la tarjeta.' });
    }
    const r = await run(
        `INSERT INTO reservas_virtuales (instrumento_id, usuario_id, solicitante, tipo_solicitante, clase_evento, fecha_prestamo, fecha_devolucion_limite, ci, telefono, metodo_pago, monto_adelanto, tarjeta_ultimos4, estado_reserva)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente')`,
        [instrumento.id, req.usuario.id, req.usuario.nombre, tipo_solicitante || 'Alumno', clase_evento, fecha_prestamo, fecha_devolucion_limite, ci, telefono, metodo, CONFIG.adelantoReserva, ultimos4]
    );
    await registrarMovimiento('RESERVA', `Reserva #${r.lastID} de "${instrumento.nombre}"`, req.usuario.nombre);
    res.json({ mensaje: 'Reserva virtual enviada con éxito', id: r.lastID });
}));

app.get('/api/reservas', autenticar, soloAdmin, ruta(async (req, res) => {
    res.json(await all(`
        SELECT r.*, i.nombre AS instrumento_nombre, i.numero_serie
        FROM reservas_virtuales r
        LEFT JOIN instrumentos i ON r.instrumento_id = i.id
        ORDER BY r.id DESC`));
}));

app.get('/api/mis-reservas', autenticar, ruta(async (req, res) => {
    res.json(await all(`
        SELECT r.*, i.nombre AS instrumento_nombre, i.numero_serie
        FROM reservas_virtuales r
        LEFT JOIN instrumentos i ON r.instrumento_id = i.id
        WHERE r.usuario_id = ?
        ORDER BY r.id DESC`, [req.usuario.id]));
}));

app.post('/api/reservas/:id/aceptar', autenticar, soloAdmin, ruta(async (req, res) => {
    const reserva = await get(`SELECT * FROM reservas_virtuales WHERE id = ?`, [req.params.id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (reserva.estado_reserva !== 'Pendiente') return res.status(400).json({ error: 'Esta reserva ya fue procesada.' });

    const instrumento = await get(`SELECT * FROM instrumentos WHERE id = ?`, [reserva.instrumento_id]);
    if (!instrumento) return res.status(400).json({ error: 'El instrumento ya no existe.' });
    if (instrumento.estado_fisico === 'En reparación') {
        return res.status(400).json({ error: 'El instrumento está en reparación.' });
    }
    const conflicto = await hayConflicto(reserva.instrumento_id, reserva.fecha_prestamo, reserva.fecha_devolucion_limite, reserva.id);
    if (conflicto) return res.status(400).json({ error: conflicto });

    await run(
        `INSERT INTO prestamos (instrumento_id, solicitante, ci_solicitante, telefono, clase_evento, fecha_prestamo, fecha_devolucion_limite, firma_digital, estado, multa, es_virtual, estado_salida)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Activo', 0, 1, ?)`,
        [reserva.instrumento_id, reserva.solicitante, reserva.ci, reserva.telefono, reserva.clase_evento,
         reserva.fecha_prestamo, reserva.fecha_devolucion_limite,
         `Reserva virtual - adelanto ${CONFIG.moneda} ${reserva.monto_adelanto}`, instrumento.estado_fisico]
    );
    await run(`UPDATE reservas_virtuales SET estado_reserva = 'Aceptada' WHERE id = ?`, [reserva.id]);
    await registrarMovimiento('RESERVA', `Reserva #${reserva.id} aceptada`, req.usuario.nombre);
    res.json({ mensaje: 'Reserva aceptada y registrada como préstamo virtual' });
}));

app.post('/api/reservas/:id/rechazar', autenticar, soloAdmin, ruta(async (req, res) => {
    const reserva = await get(`SELECT estado_reserva FROM reservas_virtuales WHERE id = ?`, [req.params.id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada.' });
    if (reserva.estado_reserva !== 'Pendiente') return res.status(400).json({ error: 'Esta reserva ya fue procesada.' });
    await run(`UPDATE reservas_virtuales SET estado_reserva = 'Rechazada' WHERE id = ?`, [req.params.id]);
    await registrarMovimiento('RESERVA', `Reserva #${req.params.id} rechazada`, req.usuario.nombre);
    res.json({ mensaje: 'Reserva rechazada' });
}));

// =====================================================================
//  PRÉSTAMOS Y DEVOLUCIONES
// =====================================================================
const CAMPOS_LISTA_PRESTAMO = `
    p.id, p.instrumento_id, p.solicitante, p.ci_solicitante, p.telefono, p.clase_evento,
    p.fecha_prestamo, p.fecha_devolucion_limite, p.fecha_devolucion_real, p.estado,
    p.multa, p.multa_retraso, p.multa_dano, p.nivel_dano, p.estado_salida, p.estado_retorno,
    p.es_virtual, i.nombre, i.numero_serie`;

app.get('/api/prestamos', autenticar, soloAdmin, ruta(async (req, res) => {
    res.json(await all(`
        SELECT ${CAMPOS_LISTA_PRESTAMO}
        FROM prestamos p
        LEFT JOIN instrumentos i ON p.instrumento_id = i.id
        ORDER BY p.id DESC`));
}));

// Detalle completo (incluye la firma) para mostrar el acta
app.get('/api/prestamos/:id', autenticar, soloAdmin, ruta(async (req, res) => {
    const prestamo = await get(`
        SELECT p.*, i.nombre, i.numero_serie
        FROM prestamos p
        LEFT JOIN instrumentos i ON p.instrumento_id = i.id
        WHERE p.id = ?`, [req.params.id]);
    if (!prestamo) return res.status(404).json({ error: 'Préstamo no encontrado.' });
    res.json(prestamo);
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

    const instrumento = await get(`SELECT * FROM instrumentos WHERE id = ?`, [instrumento_id]);
    if (!instrumento) return res.status(404).json({ error: 'Instrumento no encontrado.' });
    if (instrumento.estado_fisico === 'En reparación') {
        return res.status(400).json({ error: 'El instrumento está en reparación y no se puede prestar.' });
    }
    const conflicto = await hayConflicto(instrumento.id, fecha_prestamo, fecha_devolucion_limite);
    if (conflicto) return res.status(400).json({ error: conflicto });

    const r = await run(
        `INSERT INTO prestamos (instrumento_id, solicitante, ci_solicitante, telefono, clase_evento, fecha_prestamo, fecha_devolucion_limite, firma_digital, estado, multa, es_virtual, estado_salida)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Activo', 0, 0, ?)`,
        [instrumento.id, solicitante, ci_solicitante, telefono, clase_evento, fecha_prestamo, fecha_devolucion_limite, firma_digital, instrumento.estado_fisico]
    );
    await registrarMovimiento('PRÉSTAMO', `Préstamo #${r.lastID} de "${instrumento.nombre}" a ${solicitante}`, req.usuario.nombre);
    res.json({ mensaje: 'Préstamo registrado', id: r.lastID });
}));

// Vista previa de la multa antes de confirmar la devolución
app.post('/api/prestamos/:id/previsualizar-multa', autenticar, soloAdmin, ruta(async (req, res) => {
    const prestamo = await get(`SELECT fecha_devolucion_limite FROM prestamos WHERE id = ?`, [req.params.id]);
    if (!prestamo) return res.status(404).json({ error: 'Préstamo no encontrado.' });
    const fechaReal = fechaValida(req.body.fecha_devolucion_real) ? req.body.fecha_devolucion_real : ahoraLocal();
    res.json(calcularMulta(prestamo.fecha_devolucion_limite, fechaReal, req.body.nivel_dano));
}));

app.put('/api/prestamos/:id/devolver', autenticar, soloAdmin, ruta(async (req, res) => {
    const { estado_fisico_retorno, nivel_dano } = req.body;
    const observaciones = String(req.body.observaciones || '').trim();
    const fechaReal = fechaValida(req.body.fecha_devolucion_real) ? req.body.fecha_devolucion_real : ahoraLocal();

    if (!ESTADOS_FISICOS.includes(estado_fisico_retorno)) return res.status(400).json({ error: 'Estado físico no válido.' });
    if (!(nivel_dano in CONFIG.multasDano)) return res.status(400).json({ error: 'Nivel de daño no válido.' });

    const prestamo = await get(`SELECT * FROM prestamos WHERE id = ?`, [req.params.id]);
    if (!prestamo) return res.status(404).json({ error: 'Préstamo no encontrado.' });
    if (prestamo.estado !== 'Activo') return res.status(400).json({ error: 'Este préstamo ya fue devuelto.' });

    const m = calcularMulta(prestamo.fecha_devolucion_limite, fechaReal, nivel_dano);

    await run(
        `UPDATE prestamos SET estado = 'Devuelto', multa = ?, multa_retraso = ?, multa_dano = ?, nivel_dano = ?,
                estado_retorno = ?, fecha_devolucion_real = ?, observaciones = ? WHERE id = ?`,
        [m.total, m.multaRetraso, m.multaDano, nivel_dano, estado_fisico_retorno, fechaReal, observaciones, prestamo.id]
    );
    await run(`UPDATE instrumentos SET estado_fisico = ? WHERE id = ?`, [estado_fisico_retorno, prestamo.instrumento_id]);
    await registrarMovimiento('DEVOLUCIÓN', `Préstamo #${prestamo.id} devuelto. Multa total: ${CONFIG.moneda} ${m.total}`, req.usuario.nombre);
    res.json({ mensaje: 'Devolución registrada', multa: m.total, detalle: m });
}));

// =====================================================================
//  QR DE PAGOS
//  Prioridad: 1) el QR subido desde el panel del admin
//             2) un archivo qr.png (frontend/, raíz del proyecto o backend/)
// =====================================================================
const RUTAS_QR_POR_DEFECTO = [
    path.join(__dirname, 'frontend', 'qr.png'),
    path.join(__dirname, 'qr.png'),
    path.join(__dirname, 'backend', 'qr.png')
];
const archivoQrPorDefecto = () => RUTAS_QR_POR_DEFECTO.find((ruta) => fs.existsSync(ruta));

app.get('/api/qr', ruta(async (req, res) => {
    const fila = await get(`SELECT clave FROM configuracion WHERE clave = 'qr_pago'`);
    res.json({ existe: Boolean(fila || archivoQrPorDefecto()), subido: Boolean(fila) });
}));

app.get('/api/qr/imagen', ruta(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const fila = await get(`SELECT valor FROM configuracion WHERE clave = 'qr_pago'`);
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
    await run(`INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('qr_pago', ?)`, [imagen]);
    await registrarMovimiento('CONFIGURACIÓN', 'Se actualizó el código QR de pagos', req.usuario.nombre);
    res.json({ mensaje: 'QR guardado' });
}));

app.delete('/api/qr', autenticar, soloAdmin, ruta(async (req, res) => {
    await run(`DELETE FROM configuracion WHERE clave = 'qr_pago'`);
    await registrarMovimiento('CONFIGURACIÓN', 'Se quitó el QR subido', req.usuario.nombre);
    res.json({ mensaje: 'QR eliminado' });
}));

// =====================================================================
//  HISTORIAL Y VARIOS
// =====================================================================
app.get('/api/historial', autenticar, soloAdmin, ruta(async (req, res) => {
    res.json(await all(`SELECT * FROM historial_movimientos ORDER BY id DESC LIMIT 200`));
}));

app.get('/api/estado', (req, res) => {
    res.json({ mensaje: 'El servidor y la Base de Datos SQL están funcionando 🎵', qr: true });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

iniciarBD()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Servidor corriendo en http://localhost:${PORT}`);
            const qr = archivoQrPorDefecto();
            console.log(`QR de pagos: ${qr ? 'archivo encontrado en ' + qr : 'sin qr.png (puedes subirlo desde el panel del admin)'}`);
        });
    })
    .catch((err) => {
        console.error('No se pudo iniciar la base de datos:', err);
        process.exit(1);
    });