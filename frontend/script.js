// =====================================================================
//  ESTADO GLOBAL Y UTILIDADES
// =====================================================================
let intervaloCronometro = null;
let listaInstrumentosCache = [];
let prestamosCache = [];
let qrDisponible = false;
let config = { moneda: 'Bs', tarifaRetrasoPorDia: 10, horasGracia: 1, topeMultaRetraso: 100, adelantoReserva: 25, multasDano: {} };
const ESTADOS_FISICOS = ['Óptimo', 'Desgaste regular', 'En reparación'];

const $ = (id) => document.getElementById(id);

// Escapa texto para que nadie pueda inyectar HTML/JS desde un nombre o comentario
function esc(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Aviso flotante que se cierra solo (no hay que pulsar "Aceptar")
function toast(mensaje, tipo = 'info') {
    const contenedor = $('toast-container');
    if (!contenedor) return;
    if ([...contenedor.children].some((t) => t.textContent === mensaje)) return; // evita avisos repetidos
    const aviso = document.createElement('div');
    aviso.className = `toast toast-${tipo}`;
    aviso.setAttribute('role', 'status');
    aviso.textContent = mensaje;
    aviso.addEventListener('click', () => aviso.remove());
    contenedor.appendChild(aviso);
    setTimeout(() => aviso.remove(), tipo === 'error' ? 5000 : 3000);
}

// Confirmación sin ventanas emergentes: el botón cambia a "¿Seguro?" durante 3 segundos
function confirmarClic(boton) {
    if (boton.dataset.confirmando === '1') return true;
    boton.dataset.confirmando = '1';
    boton.dataset.original = boton.innerHTML;
    boton.innerHTML = '¿Seguro?';
    boton.classList.add('btn-confirmar');
    setTimeout(() => {
        if (!boton.isConnected) return;
        boton.innerHTML = boton.dataset.original;
        boton.classList.remove('btn-confirmar');
        delete boton.dataset.confirmando;
    }, 3000);
    return false;
}

const pad = (n) => String(n).padStart(2, '0');
const moneda = (n) => `${config.moneda} ${Number(n || 0).toFixed(2)}`;
const verFecha = (f) => esc(String(f || '—').replace('T', ' '));

// Fecha/hora local en el formato de <input type="datetime-local">
function ahoraLocalInput() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getSesion() {
    try { return JSON.parse(localStorage.getItem('sesion')); } catch (e) { return null; }
}
function guardarSesion(sesion) { localStorage.setItem('sesion', JSON.stringify(sesion)); }

// Todas las llamadas al servidor pasan por aquí (envía el token y maneja errores)
async function api(url, opciones = {}) {
    const sesion = getSesion();
    const headers = { 'Content-Type': 'application/json' };
    if (sesion && sesion.token) headers.Authorization = `Bearer ${sesion.token}`;

    const res = await fetch(url, {
        method: opciones.method || 'GET',
        headers,
        body: opciones.body !== undefined ? JSON.stringify(opciones.body) : undefined
    });

    let data = {};
    try { data = await res.json(); } catch (e) { /* sin cuerpo */ }

    if (res.status === 401 && sesion) {
        localStorage.removeItem('sesion');
        sessionStorage.setItem('aviso', 'Tu sesión expiró. Inicia sesión de nuevo.');
        location.reload();
        throw new Error(data.error || 'Sesión expirada');
    }
    if (!res.ok) {
        if (data.error) throw new Error(data.error);
        if (res.status === 404) {
            throw new Error('El servidor no reconoce esta acción (404). Detén el servidor y vuelve a iniciarlo con "npm start" para cargar la versión nueva.');
        }
        if (res.status === 413) throw new Error('La imagen es demasiado grande. Prueba con una más pequeña.');
        throw new Error(`Error del servidor (código ${res.status}).`);
    }
    return data;
}

async function cargarConfig() {
    try { config = await api('/api/config'); } catch (e) { console.error('No se pudo cargar la configuración', e); }
}

// =====================================================================
//  LÁMPARA INTERACTIVA (ANIMACIÓN LOGIN)
// =====================================================================
const room = $('room');
const handle = $('stringHandle');
const path = $('stringPath');
const fireflies = $('fireflies');

let isOn = false;
let dragging = false;
let startX = 0;
let startY = 0;
let dragX = 0;
let dragY = 0;

function setLamp(on) {
    isOn = on;
    if (room) room.classList.toggle('on', isOn);
    if (isOn) createFireflies();
    else if (fireflies) fireflies.innerHTML = '';
}

function updateString(x, y) {
    if (path) path.setAttribute('d', `M 0 0 L ${x} ${80 + y}`);
}

function resetHandle() {
    if (handle) {
        handle.style.transform = 'translate(0px, 0px)';
        updateString(0, 0);
    }
}

if (handle) {
    handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        handle.classList.add('dragging');
        startX = e.clientX;
        startY = e.clientY;
        dragX = 0;
        dragY = 0;
        if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        dragX = (e.clientX - startX) * 0.3;
        dragY = Math.max(0, e.clientY - startY) * 0.6;
        dragX = Math.max(-35, Math.min(35, dragX));
        dragY = Math.min(180, dragY);
        handle.style.transform = `translate(${dragX}px, ${dragY}px)`;
        updateString(dragX, dragY);
    });
    handle.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        const pulled = dragY > 30;
        resetHandle();
        if (pulled) setLamp(!isOn);
    });
}

function random(min, max) { return Math.random() * (max - min) + min; }

function createFireflies() {
    if (!fireflies) return;
    fireflies.innerHTML = '';
    for (let i = 0; i < 18; i++) {
        const dot = document.createElement('span');
        dot.className = 'firefly';
        const size = random(3, 7);
        dot.style.width = `${size}px`;
        dot.style.height = `${size}px`;
        dot.style.setProperty('--duration', `${random(35, 65)}s`);
        dot.style.setProperty('--delay', `${random(0, 3)}s`);
        for (let n = 1; n <= 5; n++) {
            dot.style.setProperty(`--x${n}`, `${random(0, 100)}vw`);
            dot.style.setProperty(`--y${n}`, `${random(0, 100)}vh`);
        }
        fireflies.appendChild(dot);
    }
}

