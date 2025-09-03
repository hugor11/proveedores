// Probando múltiples configuraciones de API
const API_ENDPOINTS = [
    '/api', // Netlify Functions (producción y dev con netlify dev)
    'http://localhost:8888/api', // netlify dev proxy
    'http://proveedores.hugor1n8n.duckdns.org:8080/api',
    'https://proveedores.hugor1n8n.duckdns.org:8080/api',
    'http://proveedores.hugor1n8n.duckdns.org:3002/api',
    'https://proveedores.hugor1n8n.duckdns.org:3002/api'
];

let API_BASE = API_ENDPOINTS[0]; // Empezamos con el primero

// Variables globales
let proveedoresData = [];
let visitasData = [];
let asistenciasData = [];
let appInicializada = false;

// Fecha local YYYY-MM-DD (evita desfase por UTC)
function localISO(date = new Date()) {
    const tz = date.getTimezoneOffset();
    const local = new Date(date.getTime() - tz * 60000);
    return local.toISOString().split('T')[0];
}

// Helpers para normalizar/derivar el tipo de visita
function canonicalTipo(s) {
    const t = String(s || '').trim().toLowerCase();
    if (!t) return 'Visita Normal';
    if (t.includes('preventa')) return 'Preventa';
    if (t.includes('entrega')) return 'Entrega de Pedido';
    if (t.includes('visita')) return 'Visita Normal';
    return t.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
}
function tipoFor(visita, proveedor) {
    return canonicalTipo((visita && visita.tipoVisita) || (proveedor && proveedor.tipo_visita) || 'Visita Normal');
}
function labelForTipo(tipoCanonico) {
    const tl = String(tipoCanonico || '').toLowerCase();
    if (tl.includes('preventa')) return 'Pedir';
    if (tl.includes('entrega')) return 'Entregó';
    return 'Asistió';
}

// === FUNCIONES DE UI ===
function mostrarSpinner(mensaje) {
    const spinner = document.getElementById('spinner-carga');
    const mensajeElement = document.getElementById('mensaje-carga');
    if (!spinner || !mensajeElement) return;
    mensajeElement.textContent = mensaje || 'Cargando...';
    spinner.style.display = 'flex';
    const btn = document.getElementById('btnRefrescarDatos');
    if (btn) btn.disabled = true;
}

function ocultarSpinner() {
    const spinner = document.getElementById('spinner-carga');
    if (spinner) spinner.style.display = 'none';
    const btn = document.getElementById('btnRefrescarDatos');
    if (btn) btn.disabled = false;
}

function mostrarSeccion(seccionId) {
    const secciones = ['registroProveedores', 'asistenciaDiaria', 'gestionProveedores', 'reportes'];
    secciones.forEach(id => {
        const elemento = document.getElementById(id);
        if (elemento) {
            elemento.style.display = id === seccionId ? 'block' : 'none';
        }
    });
    // Actualizar botones activos
    document.querySelectorAll('#navegacion button').forEach(btn => {
        btn.style.backgroundColor = '#dc3545';
    });
    // Resaltar botón activo
    const botones = {
        'registroProveedores': 'btnRegistrar',
        'asistenciaDiaria': 'btnAsistencia',
        'gestionProveedores': 'btnVerGestionProveedores',
        'reportes': 'btnReportes'
    };
    if (botones[seccionId]) {
        const botonActivo = document.getElementById(botones[seccionId]);
        if (botonActivo) {
            botonActivo.style.backgroundColor = '#28a745';
        }
    }
}

// === VALIDACIONES DEL FORMULARIO ===
function validarFormulario() {
    const nombre = document.getElementById('nombre');
    const patron = (document.querySelector('input[name="patronVisita"]:checked')||{}).value;
    const diasChecks = Array.from(document.querySelectorAll('input[name="diasSemana"]:checked'));
    const nDias = Number(document.getElementById('cada-n-dias')?.value || 0);
    const fechaInicio = document.getElementById('fecha-inicio').value;

    let valido = true;

    if (!nombre.value.trim() || nombre.value.trim().length < 2) {
        mostrarError('error-nombre', 'El nombre debe tener al menos 2 caracteres');
        nombre.style.borderColor = 'red';
        valido = false;
    } else {
        ocultarError('error-nombre');
        nombre.style.borderColor = '';
    }

    if (!patron) {
        mostrarError('error-dias-visita', 'Elige la frecuencia: Diario, Semanal o Cada N días');
        valido = false;
    } else if (patron === 'weekly' && diasChecks.length === 0) {
        mostrarError('error-dias-visita', 'Selecciona al menos un día de la semana');
        valido = false;
    } else if (patron === 'everyNDays') {
        if (!nDias || nDias < 2) { mostrarError('error-dias-visita', 'N debe ser ≥ 2'); valido = false; }
        else if (!fechaInicio) { mostrarError('error-dias-visita', 'Selecciona la fecha de inicio'); valido = false; }
        else ocultarError('error-dias-visita');
    } else {
        ocultarError('error-dias-visita');
    }

    // Tipo de visita base es opcional (se usará "Visita Normal" si no se envía)
    ocultarError('error-tipo-visita');

    return valido;
}

