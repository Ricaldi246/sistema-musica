let intervaloCronometro = null;
let listaInstrumentosCache = []; // Almacena temporalmente los instrumentos para filtrar rápido

function cambiarPanel(indicePanel) {
    const paneles = document.querySelectorAll('.panel');
    paneles.forEach((panel, index) => {
        if (index === indicePanel) {
            panel.classList.add('activo');
        } else {
            panel.classList.remove('activo');
        }
    });

    if (indicePanel === 1) {
        cargarInstrumentos();
    } else if (indicePanel === 2) {
        cargarSelectInstrumentosParaPrestamo();
    } else if (indicePanel === 3) {
        cargarPrestamosYDevoluciones();
    } else {
        if (intervaloCronometro) clearInterval(intervaloCronometro);
    }
}

// Verificar estado del servidor
fetch('/api/estado')
    .then(response => response.json())
    .then(data => {
        document.getElementById('estado-servidor').textContent = data.mensaje;
    })
    .catch(() => {
        document.getElementById('estado-servidor').textContent = "Error de conexión";
    });

// 1. Cargar inventario en el panel 2
async function cargarInstrumentos() {
    try {
        const respuesta = await fetch('/api/instrumentos');
        listaInstrumentosCache = await respuesta.json();
        renderizarTablaInstrumentos(listaInstrumentosCache);
    } catch (error) {
        console.error("No se pudo cargar el inventario", error);
    }
}

function renderizarTablaInstrumentos(instrumentos) {
    const tbody = document.getElementById('tabla-instrumentos');
    tbody.innerHTML = '';

    if (instrumentos.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #777;">No se encontraron instrumentos.</td></tr>`;
        return;
    }

    instrumentos.forEach(item => {
        const fila = document.createElement('tr');
        let claseEstado = 'optimo';
        if (item.estado_fisico === 'Desgaste regular') claseEstado = 'desgaste';
        if (item.estado_fisico === 'En reparación') claseEstado = 'reparacion';

        fila.innerHTML = `
            <td><button class="btn-eliminar" onclick="eliminarInstrumento(${item.id})" title="Eliminar instrumento">🗑️</button></td>
            <td>${item.id}</td>
            <td>${item.nombre}</td>
            <td>${item.tipo || 'N/D'}</td>
            <td>${item.numero_serie}</td>
            <td>
                <select class="select-estado ${claseEstado}" onchange="cambiarEstadoFisico(${item.id}, this)">
                    <option value="Óptimo" ${item.estado_fisico === 'Óptimo' ? 'selected' : ''}>Óptimo</option>
                    <option value="Desgaste regular" ${item.estado_fisico === 'Desgaste regular' ? 'selected' : ''}>Desgaste regular</option>
                    <option value="En reparación" ${item.estado_fisico === 'En reparación' ? 'selected' : ''}>En reparación</option>
                </select>
            </td>
        `;
        tbody.appendChild(fila);
    });
}

// Evento del buscador rápido en tiempo real
const inputBuscador = document.getElementById('buscador-inventario');
if (inputBuscador) {
    inputBuscador.addEventListener('input', (e) => {
        const textoBusqueda = e.target.value.toLowerCase();
        const filtrados = listaInstrumentosCache.filter(item => 
            item.nombre.toLowerCase().includes(textoBusqueda) || 
            item.numero_serie.toLowerCase().includes(textoBusqueda)
        );
        renderizarTablaInstrumentos(filtrados);
    });
}