// =====================================================================
//  NAVEGACIÓN ENTRE VISTAS Y MODALES
// =====================================================================
function mostrarVista(nombre) {
    if (room) room.style.display = nombre === 'login' ? 'flex' : 'none';
    $('vista-catalogo').style.display = nombre === 'catalogo' ? 'block' : 'none';
    $('vista-admin').style.display = nombre === 'admin' ? 'block' : 'none';
    if (nombre !== 'login') setLamp(false); // apaga las luciérnagas fuera del login
    const capa = $('decoracion');
    if (capa) {
        capa.hidden = nombre === 'login';
        capa.className = `decoracion vista-${nombre}`;
        if (nombre !== 'login') crearNotasDecorativas();
    }
}

function abrirModal(id) { $(id).style.display = 'flex'; }
function cerrarModal(id) {
    const modal = $(id);
    modal.style.display = 'none';
    ocultarPasswords(modal);
}

function mostrarPaginaAdmin() {
    mostrarVista('admin');
    cambiarPanel(0);
    actualizarContadorBandejaAdmin();
}

function volverAlCatalogo() {
    mostrarVista('catalogo');
    verificarSesionUI();
    cargarCatalogo();
}

function toggleMenuAdmin() {
    const menu = $('menu-admin');
    const abierto = menu.classList.toggle('abierto');
    $('btn-hamburguesa').setAttribute('aria-expanded', String(abierto));
}

function cerrarMenuAdmin() {
    const menu = $('menu-admin');
    if (menu) menu.classList.remove('abierto');
    const boton = $('btn-hamburguesa');
    if (boton) boton.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu-admin') && !e.target.closest('#btn-hamburguesa')) cerrarMenuAdmin();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { cerrarMenuAdmin(); cerrarModal('modal-qr-pantalla'); }
});

function cambiarPanel(indicePanel) {
    document.querySelectorAll('.panel').forEach((panel, index) => {
        panel.classList.toggle('activo', index === indicePanel);
    });
    document.querySelectorAll('#menu-admin button').forEach((boton, index) => {
        boton.classList.toggle('activo', index === indicePanel);
    });
    cerrarMenuAdmin();

    if (intervaloCronometro) { clearInterval(intervaloCronometro); intervaloCronometro = null; }

    if (indicePanel === 1) cargarInstrumentos();
    else if (indicePanel === 2) cargarSelectInstrumentosParaPrestamo();
    else if (indicePanel === 3) cargarPrestamosYDevoluciones();
}