function mostrarError(errorId, mensaje) {
    const errorElement = document.getElementById(errorId);
    if (errorElement) errorElement.textContent = mensaje;
}

function ocultarError(errorId) {
    const errorElement = document.getElementById(errorId);
    if (errorElement) errorElement.textContent = '';
}

// === VERIFICAR CONEXIÓN ===
// fetch con timeout compatible (sin AbortSignal.timeout)
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 7000, ...opts } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(resource, { ...opts, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(id);
    }
}

async function probarEndpoint(url) {
    try {
        console.log(`🔍 Probando: ${url}/health`);
        const res = await fetchWithTimeout(`${url}/health`, {
            timeout: 7000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            const data = await res.text();
            console.log(`✅ ÉXITO en ${url}:`, data);
            return { success: true, url, data };
        } else {
            console.log(`❌ Error ${res.status} en ${url}`);
            return { success: false, url, error: `HTTP ${res.status}` };
        }
    } catch (err) {
        console.log(`❌ Error en ${url}:`, err.message);
        return { success: false, url, error: err.message };
    }
}

async function encontrarEndpointFuncional() {
    console.log('🔍 Buscando endpoint funcional...');
    for (const endpoint of API_ENDPOINTS) {
        const resultado = await probarEndpoint(endpoint);
        if (resultado.success) {
            API_BASE = resultado.url;
            console.log(`🎯 Endpoint funcional encontrado: ${API_BASE}`);
            return true;
        }
    }
    console.log('❌ Ningún endpoint funciona');
    return false;
}

async function verificarConexion() {
    const indicator = document.getElementById('backend-status-indicator');
    if (!indicator) return false;
    indicator.textContent = '⏳ Buscando backend disponible...';
    indicator.style.background = '#ffc107';
    indicator.style.color = '#212529';
    try {
        const encontrado = await encontrarEndpointFuncional();
        if (encontrado) {
            indicator.textContent = `✅ Conectado: ${API_BASE}`;
            indicator.style.background = '#28a745';
            indicator.style.color = 'white';
            return true;
        } else {
            throw new Error('Ningún endpoint disponible');
        }
    } catch (err) {
        console.error('❌ Error detallado de conexión:', err);
        indicator.textContent = '❌ Backend no disponible';
        indicator.style.background = '#dc3545';
        indicator.style.color = 'white';
        return false;
    }
}

// === FUNCIONES DE PROVEEDORES ===
async function cargarProveedores() {
    try {
        const res = await fetch(`${API_BASE}/proveedores`, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (!res.ok) {
            throw new Error(`Error del servidor: ${res.status}`);
        }
        const data = await res.json();
        proveedoresData = Array.isArray(data) ? data : [];
        actualizarTablaProveedores();
        console.log(`✅ Cargados ${proveedoresData.length} proveedores`);
        return proveedoresData;
    } catch (err) {
        console.error('Error al cargar proveedores:', err);
        proveedoresData = [];
        actualizarTablaProveedores();
        throw err;
    }
}

async function agregarProveedor(datosProveedor) {
    mostrarSpinner('Guardando proveedor...');
    try {
        if (!datosProveedor.nombre || datosProveedor.nombre.trim().length < 2) {
            throw new Error('El nombre debe tener al menos 2 caracteres');
        }
        const res = await fetch(`${API_BASE}/proveedores`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: datosProveedor.nombre.trim(),
                patron: (datosProveedor.patron || '').toLowerCase(),
                diasSemana: datosProveedor.diasSemana,
                cadaNDias: datosProveedor.cadaNDias,
                fechaInicio: datosProveedor.fechaInicio,
                tipoVisita: datosProveedor.tipoVisita
            })
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || `Error HTTP ${res.status}`);
        }
        const nuevoProveedor = await res.json();
        console.log('✅ Proveedor creado:', nuevoProveedor);
        await crearVisitasParaProveedor(nuevoProveedor.id, datosProveedor);
        await cargarTodosLosDatos();
        document.getElementById('proveedor-form').reset();
        alert('✅ Proveedor y visitas agregados exitosamente');
    } catch (err) {
        console.error('Error al agregar proveedor:', err);
        alert('❌ Error al guardar proveedor: ' + err.message);
    }
    ocultarSpinner();
}