async function cambiarEstadoFisico(id, selectElement) {
    const nuevoEstado = selectElement.value;
    selectElement.className = 'select-estado';
    if (nuevoEstado === 'Óptimo') selectElement.classList.add('optimo');
    if (nuevoEstado === 'Desgaste regular') selectElement.classList.add('desgaste');
    if (nuevoEstado === 'En reparación') selectElement.classList.add('reparacion');

    try {
        await fetch(`/api/instrumentos/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado_fisico: nuevoEstado })
        });
        // Actualizamos la caché local
        const itemEncontrado = listaInstrumentosCache.find(i => i.id === id);
        if (itemEncontrado) itemEncontrado.estado_fisico = nuevoEstado;
    } catch (error) {
        console.error("Error al actualizar el estado:", error);
    }
}

async function eliminarInstrumento(id) {
    try {
        const respuesta = await fetch(`/api/instrumentos/${id}`, { method: 'DELETE' });
        if (respuesta.ok) cargarInstrumentos();
    } catch (error) {
        console.error("Error al eliminar:", error);
    }
}

const formInstrumento = document.getElementById('form-instrumento');
if (formInstrumento) {
    formInstrumento.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = document.getElementById('nombre-instrumento').value;
        const tipo = document.getElementById('tipo-instrumento').value;
        const numero_serie = document.getElementById('num-serie').value;
        const estado_fisico = document.getElementById('estado-fisico').value;

        try {
            const respuesta = await fetch('/api/instrumentos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, tipo, numero_serie, estado_fisico })
            });
            if (respuesta.ok) {
                formInstrumento.reset();
                cambiarPanel(1);
            }
        } catch (error) {
            console.error("Error al enviar los datos:", error);
        }
    });
}

// 2. Lógica de Canvas para la Firma Digital
const canvas = document.getElementById('canvas-firma');
const ctx = canvas ? canvas.getContext('2d') : null;
let dibujando = false;

if (canvas && ctx) {
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;

    const obtenerPosicion = (e) => {
        const rect = canvas.getBoundingClientRect();
        const clienteX = e.clientX || (e.touches && e.touches[0].clientX);
        const clienteY = e.clientY || (e.touches && e.touches[0].clientY);
        return {
            x: clienteX - rect.left,
            y: clienteY - rect.top
        };
    };

    canvas.addEventListener('mousedown', (e) => {
        dibujando = true;
        const pos = obtenerPosicion(e);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!dibujando) return;
        const pos = obtenerPosicion(e);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
    });

    canvas.addEventListener('mouseup', () => dibujando = false);
    canvas.addEventListener('mouseleave', () => dibujando = false);

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        dibujando = true;
        const pos = obtenerPosicion(e.touches[0]);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (!dibujando) return;
        const pos = obtenerPosicion(e.touches[0]);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
    });

    canvas.addEventListener('touchend', () => dibujando = false);

    document.getElementById('btn-limpiar-firma').addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    });
}

// 3. Cargar selector de instrumentos para préstamos
async function cargarSelectInstrumentosParaPrestamo() {
    try {
        const respuesta = await fetch('/api/instrumentos');
        const instrumentos = await respuesta.json();
        const select = document.getElementById('select-instrumento-prestamo');
        select.innerHTML = `<option value="">Seleccione un instrumento disponible</option>`;

        instrumentos.forEach(item => {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = `${item.nombre} (Serie: ${item.numero_serie}) - Estado: ${item.estado_fisico}`;
            select.appendChild(option);
        });
    } catch (error) {
        console.error("Error al cargar instrumentos para préstamo", error);
    }
}

const formPrestamo = document.getElementById('form-prestamo');
if (formPrestamo) {
    formPrestamo.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const instrumento_id = document.getElementById('select-instrumento-prestamo').value;
        const solicitante = document.getElementById('solicitante-prestamo').value;
        const ci_solicitante = document.getElementById('ci-solicitante').value;
        const clase_evento = document.getElementById('clase-evento').value;
        const fecha_prestamo = document.getElementById('fecha-prestamo').value;
        const fecha_devolucion_limite = document.getElementById('fecha-limite').value;

        if (!instrumento_id) return;

        const firma_digital = canvas ? canvas.toDataURL() : '';

        const datosPrestamo = {
            instrumento_id: Number(instrumento_id),
            solicitante,
            ci_solicitante,
            clase_evento,
            fecha_prestamo,
            fecha_devolucion_limite,
            firma_digital
        };

        try {
            const respuesta = await fetch('/api/prestamos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(datosPrestamo)
            });

            if (respuesta.ok) {
                formPrestamo.reset();
                if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
                cambiarPanel(3);
                await cargarPrestamosYDevoluciones();
            }
        } catch (error) {
            console.error("Error al registrar préstamo:", error);
        }
    });
}

// 4. Cargar tabla de Devoluciones
async function cargarPrestamosYDevoluciones() {
    try {
        const respuesta = await fetch('/api/prestamos');
        const prestamos = await respuesta.json();
        const tbody = document.getElementById('tabla-devoluciones');
        tbody.innerHTML = '';

        if (prestamos.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #777;">No hay préstamos registrados todavía.</td></tr>`;
            return;
        }

        prestamos.forEach(p => {
            const fila = document.createElement('tr');
            
            let validacionHTML = '';
            if (p.firma_digital && p.firma_digital.length > 50) {
                validacionHTML = `<img src="${p.firma_digital}" alt="Firma" style="width: 90px; height: 35px; border: 1px solid #ccc; background: #fff; margin-top: 2px;">`;
            } else if (p.ci_solicitante) {
                validacionHTML = `<span style="background: #eef2f7; padding: 2px 5px; border-radius: 3px; font-size: 0.85rem; border: 1px solid #dcdcdc;">CI: <strong>${p.ci_solicitante}</strong></span>`;
            } else {
                validacionHTML = `<small style="color: #999;">Sin validar</small>`;
            }

            fila.innerHTML = `
                <td>${p.id}</td>
                <td>${p.nombre || 'Instrumento'} <br><small>(${p.numero_serie || 'N/D'})</small></td>
                <td>
                    <strong>${p.solicitante}</strong><br>
                    ${validacionHTML}
                </td>
                <td><small>Salida: ${p.fecha_prestamo ? p.fecha_prestamo.replace('T', ' ') : ''}</small><br><strong>Límite: ${p.fecha_devolucion_limite ? p.fecha_devolucion_limite.replace('T', ' ') : ''}</strong></td>
                <td id="cronometro-${p.id}">Calculando...</td>
                <td id="multa-ui-${p.id}">$${(p.multa || 0).toFixed(2)}</td>
                <td>
                    ${p.estado === 'Activo' ? `
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            <select id="estado-retorno-${p.id}" style="padding: 0.3rem; font-size: 0.85rem;">
                                <option value="Óptimo">Devolver en Óptimo</option>
                                <option value="Desgaste regular">Devolver con Desgaste</option>
                                <option value="En reparación">Devolver Dañado (En reparación)</option>
                            </select>
                            <button onclick="procesarDevolucion(${p.id})" style="background-color: #27ae60; color: white; border: none; padding: 0.4rem; border-radius: 4px; cursor: pointer; font-weight: bold;">Procesar Devolución</button>
                        </div>
                    ` : '<strong style="color: #27ae60;">Completado</strong>'}
                </td>
            `;
            tbody.appendChild(fila);
        });

        if (intervaloCronometro) clearInterval(intervaloCronometro);
        actualizarTiemposCronometro(prestamos);
        intervaloCronometro = setInterval(() => actualizarTiemposCronometro(prestamos), 1000);

    } catch (error) {
        console.error("Error al cargar préstamos:", error);
    }
}