// =====================================================================
//  LOGIN, REGISTRO Y SESIÓN
// =====================================================================
async function ejecutarLogin(e) {
    e.preventDefault();
    const email = $('login-email').value;
    const password = $('login-password').value;

    try {
        const data = await api('/api/login', { method: 'POST', body: { email, password } });
        guardarSesion({ token: data.token, usuario: data.usuario });
        $('login-password').value = '';
        ocultarPasswords($('form-login'));
        if (data.usuario.tipo === 'admin') {
            mostrarPaginaAdmin();
        } else {
            verificarSesionUI();
            volverAlCatalogo();
        }
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function ejecutarRegistro(e) {
    e.preventDefault();
    try {
        await api('/api/registro', {
            method: 'POST',
            body: {
                nombre: $('reg-nombre').value,
                email: $('reg-email').value,
                password: $('reg-password').value,
                ci: $('reg-ci').value,
                telefono: $('reg-telefono').value
            }
        });
        $('login-email').value = $('reg-email').value; // deja el correo listo en el login
        $('form-registro').reset();
        cerrarModal('modal-registro');
        $('login-password').focus();
    } catch (err) {
        toast(err.message, 'error');
    }
}

function verificarSesionUI() {
    const sesion = getSesion();
    const nav = $('auth-nav');
    const navAdmin = $('nav-admin-catalogo');
    if (!(sesion && sesion.usuario && nav)) return;

    const esAdmin = sesion.usuario.tipo === 'admin';
    nav.innerHTML = `
        ${esAdmin ? '' : '<button class="btn btn-dark" onclick="abrirBandejaCliente()">✉️ Mis Notificaciones</button>'}
        <button class="btn btn-dark" onclick="abrirModalPassword()" title="Cambiar mi contraseña">🔑 Contraseña</button>
        <span class="usuario-nombre">👤 ${esc(sesion.usuario.nombre)}</span>
        <button class="btn btn-danger" onclick="cerrarSesionCliente()">Salir</button>
    `;
    // Solo el administrador ve este botón, arriba a la izquierda
    if (navAdmin) {
        navAdmin.innerHTML = esAdmin
            ? `<button class="btn btn-admin" onclick="mostrarPaginaAdmin()">⚙️ Página del administrador</button>`
            : '';
    }
}

async function cerrarSesion() {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* aunque falle, cerramos igual */ }
    localStorage.removeItem('sesion');
    location.reload();
}
function cerrarSesionCliente() { cerrarSesion(); }
function cerrarSesionAdmin() { cerrarSesion(); }

// =====================================================================
//  BANDEJAS (ADMIN Y CLIENTE)
// =====================================================================
async function actualizarContadorBandejaAdmin() {
    try {
        const reservas = await api('/api/reservas');
        const pendientes = reservas.filter((r) => r.estado_reserva === 'Pendiente');
        $('contador-bandeja').textContent = pendientes.length;
    } catch (err) { console.error(err); }
}

async function abrirBandejaAdmin() {
    try {
        const reservas = await api('/api/reservas');
        const contenedor = $('lista-solicitudes-admin');
        contenedor.innerHTML = '';

        if (reservas.length === 0) {
            contenedor.innerHTML = `<p class="vacio">No hay solicitudes de reserva.</p>`;
            abrirModal('modal-bandeja-admin');
            return;
        }

        reservas.forEach((r) => {
            const color = r.estado_reserva === 'Pendiente' ? '#f39c12' : (r.estado_reserva === 'Aceptada' ? '#27ae60' : '#e74c3c');
            const acciones = r.estado_reserva === 'Pendiente' ? `
                <div class="item-acciones">
                    <button class="btn btn-success" onclick="aceptarReserva(${Number(r.id)})">Aceptar</button>
                    <button class="btn btn-danger" onclick="rechazarReserva(${Number(r.id)}, this)">Rechazar</button>
                </div>
            ` : `<p class="estado-texto" style="color: ${color};">Estado: ${esc(r.estado_reserva)}</p>`;

            const div = document.createElement('div');
            div.className = 'item-caja';
            div.innerHTML = `
                <p><strong>Solicitante:</strong> ${esc(r.solicitante)} (${esc(r.tipo_solicitante)})</p>
                <p><strong>CI:</strong> ${esc(r.ci)} | <strong>Tel:</strong> ${esc(r.telefono)}</p>
                <p><strong>Instrumento:</strong> ${esc(r.instrumento_nombre)} (Serie: ${esc(r.numero_serie)})</p>
                <p><strong>Clase/Evento:</strong> ${esc(r.clase_evento)}</p>
                <p><strong>Salida:</strong> ${verFecha(r.fecha_prestamo)} | <strong>Límite:</strong> ${verFecha(r.fecha_devolucion_limite)}</p>
                <p><strong>Adelanto:</strong> ${moneda(r.monto_adelanto)} — ${r.metodo_pago === 'qr' ? 'Pago por QR' : 'Tarjeta •••• ' + esc(r.tarjeta_ultimos4 || '----')}</p>
                ${acciones}
            `;
            contenedor.appendChild(div);
        });

        abrirModal('modal-bandeja-admin');
    } catch (err) { toast(err.message, 'error'); }
}

async function aceptarReserva(id) {
    try {
        await api(`/api/reservas/${id}/aceptar`, { method: 'POST' });
        actualizarContadorBandejaAdmin();
        abrirBandejaAdmin();
    } catch (err) { toast(err.message, 'error'); }
}

async function rechazarReserva(id, boton) {
    if (!confirmarClic(boton)) return;
    try {
        await api(`/api/reservas/${id}/rechazar`, { method: 'POST' });
        actualizarContadorBandejaAdmin();
        abrirBandejaAdmin();
    } catch (err) { toast(err.message, 'error'); }
}

async function abrirBandejaCliente() {
    try {
        const notificaciones = await api('/api/mis-reservas');
        const contenedor = $('lista-notificaciones-cliente');
        contenedor.innerHTML = '';

        if (notificaciones.length === 0) {
            contenedor.innerHTML = `<p class="vacio">No hay notificaciones.</p>`;
            abrirModal('modal-bandeja-cliente');
            return;
        }

        notificaciones.forEach((n) => {
            const color = n.estado_reserva === 'Aceptada' ? '#27ae60' : (n.estado_reserva === 'Rechazada' ? '#e74c3c' : '#f39c12');
            const div = document.createElement('div');
            div.className = 'item-caja';
            div.innerHTML = `
                <p class="estado-texto" style="color: ${color};">Estado: ${esc(n.estado_reserva)}</p>
                <p><strong>Instrumento:</strong> ${esc(n.instrumento_nombre)}</p>
                <p><strong>Salida:</strong> ${verFecha(n.fecha_prestamo)}</p>
                <p><strong>Límite:</strong> ${verFecha(n.fecha_devolucion_limite)}</p>
            `;
            contenedor.appendChild(div);
        });

        abrirModal('modal-bandeja-cliente');
    } catch (err) { toast(err.message, 'error'); }
}

// =====================================================================
//  CATÁLOGO Y RESERVA VIRTUAL
// =====================================================================
async function cargarCatalogo() {
    const grid = $('grid-instrumentos');
    if (!grid) return;
    try {
        const [instrumentos, disp] = await Promise.all([api('/api/instrumentos'), api('/api/disponibilidad')]);
        listaInstrumentosCache = instrumentos;
        const ocupados = new Set(disp.ocupados);
        grid.innerHTML = '';

        if (instrumentos.length === 0) {
            grid.innerHTML = `<p class="catalogo-vacio">Todavía no hay instrumentos registrados.</p>`;
            return;
        }

        instrumentos.forEach((item) => {
            const enReparacion = item.estado_fisico === 'En reparación';
            const ocupado = ocupados.has(item.id);

            const imagenHTML = item.imagen
                ? `<img src="${esc(item.imagen)}" class="instrument-img" alt="${esc(item.nombre)}">`
                : `<div class="instrument-img sin-foto" aria-hidden="true"><span>${emojiPorTipo(item.tipo)}</span></div>`;

            let badge, boton;
            if (enReparacion) {
                badge = `<span class="badge badge-fix">🛠️ En reparación</span>`;
                boton = `<button class="btn" disabled>No disponible</button>`;
            } else if (ocupado) {
                badge = `<span class="badge badge-busy">🔴 Ocupado / En Uso</span>`;
                boton = `<button class="btn" disabled>En Uso</button>`;
            } else {
                badge = `<span class="badge badge-ok">🟢 Disponible</span>`;
                boton = `<button class="btn btn-primary" onclick="solicitarReserva(${Number(item.id)})">Reservar</button>`;
            }

            const card = document.createElement('div');
            card.className = 'instrument-card';
            card.innerHTML = `
                ${imagenHTML}
                <div class="instrument-info">
                    <div>
                        <h3>${esc(item.nombre)}</h3>
                        <p><strong>Tipo:</strong> ${esc(item.tipo)}</p>
                        <p><strong>Serie:</strong> ${esc(item.numero_serie)}</p>
                        <p><strong>Estado físico:</strong> ${esc(item.estado_fisico)}</p>
                        <p><strong>Disponibilidad:</strong> ${badge}</p>
                    </div>
                    ${boton}
                </div>
            `;
            grid.appendChild(card);
        });
    } catch (err) {
        grid.innerHTML = `<p class="catalogo-vacio">No se pudo cargar el catálogo: ${esc(err.message)}</p>`;
    }
}

function solicitarReserva(id) {
    const sesion = getSesion();
    if (!sesion || !sesion.usuario) {
        toast('Debes iniciar sesión para realizar una reserva virtual.', 'error');
        return;
    }
    const item = listaInstrumentosCache.find((i) => i.id === id);
    if (!item) return;
    const user = sesion.usuario;

    $('res-instrumento-id').value = item.id;
    $('res-nombre').value = user.nombre;
    $('res-ci').value = user.ci || '';
    $('res-telefono').value = user.telefono || '';
    $('res-clase').value = '';
    $('res-fecha-salida').min = ahoraLocalInput();
    $('res-fecha-limite').min = ahoraLocalInput();
    $('res-fecha-salida').value = ahoraLocalInput();
    $('res-fecha-limite').value = '';
    $('monto-adelanto').textContent = moneda(config.adelantoReserva);
    $('detalle-instrumento-modal').innerHTML = `<strong>Instrumento:</strong> ${esc(item.nombre)} (Serie: ${esc(item.numero_serie)})`;
    limpiarDatosTarjeta();
    cambiarMetodoPago();
    abrirModal('modal-reserva');
}

// [pago-utils-inicio]
function luhnValido(numero) {
    let suma = 0;
    let alterno = false;
    for (let i = numero.length - 1; i >= 0; i--) {
        let n = parseInt(numero[i], 10);
        if (alterno) { n *= 2; if (n > 9) n -= 9; }
        suma += n;
        alterno = !alterno;
    }
    return suma % 10 === 0;
}

function detectarMarca(d) {
    if (/^4/.test(d)) return 'Visa';
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return 'Mastercard';
    if (/^3[47]/.test(d)) return 'American Express';
    return '';
}

// 4-4-4-4 para la mayoría de tarjetas y 4-6-5 para American Express
function formatearNumeroTarjeta(valor) {
    const d = String(valor).replace(/\D/g, '');
    if (/^3[47]/.test(d)) {
        const x = d.slice(0, 15);
        return [x.slice(0, 4), x.slice(4, 10), x.slice(10, 15)].filter(Boolean).join(' ');
    }
    return d.slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
}
// [pago-utils-fin]

const campoNumero = $('tarj-numero');
if (campoNumero) {
    campoNumero.addEventListener('input', () => {
        campoNumero.value = formatearNumeroTarjeta(campoNumero.value);
        const digitos = campoNumero.value.replace(/\D/g, '');
        $('tarj-marca').textContent = detectarMarca(digitos);
        $('tarj-cvv').maxLength = /^3[47]/.test(digitos) ? 4 : 3;
    });
}

const campoVence = $('tarj-vence');
if (campoVence) {
    campoVence.addEventListener('input', () => {
        let d = campoVence.value.replace(/\D/g, '').slice(0, 4);
        if (d.length >= 3) d = `${d.slice(0, 2)}/${d.slice(2)}`;
        campoVence.value = d;
    });
}

const campoCvv = $('tarj-cvv');
if (campoCvv) {
    campoCvv.addEventListener('input', () => {
        campoCvv.value = campoCvv.value.replace(/\D/g, '');
    });
}

function limpiarDatosTarjeta() {
    ['tarj-nombre', 'tarj-numero', 'tarj-vence', 'tarj-cvv'].forEach((id) => { $(id).value = ''; });
    $('tarj-marca').textContent = '';
    $('tarj-cvv').maxLength = 3;
}

// Devuelve el texto del error, o null si la tarjeta es válida
function validarTarjeta() {
    const nombre = $('tarj-nombre').value.trim();
    const numero = $('tarj-numero').value.replace(/\D/g, '');
    const vence = $('tarj-vence').value;
    const cvv = $('tarj-cvv').value;
    const amex = /^3[47]/.test(numero);

    if (nombre.length < 3) return 'Escribe el nombre del titular de la tarjeta.';
    if (numero.length !== (amex ? 15 : 16) || !luhnValido(numero)) return 'El número de tarjeta no es válido.';

    const m = /^(\d{2})\/(\d{2})$/.exec(vence);
    if (!m) return 'Escribe el vencimiento con el formato MM/AA.';
    const mes = Number(m[1]);
    const anio = 2000 + Number(m[2]);
    if (mes < 1 || mes > 12) return 'El mes de vencimiento no es válido.';
    if (new Date(anio, mes, 1) <= new Date()) return 'La tarjeta está vencida.';

    if (cvv.length !== (amex ? 4 : 3)) return `El CVV debe tener ${amex ? 4 : 3} dígitos.`;
    return null;
}

function cambiarMetodoPago() {
    const esQr = $('res-metodo-pago').value === 'qr';
    $('pago-tarjeta').hidden = esQr;
    $('pago-qr').hidden = !esQr;
    if (esQr) cargarQrPago();
}

// Muestra el QR que subió el administrador (o el archivo qr.png del proyecto)
function cargarQrPago() {
    const img = $('qr-pago-img');
    const aviso = $('qr-pago-aviso');
    const enlace = $('qr-descargar');
    img.hidden = true;
    enlace.hidden = true;
    qrDisponible = false;
    aviso.textContent = 'Cargando código QR…';

    img.onload = () => {
        img.hidden = false;
        enlace.hidden = false;
        qrDisponible = true;
        aviso.textContent = 'Después de pagar, confirma tu reserva. El administrador verificará el pago.';
    };
    img.onerror = () => {
        aviso.textContent = 'El administrador todavía no configuró el código QR de pago.';
    };
    img.src = `/api/qr/imagen?t=${Date.now()}`;
}

async function enviarReservaVirtual(e) {
    e.preventDefault();
    const salida = $('res-fecha-salida').value;
    const limite = $('res-fecha-limite').value;
    if (new Date(limite) <= new Date(salida)) {
        toast('La fecha límite debe ser posterior a la fecha de salida.', 'error');
        return;
    }

    const metodo = $('res-metodo-pago').value;
    let ultimos4 = null;
    if (metodo === 'tarjeta') {
        const errorTarjeta = validarTarjeta();
        if (errorTarjeta) { toast(errorTarjeta, 'error'); return; }
        // Solo viajan los últimos 4 dígitos: el número completo y el CVV nunca salen del navegador
        ultimos4 = $('tarj-numero').value.replace(/\D/g, '').slice(-4);
    } else if (!qrDisponible) {
        toast('El administrador todavía no configuró el QR de pago. Elige tarjeta o inténtalo más tarde.', 'error');
        return;
    }

    try {
        await api('/api/reservas', {
            method: 'POST',
            body: {
                instrumento_id: Number($('res-instrumento-id').value),
                tipo_solicitante: $('res-tipo-solicitante').value,
                clase_evento: $('res-clase').value,
                fecha_prestamo: salida,
                fecha_devolucion_limite: limite,
                ci: $('res-ci').value,
                telefono: $('res-telefono').value,
                metodo_pago: metodo,
                tarjeta_ultimos4: ultimos4
            }
        });
        cerrarModal('modal-reserva');
        $('form-reserva-virtual').reset();
        limpiarDatosTarjeta();
        cambiarMetodoPago();
        cargarCatalogo();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// =====================================================================
//  ADMIN: INVENTARIO (REGISTRO CON FOTO + TABLA)
// =====================================================================

// Reduce la foto (máx. 800 px) para que la base de datos no se llene
function leerImagenRedimensionada(archivo, maximo = 800) {
    return new Promise((resolve, reject) => {
        const lector = new FileReader();
        lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        lector.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
            img.onload = () => {
                const factor = Math.min(1, maximo / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * factor);
                canvas.height = Math.round(img.height * factor);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.75));
            };
            img.src = lector.result;
        };
        lector.readAsDataURL(archivo);
    });
}