async function eliminarProveedor(id) {
    if (!confirm('¿Estás seguro de eliminar este proveedor? Se eliminarán todas sus visitas y asistencias.')) return;
    mostrarSpinner('Eliminando proveedor...');
    try {
        const res = await fetch(`${API_BASE}/proveedores/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        alert('Proveedor eliminado');
        await cargarTodosLosDatos();
    } catch (err) {
        alert('Error al eliminar proveedor: ' + err.message);
    }
    ocultarSpinner();
}

async function editarProveedor(id) {
    const proveedor = proveedoresData.find(p => p.id === id);
    if (!proveedor) return;
    const nuevoNombre = prompt('Editar nombre del proveedor:', proveedor.nombre);
    if (!nuevoNombre || !nuevoNombre.trim() || nuevoNombre.trim() === proveedor.nombre) return;
    mostrarSpinner('Actualizando proveedor...');
    try {
        const res = await fetch(`${API_BASE}/proveedores/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nuevoNombre.trim() })
        });
        if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            throw new Error(e.error || `HTTP ${res.status}`);
        }
        await cargarTodosLosDatos();
    } catch (err) {
        alert('Error al editar proveedor: ' + err.message);
    }
    ocultarSpinner();
}

// === FUNCIONES PARA VISITAS ===
async function crearVisitasParaProveedor(proveedorId, datosProveedor) {
    const fechaInicio = datosProveedor.fechaInicio || localISO(new Date());
    const patron = datosProveedor.patron || 'weekly';
    let fechas = [];
    if (patron === 'daily') {
        fechas = generarCadaNDias(fechaInicio, 1, 30);
    } else if (patron === 'everyNDays') {
        const n = Math.max(2, Number(datosProveedor.cadaNDias || 2));
        fechas = generarCadaNDias(fechaInicio, n, 30);
    } else { // weekly
        const diasSemana = Array.isArray(datosProveedor.diasSemana) ? datosProveedor.diasSemana : [];
        fechas = generarFechasSemanal(diasSemana, fechaInicio, 30, 1);
    }
    for (const fecha of fechas) {
        await fetch(`${API_BASE}/visitas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proveedor_id: proveedorId, fecha: fecha, tipoVisita: datosProveedor.tipoVisita })
        });
    }
}

function generarFechasSemanal(diasSemanaNumeros, fechaInicio, diasAdelante, frecuenciaSemanas) {
    const fechas = [];
    const inicio = new Date(fechaInicio);
    const pasoDias = 7 * Math.max(1, Number(frecuenciaSemanas || 1));
    // Encontrar la primera semana de referencia donde cae alguno de los días
    const primeros7 = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(inicio);
        d.setDate(inicio.getDate() + i);
        if (diasSemanaNumeros.includes(d.getDay())) {
            primeros7.push(new Date(d));
        }
    }
    const referencia = primeros7.length ? primeros7[0] : inicio;
    for (let offset = 0; offset <= diasAdelante; offset += pasoDias) {
        const base = new Date(referencia);
        base.setDate(referencia.getDate() + offset);
        // Añadir los días de esa semana
        for (const dow of diasSemanaNumeros) {
            const f = new Date(base);
            const diff = (dow - f.getDay() + 7) % 7; // días hasta dow dentro de la semana
            f.setDate(f.getDate() + diff);
            if ((f - inicio) / (24*3600*1000) <= diasAdelante) {
                fechas.push(localISO(f));
            }
        }
    }
    // Quitar duplicados y ordenar
    return Array.from(new Set(fechas)).sort();
}

function generarCadaNDias(fechaInicio, nDias, diasAdelante) {
    const fechas = [];
    const inicio = new Date(fechaInicio);
    for (let i = 0; i <= diasAdelante; i += nDias) {
        const f = new Date(inicio);
        f.setDate(inicio.getDate() + i);
        fechas.push(localISO(f));
    }
    return fechas;
}

// === FUNCIONES PARA ASISTENCIA DIARIA ===
async function cargarProveedoresHoy() {
    const hoy = localISO(new Date());
    const lbl = document.getElementById('fecha-hoy');
    if (lbl) lbl.textContent = new Date().toLocaleDateString('es-ES');
    try {
        // Traer asistencias frescas antes de pintar
        try {
            const resAs = await fetch(`${API_BASE}/asistencias`);
            if (resAs.ok) asistenciasData = await resAs.json();
        } catch {}
        // Usar autogen=1 para asegurar visitas programadas
        const res = await fetch(`${API_BASE}/visitas?fecha=${hoy}&autogen=1`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const visitasHoy = await res.json();
        const tbody = document.querySelector('#tabla-proveedores-hoy tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const visita of visitasHoy) {
            const proveedor = proveedoresData.find(p => p.id === visita.proveedor_id);
            if (!proveedor) continue;
            const tipoCanon = tipoFor(visita, proveedor);
            const label = labelForTipo(tipoCanon);
            const tipoDisplay = tipoCanon;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${proveedor.nombre}</td>
                <td>${tipoDisplay}</td>
                <td class="asistencia-container">
                    <input type="checkbox" id="asistencia-${visita.id}"
                        data-proveedor-id="${visita.proveedor_id}"
                        data-fecha="${visita.fecha}"
                        data-tipo="${tipoCanon}"
                        onchange="marcarAsistencia(${visita.id}, this.checked)">
                    <label for="asistencia-${visita.id}">${label}</label>
                </td>
            `;
            tbody.appendChild(tr);
            // Prefill asistencia si existe
            const prev = asistenciasData
                .filter(a => a.visita_id === visita.id)
                .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
            if (prev) {
                const chk = document.getElementById(`asistencia-${visita.id}`);
                const checked = Number(prev.asistio) === 1;
                chk.checked = checked;
            }
        }
        const empty = document.getElementById('asistencia-empty');
        if (empty) empty.style.display = tbody.children.length === 0 ? 'block' : 'none';
    // Actualizar métrica de "Visitas hoy" con el conteo real del día cargado (autogen incluido)
    const metr = document.getElementById('metrica-ultimos');
    if (metr) metr.textContent = visitasHoy.length;
    } catch (err) {
        console.error('Error al cargar proveedores de hoy:', err);
    }
}