function actualizarTiemposCronometro(prestamos) {
    const ahora = new Date().getTime();

    prestamos.forEach(p => {
        if (p.estado !== 'Activo') return;

        const limite = new Date(p.fecha_devolucion_limite).getTime();
        const diferencia = limite - ahora;
        const celdaCronometro = document.getElementById(`cronometro-${p.id}`);
        const celdaMulta = document.getElementById(`multa-ui-${p.id}`);
        if (!celdaCronometro) return;

        if (diferencia > 0) {
            const horas = Math.floor((diferencia % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutos = Math.floor((diferencia % (1000 * 60 * 60)) / (1000 * 60 * 60 / 60));
            const segundos = Math.floor((diferencia % (1000 * 60)) / 1000);

            celdaCronometro.innerHTML = `<span style="color: #27ae60; font-weight: bold;">⏳ Quedan: ${horas}h ${minutos}m ${segundos}s</span>`;
            celdaMulta.innerHTML = `<span style="color: #27ae60;">$0.00</span>`;
        } else {
            const retrasoMs = ahora - limite;
            const segundosRetraso = Math.floor(retrasoMs / 1000);
            const multaEstimada = segundosRetraso * 0.01;

            const rHoras = Math.floor(segundosRetraso / 3600);
            const rMinutos = Math.floor((segundosRetraso % 3600) / 60);
            const rSegs = segundosRetraso % 60;

            celdaCronometro.innerHTML = `<span style="color: #c0392b; font-weight: bold; background: #fadbd8; padding: 2px 6px; border-radius: 4px;">⚠️ VENCIDO: +${rHoras}h ${rMinutos}m ${rSegs}s</span>`;
            celdaMulta.innerHTML = `<span style="color: #c0392b; font-weight: bold;">$${multaEstimada.toFixed(2)}</span>`;
        }
    });
}

async function procesarDevolucion(id) {
    const selectorRetorno = document.getElementById(`estado-retorno-${id}`);
    const estado_fisico_retorno = selectorRetorno ? selectorRetorno.value : 'Óptimo';
    const fecha_devolucion_real = new Date().toISOString();

    try {
        const respuesta = await fetch(`/api/prestamos/${id}/devolver`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fecha_devolucion_real, estado_fisico_retorno })
        });

        if (respuesta.ok) {
            if (intervaloCronometro) clearInterval(intervaloCronometro);
            await cargarPrestamosYDevoluciones();
        }
    } catch (error) {
        console.error("Error en devolución:", error);
    }
}