const inputFoto = $('foto-instrumento');
if (inputFoto) {
    inputFoto.addEventListener('change', async () => {
        const vista = $('vista-previa-foto');
        if (!inputFoto.files[0]) { vista.style.display = 'none'; return; }
        try {
            vista.src = await leerImagenRedimensionada(inputFoto.files[0]);
            vista.style.display = 'block';
        } catch (err) {
            toast(err.message, 'error');
            inputFoto.value = '';
            vista.style.display = 'none';
        }
    });
}

const formInstrumento = $('form-instrumento');
if (formInstrumento) {
    formInstrumento.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            let imagen = '';
            if (inputFoto.files[0]) imagen = await leerImagenRedimensionada(inputFoto.files[0]);

            await api('/api/instrumentos', {
                method: 'POST',
                body: {
                    nombre: $('nombre-instrumento').value,
                    tipo: $('tipo-instrumento').value,
                    numero_serie: $('num-serie').value,
                    estado_fisico: $('estado-fisico').value,
                    imagen
                }
            });
            formInstrumento.reset();
            $('vista-previa-foto').style.display = 'none';
            cambiarPanel(1);
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

async function cargarInstrumentos() {
    try {
        const [instrumentos, disp] = await Promise.all([api('/api/instrumentos'), api('/api/disponibilidad')]);
        listaInstrumentosCache = instrumentos;
        renderizarTablaInstrumentos(instrumentos, new Set(disp.ocupados));
    } catch (err) { toast(err.message, 'error'); }
}

function renderizarTablaInstrumentos(instrumentos, ocupados) {
    const tbody = $('tabla-instrumentos');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (instrumentos.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#777;">Aún no hay instrumentos registrados.</td></tr>`;
        return;
    }

    instrumentos.forEach((item) => {
        const opciones = ESTADOS_FISICOS.map((e) => `<option value="${esc(e)}" ${e === item.estado_fisico ? 'selected' : ''}>${esc(e)}</option>`).join('');
        const foto = item.imagen ? `<img class="mini-foto" src="${esc(item.imagen)}" alt="">` : `<div class="mini-foto"></div>`;
        const disponibilidad = item.estado_fisico === 'En reparación'
            ? `<span class="badge badge-fix">En reparación</span>`
            : (ocupados.has(item.id) ? `<span class="badge badge-busy">En uso</span>` : `<span class="badge badge-ok">Disponible</span>`);

        const fila = document.createElement('tr');
        fila.innerHTML = `
            <td data-label="Eliminar"><button class="btn btn-danger btn-sm" onclick="eliminarInstrumento(${Number(item.id)}, this)">🗑️</button></td>
            <td data-label="ID">${Number(item.id)}</td>
            <td data-label="Foto">${foto}</td>
            <td data-label="Instrumento">${esc(item.nombre)}</td>
            <td data-label="Tipo">${esc(item.tipo)}</td>
            <td data-label="N° de serie">${esc(item.numero_serie)}</td>
            <td data-label="Estado físico"><select class="fila-estado" onchange="cambiarEstadoInstrumento(${Number(item.id)}, this.value)">${opciones}</select></td>
            <td data-label="Disponibilidad">${disponibilidad}</td>
        `;
        tbody.appendChild(fila);
    });
}

async function cambiarEstadoInstrumento(id, estado) {
    try {
        await api(`/api/instrumentos/${id}`, { method: 'PUT', body: { estado_fisico: estado } });
    } catch (err) {
        toast(err.message, 'error');
    }
    cargarInstrumentos();
}

async function eliminarInstrumento(id, boton) {
    if (!confirmarClic(boton)) return;
    try {
        await api(`/api/instrumentos/${id}`, { method: 'DELETE' });
    } catch (err) {
        toast(err.message, 'error');
    }
    cargarInstrumentos();
}

// =====================================================================
//  ADMIN: PRÉSTAMOS (CON FIRMA DIGITAL)
// =====================================================================
const canvasFirma = $('canvas-firma');
let firmando = false;
let firmaVacia = true;

if (canvasFirma) {
    const ctx = canvasFirma.getContext('2d');
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';

    const posicion = (e) => {
        const r = canvasFirma.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (canvasFirma.width / r.width),
            y: (e.clientY - r.top) * (canvasFirma.height / r.height)
        };
    };

    canvasFirma.addEventListener('pointerdown', (e) => {
        firmando = true;
        firmaVacia = false;
        canvasFirma.setPointerCapture(e.pointerId);
        const p = posicion(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 0.1, p.y + 0.1);
        ctx.stroke();
    });
    canvasFirma.addEventListener('pointermove', (e) => {
        if (!firmando) return;
        const p = posicion(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
    });
    const terminarTrazo = () => { firmando = false; };
    canvasFirma.addEventListener('pointerup', terminarTrazo);
    canvasFirma.addEventListener('pointercancel', terminarTrazo);
}

function limpiarFirma() {
    if (!canvasFirma) return;
    canvasFirma.getContext('2d').clearRect(0, 0, canvasFirma.width, canvasFirma.height);
    firmaVacia = true;
}
const btnLimpiarFirma = $('btn-limpiar-firma');
if (btnLimpiarFirma) btnLimpiarFirma.addEventListener('click', limpiarFirma);

async function cargarSelectInstrumentosParaPrestamo() {
    const select = $('select-instrumento-prestamo');
    if (!select) return;
    try {
        const [instrumentos, disp] = await Promise.all([api('/api/instrumentos'), api('/api/disponibilidad')]);
        const ocupados = new Set(disp.ocupados);
        listaInstrumentosCache = instrumentos;

        select.innerHTML = `<option value="">Seleccione un instrumento disponible</option>`;
        instrumentos
            .filter((i) => i.estado_fisico !== 'En reparación' && !ocupados.has(i.id))
            .forEach((item) => {
                const option = document.createElement('option');
                option.value = item.id;
                option.textContent = `${item.nombre} (Serie: ${item.numero_serie}) - ${item.estado_fisico}`;
                select.appendChild(option);
            });

        if (!$('fecha-prestamo').value) $('fecha-prestamo').value = ahoraLocalInput();
        $('info-estado-salida').textContent = '';
    } catch (err) { toast(err.message, 'error'); }
}

const selectPrestamo = $('select-instrumento-prestamo');
if (selectPrestamo) {
    selectPrestamo.addEventListener('change', () => {
        const item = listaInstrumentosCache.find((i) => String(i.id) === selectPrestamo.value);
        $('info-estado-salida').textContent = item ? `Estado al salir (queda registrado en el acta): ${item.estado_fisico}` : '';
    });
}

const formPrestamo = $('form-prestamo');
if (formPrestamo) {
    formPrestamo.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (firmaVacia) {
            toast('El solicitante debe firmar en el recuadro antes de registrar el préstamo.', 'error');
            return;
        }
        const salida = $('fecha-prestamo').value;
        const limite = $('fecha-limite').value;
        if (new Date(limite) <= new Date(salida)) {
            toast('La fecha límite debe ser posterior a la fecha de salida.', 'error');
            return;
        }

        try {
            await api('/api/prestamos', {
                method: 'POST',
                body: {
                    instrumento_id: Number($('select-instrumento-prestamo').value),
                    solicitante: $('solicitante-prestamo').value,
                    ci_solicitante: $('ci-solicitante').value,
                    telefono: $('telefono-solicitante').value,
                    clase_evento: $('clase-evento').value,
                    fecha_prestamo: salida,
                    fecha_devolucion_limite: limite,
                    firma_digital: canvasFirma.toDataURL('image/png')
                }
            });
            formPrestamo.reset();
            limpiarFirma();
            cambiarPanel(3);
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

// =====================================================================
//  ADMIN: DEVOLUCIONES, CRONÓMETRO Y ACTA
// =====================================================================
function formatearDuracion(ms) {
    const total = Math.floor(Math.abs(ms) / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${d > 0 ? d + 'd ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}

function actualizarCronometros() {
    const ahora = Date.now();
    document.querySelectorAll('.cronometro[data-limite]').forEach((td) => {
        const salida = new Date(td.dataset.salida).getTime();
        const limite = new Date(td.dataset.limite).getTime();
        if (isNaN(limite)) { td.textContent = '—'; return; }

        if (!isNaN(salida) && salida > ahora) {
            td.className = 'cronometro pendiente';
            td.textContent = `📅 Inicia en ${formatearDuracion(salida - ahora)}`;
        } else if (limite >= ahora) {
            td.className = 'cronometro ok';
            td.textContent = `⏳ Restan ${formatearDuracion(limite - ahora)}`;
        } else {
            td.className = 'cronometro retraso';
            td.textContent = `⚠️ Retraso ${formatearDuracion(ahora - limite)}`;
        }
    });
}

async function cargarPrestamosYDevoluciones() {
    const tbody = $('tabla-devoluciones');
    if (!tbody) return;
    try {
        prestamosCache = await api('/api/prestamos');
    } catch (err) { toast(err.message, 'error'); return; }

    tbody.innerHTML = '';
    if (prestamosCache.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#777;">Aún no hay préstamos registrados.</td></tr>`;
        return;
    }

    prestamosCache.forEach((p) => {
        const activo = p.estado === 'Activo';
        const celdaCronometro = activo
            ? `<td class="cronometro" data-label="Cronómetro" data-salida="${esc(p.fecha_prestamo)}" data-limite="${esc(p.fecha_devolucion_limite)}">…</td>`
            : `<td data-label="Cronómetro">Devuelto el<br>${verFecha(p.fecha_devolucion_real)}</td>`;

        const detalleMulta = (!activo && (p.multa_retraso || p.multa_dano))
            ? `<br><small>Retraso: ${moneda(p.multa_retraso)}<br>Daño (${esc(p.nivel_dano)}): ${moneda(p.multa_dano)}</small>`
            : '';

        const acciones = `
            ${activo ? `<button class="btn btn-success btn-sm" onclick="abrirDevolucion(${Number(p.id)})">Devolver</button>` : '<span>Completado</span>'}
            <button class="btn btn-dark btn-sm" onclick="verActa(${Number(p.id)})">Acta</button>
        `;

        const fila = document.createElement('tr');
        fila.innerHTML = `
            <td data-label="ID">${Number(p.id)}</td>
            <td data-label="Instrumento">${esc(p.nombre || '(instrumento eliminado)')}${p.es_virtual ? '<br><small>🌐 Reserva virtual</small>' : ''}</td>
            <td data-label="Solicitante">${esc(p.solicitante)}</td>
            <td data-label="Salida / Límite">Salida: ${verFecha(p.fecha_prestamo)}<br>Límite: ${verFecha(p.fecha_devolucion_limite)}</td>
            ${celdaCronometro}
            <td data-label="Multa"><strong>${moneda(p.multa)}</strong>${detalleMulta}</td>
            <td data-label="Acción">${acciones}</td>
        `;
        tbody.appendChild(fila);
    });

    actualizarCronometros();
    intervaloCronometro = setInterval(actualizarCronometros, 1000);
}

async function abrirDevolucion(id) {
    const p = prestamosCache.find((x) => x.id === id);
    if (!p) return;
    if (!Object.keys(config.multasDano || {}).length) await cargarConfig();

    $('dev-id').value = id;
    $('dev-resumen').innerHTML = `
        <p><strong>Instrumento:</strong> ${esc(p.nombre)} (Serie: ${esc(p.numero_serie)})</p>
        <p><strong>Solicitante:</strong> ${esc(p.solicitante)}</p>
        <p><strong>Estado al salir:</strong> ${esc(p.estado_salida || 'No registrado')}</p>
        <p><strong>Límite:</strong> ${verFecha(p.fecha_devolucion_limite)}</p>
    `;
    $('dev-estado').value = p.estado_salida && ESTADOS_FISICOS.includes(p.estado_salida) ? p.estado_salida : 'Óptimo';
    $('dev-dano').innerHTML = Object.entries(config.multasDano)
        .map(([nivel, monto]) => `<option value="${esc(nivel)}">${esc(nivel)} (${moneda(monto)})</option>`)
        .join('');
    $('dev-obs').value = '';
    $('dev-tarifas').textContent =
        `Retraso: ${moneda(config.tarifaRetrasoPorDia)} por día, tolerancia de ${config.horasGracia} h, tope ${moneda(config.topeMultaRetraso)}.`;
    abrirModal('modal-devolucion');
    actualizarPrevisualizacion();
}

async function actualizarPrevisualizacion() {
    const id = $('dev-id').value;
    if (!id) return;
    try {
        const c = await api(`/api/prestamos/${id}/previsualizar-multa`, {
            method: 'POST',
            body: { fecha_devolucion_real: ahoraLocalInput(), nivel_dano: $('dev-dano').value }
        });
        $('dev-preview').innerHTML = `
            <p><strong>Retraso:</strong> ${c.diasRetraso > 0 ? c.diasRetraso + ' día(s)' : 'sin retraso'} (${c.horasRetraso} h pasadas del límite)</p>
            <p>Multa por retraso: ${moneda(c.multaRetraso)}</p>
            <p>Multa por daño: ${moneda(c.multaDano)}</p>
            <p class="total">Total a cobrar: ${moneda(c.total)}</p>
        `;
    } catch (err) {
        $('dev-preview').textContent = err.message;
    }
}

async function confirmarDevolucion(e) {
    e.preventDefault();
    const id = $('dev-id').value;
    try {
        const r = await api(`/api/prestamos/${id}/devolver`, {
            method: 'PUT',
            body: {
                fecha_devolucion_real: ahoraLocalInput(),
                estado_fisico_retorno: $('dev-estado').value,
                nivel_dano: $('dev-dano').value,
                observaciones: $('dev-obs').value
            }
        });
        cerrarModal('modal-devolucion');
        cargarPrestamosYDevoluciones();
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function verActa(id) {
    try {
        const p = await api(`/api/prestamos/${id}`);
        const tieneFirma = typeof p.firma_digital === 'string' && p.firma_digital.startsWith('data:image/');
        $('acta-contenido').innerHTML = `
            <div class="item-caja">
                <p><strong>Préstamo N°:</strong> ${Number(p.id)} ${p.es_virtual ? '(reserva virtual)' : ''}</p>
                <p><strong>Instrumento:</strong> ${esc(p.nombre)} (Serie: ${esc(p.numero_serie)})</p>
                <p><strong>Solicitante:</strong> ${esc(p.solicitante)}</p>
                <p><strong>CI:</strong> ${esc(p.ci_solicitante || '—')} | <strong>Tel:</strong> ${esc(p.telefono || '—')}</p>
                <p><strong>Clase/Evento:</strong> ${esc(p.clase_evento)}</p>
                <p><strong>Salida:</strong> ${verFecha(p.fecha_prestamo)}</p>
                <p><strong>Límite:</strong> ${verFecha(p.fecha_devolucion_limite)}</p>
                <p><strong>Estado al salir:</strong> ${esc(p.estado_salida || '—')}</p>
                <p><strong>Estado:</strong> ${esc(p.estado)}</p>
                ${p.estado === 'Devuelto' ? `
                    <p><strong>Devuelto el:</strong> ${verFecha(p.fecha_devolucion_real)}</p>
                    <p><strong>Estado al regresar:</strong> ${esc(p.estado_retorno || '—')}</p>
                    <p><strong>Daño:</strong> ${esc(p.nivel_dano || 'Ninguno')}</p>
                    <p><strong>Observaciones:</strong> ${esc(p.observaciones || '—')}</p>
                    <p><strong>Multa total:</strong> ${moneda(p.multa)}</p>
                ` : ''}
                <p><strong>Firma / conformidad:</strong></p>
                ${tieneFirma
                    ? `<img class="acta-firma" src="${esc(p.firma_digital)}" alt="Firma del solicitante">`
                    : `<p>${esc(p.firma_digital || 'Sin firma')}</p>`}
            </div>
        `;
        abrirModal('modal-acta');
    } catch (err) { toast(err.message, 'error'); }
}

// =====================================================================
//  ADMIN: QR DE PAGOS
// =====================================================================
let qrNuevo = null; // foto elegida, todavía sin guardar

function prepararImagenQr(archivo, maximo = 1000) {
    return new Promise((resolve, reject) => {
        if (!archivo.type.startsWith('image/')) return reject(new Error('El archivo no es una imagen.'));
        const lector = new FileReader();
        lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        lector.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
            img.onload = () => {
                // Si ya es chica, se conserva tal cual para no dañar el QR
                if (Math.max(img.width, img.height) <= maximo && archivo.size <= 3 * 1024 * 1024) {
                    return resolve(lector.result);
                }
                const factor = Math.min(1, maximo / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * factor);
                canvas.height = Math.round(img.height * factor);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = lector.result;
        };
        lector.readAsDataURL(archivo);
    });
}

async function refrescarQrAdmin() {
    try {
        const info = await api('/api/qr');
        const img = $('qr-admin-preview');
        if (info.existe) {
            img.src = `/api/qr/imagen?t=${Date.now()}`;
            img.hidden = false;
            $('qr-admin-aviso').textContent = info.subido
                ? 'QR subido desde este panel (es el que ven los usuarios).'
                : 'Usando el archivo qr.png del proyecto. Sube una foto para reemplazarlo.';
        } else {
            img.hidden = true;
            $('qr-admin-aviso').textContent = 'Todavía no hay un QR configurado. Sube una foto de tu código QR.';
        }
        $('btn-mostrar-qr').disabled = !info.existe;
        $('btn-eliminar-qr').hidden = !info.subido;
    } catch (err) { toast(err.message, 'error'); }
}

async function abrirModalQrAdmin() {
    qrNuevo = null;
    $('qr-archivo').value = '';
    $('btn-guardar-qr').disabled = true;
    await refrescarQrAdmin();
    abrirModal('modal-qr-admin');
}

const inputQr = $('qr-archivo');
if (inputQr) {
    inputQr.addEventListener('change', async () => {
        const archivo = inputQr.files[0];
        if (!archivo) { qrNuevo = null; $('btn-guardar-qr').disabled = true; return; }
        try {
            qrNuevo = await prepararImagenQr(archivo);
            $('qr-admin-preview').src = qrNuevo;
            $('qr-admin-preview').hidden = false;
            $('qr-admin-aviso').textContent = 'Vista previa. Pulsa "Guardar QR" para usarlo en los pagos.';
            $('btn-guardar-qr').disabled = false;
        } catch (err) {
            qrNuevo = null;
            inputQr.value = '';
            $('btn-guardar-qr').disabled = true;
            toast(err.message, 'error');
        }
    });
}

async function guardarQrAdmin() {
    if (!qrNuevo) return;
    try {
        await api('/api/qr', { method: 'PUT', body: { imagen: qrNuevo } });
        qrNuevo = null;
        $('qr-archivo').value = '';
        $('btn-guardar-qr').disabled = true;
        refrescarQrAdmin();
    } catch (err) { toast(err.message, 'error'); }
}

async function eliminarQrAdmin(boton) {
    if (!confirmarClic(boton)) return;
    try {
        await api('/api/qr', { method: 'DELETE' });
        refrescarQrAdmin();
    } catch (err) { toast(err.message, 'error'); }
}

// Pantalla grande para que el cliente escanee en persona
function mostrarQrEnPantalla() {
    $('qr-pantalla-img').src = `/api/qr/imagen?t=${Date.now()}`;
    abrirModal('modal-qr-pantalla');
}

// =====================================================================
//  OJITO PARA VER/OCULTAR CONTRASEÑAS
// =====================================================================
const ICONO_OJO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICONO_OJO_TACHADO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function establecerVisibilidad(input, boton, visible) {
    input.type = visible ? 'text' : 'password';
    boton.innerHTML = visible ? ICONO_OJO_TACHADO : ICONO_OJO;
    boton.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
    boton.setAttribute('aria-pressed', String(visible));
}

function agregarBotonesOjo() {
    document.querySelectorAll('input[type="password"]').forEach((input) => {
        if (input.dataset.ojo) return;
        input.dataset.ojo = '1';

        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'ojo-btn';
        establecerVisibilidad(input, boton, false);
        boton.addEventListener('mousedown', (e) => e.preventDefault()); // el cursor no sale del campo
        boton.addEventListener('click', () => establecerVisibilidad(input, boton, input.type === 'password'));
        input._ocultar = () => establecerVisibilidad(input, boton, false);

        const padre = input.parentElement;
        if (padre.classList.contains('input-wrap')) {
            padre.classList.add('con-ojo');
            padre.appendChild(boton);
        } else {
            const envoltorio = document.createElement('div');
            envoltorio.className = 'pass-wrap';
            padre.insertBefore(envoltorio, input);
            envoltorio.appendChild(input);
            envoltorio.appendChild(boton);
        }
    });
}

function ocultarPasswords(contenedor) {
    contenedor.querySelectorAll('input[data-ojo]').forEach((input) => { if (input._ocultar) input._ocultar(); });
}

// =====================================================================
//  CAMBIAR MI CONTRASEÑA (ADMIN Y USUARIOS)
// =====================================================================
function abrirModalPassword() {
    $('form-password').reset();
    $('pw-mensaje').textContent = '';
    $('pw-mensaje').className = 'pw-mensaje';
    abrirModal('modal-password');
}

async function cambiarPassword(e) {
    e.preventDefault();
    const mensaje = $('pw-mensaje');
    mensaje.className = 'pw-mensaje';

    const nueva = $('pw-nueva').value;
    if (nueva !== $('pw-repetir').value) {
        mensaje.textContent = 'Las contraseñas nuevas no coinciden.';
        mensaje.classList.add('error');
        return;
    }
    try {
        await api('/api/cambiar-password', { method: 'POST', body: { actual: $('pw-actual').value, nueva } });
        mensaje.textContent = '✔ Contraseña actualizada.';
        mensaje.classList.add('ok');
        $('form-password').reset();
        setTimeout(() => cerrarModal('modal-password'), 1200);
    } catch (err) {
        mensaje.textContent = err.message;
        mensaje.classList.add('error');
    }
}

// =====================================================================
//  DECORACIÓN: NOTAS FLOTANTES E ICONOS POR TIPO
// =====================================================================
function emojiPorTipo(tipo) {
    const t = String(tipo || '').toLowerCase();
    if (/cuerda|guitar|viol|bajo|arpa|ukelele/.test(t)) return '🎸';
    if (/viento|flaut|trompet|saxo|clarin|oboe/.test(t)) return '🎷';
    if (/percu|bater|tambor|bongo/.test(t)) return '🥁';
    if (/tecl|piano|organ|sintet/.test(t)) return '🎹';
    if (/audio|micr|ampl|sonido|parlante/.test(t)) return '🎤';
    return '🎵';
}

function crearNotasDecorativas() {
    const capa = $('decoracion');
    if (!capa || capa.dataset.lista) return;
    capa.dataset.lista = '1';

    const simbolos = ['♪', '♫', '♬', '♩', '♭', '♯'];
    const colores = ['#ff6b6b', '#7c5cff', '#06b6d4', '#ffb142', '#2ecc71', '#ff7eb6'];
    for (let i = 0; i < 16; i++) {
        const nota = document.createElement('span');
        nota.className = 'nota-fondo';
        const giro = document.createElement('b');
        giro.textContent = simbolos[i % simbolos.length];
        nota.appendChild(giro);
        nota.style.setProperty('--x', `${random(2, 96)}%`);
        nota.style.setProperty('--s', `${random(1.8, 3.8)}rem`);
        nota.style.setProperty('--c', colores[i % colores.length]);
        nota.style.setProperty('--d', `${random(18, 32)}s`);
        nota.style.setProperty('--r', `-${random(0, 28)}s`);
        nota.style.setProperty('--g', `${random(5, 10)}s`);
        capa.appendChild(nota);
    }
}

// =====================================================================
//  INICIO: RESTAURAR SESIÓN
// =====================================================================
const avisoPendiente = sessionStorage.getItem('aviso');
if (avisoPendiente) {
    sessionStorage.removeItem('aviso');
    toast(avisoPendiente, 'error');
}

agregarBotonesOjo();
cargarConfig();

(function iniciarApp() {
    const sesion = getSesion();
    if (sesion && sesion.usuario && sesion.usuario.tipo === 'admin') {
        mostrarPaginaAdmin();
    } else if (sesion && sesion.usuario) {
        verificarSesionUI();
        volverAlCatalogo();
    } else {
        mostrarVista('login');
        setLamp(false);
    }
})();