async function cargarProveedoresDeFecha(fechaISO) {
    const fecha = fechaISO || localISO(new Date());
    const lbl = document.getElementById('fecha-hoy');
    if (lbl) lbl.textContent = new Date(fecha).toLocaleDateString('es-ES');
    try {
        // Traer asistencias frescas antes de pintar
        try {
            const resAs = await fetch(`${API_BASE}/asistencias`);
            if (resAs.ok) asistenciasData = await resAs.json();
        } catch {}
        const res = await fetch(`${API_BASE}/visitas?fecha=${fecha}&autogen=1`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const visitasDia = await res.json();
        const tbody = document.querySelector('#tabla-proveedores-hoy tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const visita of visitasDia) {
            const proveedor = proveedoresData.find(p => p.id === visita.proveedor_id);
            if (!proveedor) continue;
            const tipoCanon = tipoFor(visita, proveedor);
            const label = labelForTipo(tipoCanon);
            const tipoDisplay = tipoCanon;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${proveedor.nombre}</td>
                <td>${tipoDisplay}</td>
                <td class="asistencia-container">
                    <input type="checkbox" id="asistencia-${visita.id}"
                        data-proveedor-id="${visita.proveedor_id}"
                        data-fecha="${visita.fecha}"
                        data-tipo="${tipoCanon}"
                        onchange="marcarAsistencia(${visita.id}, this.checked)">
                    <label for="asistencia-${visita.id}">${label}</label>
                </td>`;
            tbody.appendChild(tr);
            // Prefill asistencia si existe un registro previo
            const prev = asistenciasData
                .filter(a => a.visita_id === visita.id)
                .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
            if (prev) {
                const chk = document.getElementById(`asistencia-${visita.id}`);
                const checked = Number(prev.asistio) === 1;
                chk.checked = checked;
            }
        }
        const empty = document.getElementById('asistencia-empty');
        if (empty) empty.style.display = tbody.children.length === 0 ? 'block' : 'none';
        // Si la fecha seleccionada es hoy, actualizar la métrica de "Visitas hoy"
        if (fecha === localISO(new Date())) {
            const metr = document.getElementById('metrica-ultimos');
            if (metr) metr.textContent = visitasDia.length;
        }
    } catch (e) { console.error(e); }
}

async function marcarAsistencia(visitaId, checked) {
    const checkbox = document.getElementById(`asistencia-${visitaId}`);
    try {
        const visita = visitasData.find(v => v.id === visitaId);
        const proveedor = proveedoresData.find(p => p.id === visita?.proveedor_id);
        const tipoCanon = tipoFor(visita, proveedor);
        let asistio = 0, hizo_preventa = null, estado_especifico = '';
        if (tipoCanon.toLowerCase().includes('preventa')) {
            hizo_preventa = checked ? 1 : 0;
            asistio = checked ? 1 : 0;
            estado_especifico = checked ? 'Pedir' : 'No pedir';
        } else if (tipoCanon.toLowerCase().includes('entrega')) {
            asistio = checked ? 1 : 0;
            estado_especifico = checked ? 'Entregó' : 'No entregó';
        } else {
            asistio = checked ? 1 : 0;
            estado_especifico = checked ? 'A tiempo' : 'No asistió';
        }
        const datosAsistencia = { visita_id: visitaId, asistio, hizo_preventa, estado_especifico };
        const res = await fetch(`${API_BASE}/asistencias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datosAsistencia)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Si Preventa y pidió, crear visita de entrega para mañana si no existe
        if (visita && tipoCanon.toLowerCase().includes('preventa') && checked) {
            const hoyLocal = new Date(`${visita.fecha}T00:00:00`);
            const manana = new Date(hoyLocal);
            manana.setDate(hoyLocal.getDate() + 1);
            const fechaManana = localISO(manana);
            const existe = visitasData.some(v => v.proveedor_id === visita.proveedor_id && v.fecha === fechaManana && String(v.tipoVisita).toLowerCase().includes('entrega'));
            if (!existe) {
                await fetch(`${API_BASE}/visitas`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ proveedor_id: visita.proveedor_id, fecha: fechaManana, tipoVisita: 'Entrega de Pedido' })
                });
                try {
                    const resVis = await fetch(`${API_BASE}/visitas`);
                    if (resVis.ok) visitasData = await resVis.json();
                } catch {}
            }
        }
        // Refrescar asistencias después de guardar para que la UI persista
        try {
            const resAs = await fetch(`${API_BASE}/asistencias`);
            if (resAs.ok) asistenciasData = await resAs.json();
        } catch {}
    } catch (err) {
        console.error('Error al guardar asistencia:', err);
        if (checkbox) checkbox.checked = !checked;
    }
}

// === FUNCIONES GENERALES ===
function actualizarTablaProveedores() {
    const tbody = document.querySelector('#tablaGestionProveedores tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    proveedoresData.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${p.nombre}</td>
            <td>Ver calendario</td>
            <td>Múltiples tipos</td>
            <td>
                <button class="btn-editar-proveedor" onclick="editarProveedor(${p.id})">Editar</button>
                <button class="btn-eliminar-proveedor" onclick="eliminarProveedor(${p.id})">Eliminar</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    // Rellenar selector de proveedores en Asistencia Diaria (si existe)
    const selProvHoy = document.getElementById('selectProveedorHoy');
    if (selProvHoy) {
        if (proveedoresData.length) {
            selProvHoy.innerHTML = proveedoresData.map(p => `<option value="${p.id}">${p.nombre}</option>`).join('');
        } else {
            selProvHoy.innerHTML = '<option value="">— Sin proveedores —</option>';
        }
    }
}

function actualizarMetricasPanel() {
    try {
        const activos = proveedoresData.length;
        const fechaHoy = localISO(new Date());
        const visitasHoy = visitasData.filter(v => v.fecha === fechaHoy).length;
        const asistenciasRecientes = asistenciasData.length;
        document.getElementById('metrica-activos').textContent = activos;
        document.getElementById('metrica-ultimos').textContent = visitasHoy;
        document.getElementById('metrica-actualizaciones').textContent = asistenciasRecientes;
    } catch (err) {
        console.error('Error al actualizar métricas:', err);
    }
}

async function cargarTodosLosDatos() {
    mostrarSpinner('Sincronizando datos...');
    try {
        await cargarProveedores();
        try {
            const resVisitas = await fetch(`${API_BASE}/visitas`);
            if (resVisitas.ok) {
                visitasData = await resVisitas.json();
                console.log(`✅ Cargadas ${visitasData.length} visitas`);
            }
        } catch (err) {
            console.warn('⚠️ No se pudieron cargar las visitas:', err);
            visitasData = [];
        }
        try {
            const resAsistencias = await fetch(`${API_BASE}/asistencias`);
            if (resAsistencias.ok) {
                asistenciasData = await resAsistencias.json();
                console.log(`✅ Cargadas ${asistenciasData.length} asistencias`);
            }
        } catch (err) {
            console.warn('⚠️ No se pudieron cargar las asistencias:', err);
            asistenciasData = [];
        }
        actualizarMetricasPanel();
        console.log('✅ Datos sincronizados correctamente');
    } catch (err) {
        console.error('❌ Error al cargar datos:', err);
        alert('⚠️ Error al sincronizar algunos datos. Revisa la conexión.');
    }
    ocultarSpinner();
}

// === INICIALIZACIÓN ===
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Iniciando aplicación...');
    document.getElementById('btnRegistrar').addEventListener('click', () => mostrarSeccion('registroProveedores'));
    document.getElementById('btnAsistencia').addEventListener('click', () => { mostrarSeccion('asistenciaDiaria'); if (appInicializada) cargarProveedoresHoy(); });
    document.getElementById('btnVerGestionProveedores').addEventListener('click', () => mostrarSeccion('gestionProveedores'));
    document.getElementById('btnReportes').addEventListener('click', () => mostrarSeccion('reportes'));
    // Toggle UI de patrón
    const radios = document.querySelectorAll('input[name="patronVisita"]');
    const panelSem = document.getElementById('panel-semanal');
    const panelCadaN = document.getElementById('panel-cada-n');
    radios.forEach(r => r.addEventListener('change', () => {
        const v = (document.querySelector('input[name="patronVisita"]:checked')||{}).value;
        panelSem.style.display = v === 'weekly' ? 'flex' : 'none';
        panelCadaN.style.display = v === 'everyNDays' ? 'block' : 'none';
    }));
    document.getElementById('proveedor-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!validarFormulario()) return;
        const datosProveedor = {
            nombre: document.getElementById('nombre').value.trim(),
            patron: (document.querySelector('input[name="patronVisita"]:checked')||{}).value,
            diasSemana: Array.from(document.querySelectorAll('input[name="diasSemana"]:checked')).map(el => Number(el.value)),
            cadaNDias: Number(document.getElementById('cada-n-dias')?.value || 0),
            fechaInicio: document.getElementById('fecha-inicio').value || null,
            tipoVisita: document.getElementById('tipo-visita').value
        };
        await agregarProveedor(datosProveedor);
    });
    document.getElementById('btnRefrescarDatos').addEventListener('click', async () => {
        await verificarConexion();
        await cargarTodosLosDatos();
        const f = document.getElementById('asistenciaFecha')?.value || localISO(new Date());
        await cargarProveedoresDeFecha(f);
    });
    const btnExport = document.getElementById('btnExportarDatos');
    if (btnExport) btnExport.addEventListener('click', exportarDatos);
    const btnImport = document.getElementById('btnImportarDatos');
    if (btnImport) btnImport.addEventListener('click', () => document.getElementById('importFile').click());
    const importFile = document.getElementById('importFile');
    if (importFile) importFile.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) importarDatosDesdeArchivo(file);
        e.target.value = '';
    });
    function aISO(fecha) { return new Date(fecha).toISOString().split('T')[0]; }
    function setFechasYGenerar(dias) {
        const fin = new Date();
        const ini = new Date();
        ini.setDate(fin.getDate() - (dias - 1));
        document.getElementById('fechaInicioReporte').value = aISO(ini);
        document.getElementById('fechaFinReporte').value = aISO(fin);
        generarReporte(aISO(ini), aISO(fin));
    }
    document.getElementById('btnReporteUltimos3Dias').addEventListener('click', () => setFechasYGenerar(3));
    document.getElementById('btnReporteUltimos7Dias').addEventListener('click', () => setFechasYGenerar(7));
    document.getElementById('btnReporteUltimos15Dias').addEventListener('click', () => setFechasYGenerar(15));
    document.getElementById('btnReporteUltimoMes').addEventListener('click', () => setFechasYGenerar(30));
    const btn5 = document.getElementById('btnReporteUltimos5Dias'); if (btn5) btn5.addEventListener('click', () => setFechasYGenerar(5));
    document.getElementById('btnGenerarReportePersonalizado').addEventListener('click', () => {
        const fi = document.getElementById('fechaInicioReporte').value;
        const ff = document.getElementById('fechaFinReporte').value;
        if (!fi || !ff) { document.getElementById('errorReporte').textContent = 'Selecciona ambas fechas'; return; }
        generarReporte(fi, ff);
    });
    document.getElementById('btnExportarReporteCSV').addEventListener('click', exportarTablaReporteCSV);
    // Set default fecha asistencia = hoy local
    const inpFecha = document.getElementById('asistenciaFecha');
    if (inpFecha) inpFecha.value = localISO(new Date());
    // Mostrar Asistencia de inmediato
    mostrarSeccion('asistenciaDiaria');
    // Luego conectar y cargar datos
    await verificarConexion();
    await cargarTodosLosDatos();
    appInicializada = true;
    await cargarProveedoresHoy();
    // Cambiar fecha de asistencia
    if (inpFecha) {
        inpFecha.addEventListener('change', async () => { await cargarProveedoresDeFecha(inpFecha.value); });
    }
    // Toggle herramientas de asistencia
    const toggleBtn = document.getElementById('toggleAsistenciaTools');
    const tools = document.getElementById('asistencia-tools');
    if (toggleBtn && tools) {
        toggleBtn.addEventListener('click', () => { const visible = tools.style.display !== 'none'; tools.style.display = visible ? 'none' : 'block'; });
    }
    // Auto refresh toggle
    let autoTimer = null;
    const chk = document.getElementById('autoRefreshChk');
    const minsSel = document.getElementById('autoRefreshMins');
    function startAuto() {
        stopAuto();
        const m = Number(minsSel.value || 2);
        autoTimer = setInterval(async () => {
            const f = document.getElementById('asistenciaFecha')?.value || localISO(new Date());
            await cargarProveedoresDeFecha(f);
        }, m * 60000);
    }
    function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
    if (chk && minsSel) {
        chk.addEventListener('change', () => chk.checked ? startAuto() : stopAuto());
        minsSel.addEventListener('change', () => { if (chk.checked) startAuto(); });
    }
    // Handler para agregar visita manual en fecha seleccionada
    const btnAddHoy = document.getElementById('btnAgregarVisitaHoy');
    if (btnAddHoy) {
        btnAddHoy.addEventListener('click', async () => {
            const provSel = document.getElementById('selectProveedorHoy');
            const tipoSel = document.getElementById('selectTipoHoy');
            const proveedor_id = Number(provSel.value);
            const tipoVisita = tipoSel.value || 'Visita Normal';
            const fecha = document.getElementById('asistenciaFecha')?.value || localISO(new Date());
            if (!proveedor_id) { alert('Selecciona un proveedor'); return; }
            try {
                await fetch(`${API_BASE}/visitas`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ proveedor_id, fecha, tipoVisita })
                });
                // Refrescar visitas y tabla de hoy
                const resVis = await fetch(`${API_BASE}/visitas`);
                if (resVis.ok) visitasData = await resVis.json();
                await cargarProveedoresDeFecha(fecha);
                actualizarMetricasPanel();
            } catch (e) { alert('No se pudo crear la visita: ' + e.message); }
        });
    }
    // Handler para crear visitas para TODOS los proveedores en la fecha seleccionada
    const btnTodos = document.getElementById('btnCrearTodosFecha');
    if (btnTodos) {
        btnTodos.addEventListener('click', async () => {
            const fecha = document.getElementById('asistenciaFecha')?.value || localISO(new Date());
            const tipoVisita = document.getElementById('selectTipoTodos')?.value || 'Visita Normal';
            if (!proveedoresData.length) { alert('No hay proveedores'); return; }
            try {
                for (const p of proveedoresData) {
                    const ya = visitasData.some(v => v.proveedor_id === p.id && v.fecha === fecha && v.tipoVisita === tipoVisita);
                    if (ya) continue;
                    await fetch(`${API_BASE}/visitas`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ proveedor_id: p.id, fecha, tipoVisita })
                    });
                }
                const resVis = await fetch(`${API_BASE}/visitas`);
                if (resVis.ok) visitasData = await resVis.json();
                await cargarProveedoresDeFecha(fecha);
                actualizarMetricasPanel();
            } catch (e) { alert('Error creando visitas: ' + e.message); }
        });
    }
    console.log('✅ Aplicación lista');
});

// === EXPORTAR / IMPORTAR ===
async function exportarDatos() {
    mostrarSpinner('Exportando datos...');
    try {
        const res = await fetch(`${API_BASE}/admin/export`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const ts = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `backup-proveedores-${ts}.json`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (err) { alert('Error al exportar: ' + err.message); }
    ocultarSpinner();
}

async function importarDatosDesdeArchivo(file) {
    try {
        const texto = await file.text();
        const data = JSON.parse(texto);
        if (!confirm('Esto reemplazará todos los datos actuales. ¿Continuar?')) return;
        mostrarSpinner('Importando datos...');
        const res = await fetch(`${API_BASE}/admin/import`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await cargarTodosLosDatos();
        alert('Datos importados');
    } catch (err) {
        alert('Error al importar: ' + (err.message || 'Archivo inválido'));
    }
    ocultarSpinner();
}

// === REPORTES ===
function aISO(fecha) { return new Date(fecha).toISOString().split('T')[0]; }
function rangoFechasISO(desde, hasta) {
    const d = new Date(desde), h = new Date(hasta);
    const res = [];
    for (let x = new Date(d); x <= h; x.setDate(x.getDate() + 1)) {
        res.push(x.toISOString().split('T')[0]);
    }
    return res;
}

async function generarReporte(fechaInicio, fechaFin) {
    const inicio = new Date(fechaInicio);
    const fin = new Date(fechaFin);
    if (isNaN(inicio) || isNaN(fin) || inicio > fin) {
        document.getElementById('errorReporte').textContent = 'Rango de fechas inválido';
        return;
    }
    document.getElementById('errorReporte').textContent = '';
    const fechas = rangoFechasISO(inicio, fin); // array de YYYY-MM-DD
    mostrarSpinner('Generando reporte...');
    try {
        // asegurar proveedores y asistencias frescos
        if (!proveedoresData.length) { await cargarProveedores(); }
        try {
            const resAs = await fetch(`${API_BASE}/asistencias`);
            if (resAs.ok) asistenciasData = await resAs.json();
        } catch {}
        const provById = new Map(proveedoresData.map(p => [p.id, p]));
        const asistByVisita = asistenciasData.reduce((acc, a) => { (acc[a.visita_id] ||= []).push(a); return acc; }, {});
        const rows = [];
        // Obtener visitas por día con autogen=1 para que existan
        for (const f of fechas) {
            try {
                const res = await fetch(`${API_BASE}/visitas?fecha=${f}&autogen=1`);
                if (!res.ok) continue;
                const visitasF = await res.json();
                for (const v of visitasF) {
                    const p = provById.get(v.proveedor_id);
                    const ultA = visitsafe(asistByVisita[v.id]).sort((a,b)=> (b.id||0)-(a.id||0))[0];
                    rows.push({
                        fecha: f,
                        proveedor: p ? p.nombre : '—',
                        tipo: v.tipoVisita || '—',
                        asistio: ultA ? (Number(ultA.asistio) === 1 ? 'Sí' : 'No') : 'No',
                        preventa: ultA && ultA.hizo_preventa ? ultA.hizo_preventa : '—',
                        estado: ultA && ultA.estado_especifico ? ultA.estado_especifico : '—'
                    });
                }
            } catch {}
        }
        renderTablaReporte(rows);
    } finally { ocultarSpinner(); }
}

function visitsafe(arr) { return Array.isArray(arr) ? arr : []; }

function renderTablaReporte(rows) {
    const cont = document.getElementById('tablaReporte');
    if (!cont) return;
    if (!rows.length) { cont.innerHTML = '<p>No hay datos para el rango seleccionado.</p>'; return; }
    let html = '<table><thead><tr>' +
        '<th>Fecha</th><th>Proveedor</th><th>Tipo</th><th>Asistió</th><th>Preventa</th><th>Estado</th>' +
        '</tr></thead><tbody>';
    for (const r of rows) {
        html += `<tr><td>${r.fecha}</td><td>${r.proveedor}</td><td>${r.tipo}</td><td>${r.asistio}</td><td>${r.preventa}</td><td>${r.estado}</td></tr>`;
    }
    html += '</tbody></table>';
    cont.innerHTML = html;
}

function exportarTablaReporteCSV() {
    const cont = document.getElementById('tablaReporte');
    const table = cont && cont.querySelector('table');
    if (!table) { alert('No hay tabla para exportar'); return; }
    const rows = Array.from(table.querySelectorAll('tr')).map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => td.textContent));
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'reporte_asistencias.csv';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// Exponer funciones usadas por atributos inline en HTML
window.marcarAsistencia = marcarAsistencia;
window.eliminarProveedor = eliminarProveedor;
window.editarProveedor = editarProveedor;
