// ==============================================================================
// PROTECCIÓN DE COTIZACIONES CONTRA SINCRONIZACIONES OFFLINE VIEJAS
// ==============================================================================
// El servidor es la autoridad. Una PC que estuvo días sin conectarse (o que
// tiene una versión antigua del programa) no debe poder:
//   - sobrescribir una cotización que otra persona cambió después,
//   - cambiar folios,
//   - recrear cotizaciones que ya se eliminaron,
//   - borrar cotizaciones que siguieron trabajándose.
// Estas funciones no dependen de Express ni de MongoDB para poder probarse.
// ==============================================================================

const MAX_OFFLINE_AGE_MS = Math.max(1, Number(process.env.MAX_OFFLINE_AGE_HOURS) || 48) * 60 * 60 * 1000;
const MIN_OFFLINE_APP_VERSION = String(process.env.MIN_OFFLINE_APP_VERSION || '2.1.7');

// Campos que sólo administra el servidor. Una sincronización offline nunca los
// modifica (folio incluido: el folio lo asigna únicamente la nube).
const CAMPOS_PROTEGIDOS_OFFLINE = [
    '_id', 'id', 'folio', 'revision', 'colaboracionActualizadaEn', 'offlineOperationId', 'offlineTempId',
    'proyectoActivoId', 'accesosPortal', 'permisosPortalModificacion', 'cotizacionOriginalId', 'esModificadaPorCliente'
];

const ID_TEMPORAL = /^(offline_|local_)/i;
const FOLIO_AUTOMATICO = /^C\d+$/i;
const FOLIO_SIN_VALOR = ['', 'asignación automática', 'asignacion automatica', 'sin folio', 'personalizado'];

function numero(valor, fallback = 0) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : fallback;
}

function esIdTemporal(id) {
    return ID_TEMPORAL.test(String(id || ''));
}

function compararVersiones(a, b) {
    const pa = String(a || '').split('.').map(x => parseInt(x, 10) || 0);
    const pb = String(b || '').split('.').map(x => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

function header(req, nombre) {
    if (!req) return '';
    if (typeof req.get === 'function') return req.get(nombre) || '';
    const headers = req.headers || {};
    return headers[String(nombre).toLowerCase()] || '';
}

// Petición enviada por la cola offline del programa de escritorio.
function esPeticionColaOffline(req) {
    return header(req, 'x-offline-sync') === 'true';
}

// Petición que trae datos marcados como editados sin conexión (también las de
// versiones antiguas que no enviaban el encabezado).
function esPeticionOffline(req) {
    const body = req?.body || {};
    return esPeticionColaOffline(req) || Boolean(body._provieneDeOffline || body._offlineModified);
}

// Valida versión del programa y antigüedad del cambio. Sólo aplica a la cola
// offline (encabezado X-Offline-Sync), nunca a peticiones normales en línea.
// Devuelve null si se acepta, o { status, body } con el rechazo.
function validarClienteOffline(req, ahora = Date.now()) {
    if (!esPeticionColaOffline(req)) return null;
    const version = header(req, 'x-app-version');
    if (!version || compararVersiones(version, MIN_OFFLINE_APP_VERSION) < 0) {
        return {
            status: 426,
            body: {
                error: `Esta PC tiene una versión antigua del CRM (${version || 'desconocida'}). Actualiza el programa para subir sus cambios sin conexión.`,
                code: 'app_desactualizada',
                minVersion: MIN_OFFLINE_APP_VERSION
            }
        };
    }
    const modificado = numero(header(req, 'x-offline-modified') || req?.body?._offlineModified, 0);
    // La antigüedad se mide con el reloj de la misma PC (hora de su cambio contra
    // su hora actual), así un reloj mal configurado no altera el resultado.
    const ahoraCliente = numero(header(req, 'x-client-now'), 0) || ahora;
    if (modificado > 0 && ahoraCliente - modificado > MAX_OFFLINE_AGE_MS) {
        return {
            status: 409,
            body: {
                error: `El cambio se hizo sin conexión hace más de ${Math.round(MAX_OFFLINE_AGE_MS / 3600000)} h. Se guardó para revisión y no se aplicó.`,
                code: 'offline_expirado'
            }
        };
    }
    return null;
}

// La PC debe haber editado sobre la misma revisión que tiene la nube.
function conflictoDeRevision(docServidor, revisionCliente) {
    const revServidor = numero(docServidor?.revision, 0);
    const revCliente = numero(revisionCliente, 0);
    if (revServidor > revCliente) {
        return {
            status: 409,
            body: {
                error: 'La cotización cambió en la nube después de que esta PC la editó sin conexión. Se guardó para revisión y no se aplicó.',
                code: 'revision_desactualizada',
                revisionServidor: revServidor,
                revisionCliente: revCliente
            }
        };
    }
    return null;
}

function quitarCamposProtegidos(data) {
    if (!data || typeof data !== 'object') return data;
    CAMPOS_PROTEGIDOS_OFFLINE.forEach(campo => { delete data[campo]; });
    Object.keys(data).forEach(campo => { if (campo.startsWith('_offline') || campo.startsWith('_mesh')) delete data[campo]; });
    delete data._provieneDeOffline;
    delete data._draftId;
    return data;
}

// Para altas que vienen de la cola offline: los folios con forma automática
// (C123) u OFF-* se calcularon con una lista vieja, así que el servidor asigna
// uno nuevo. Un folio personalizado se respeta si sigue libre.
function folioOfflineDebeRegenerarse(folio) {
    const f = String(folio || '').trim();
    return FOLIO_SIN_VALOR.includes(f.toLowerCase()) || /^OFF-/i.test(f) || FOLIO_AUTOMATICO.test(f);
}

// Convierte cualquier actualización de Mongoose para que incremente la revisión
// y la marca de tiempo, salvo que la ruta ya las establezca.
function aplicarRevisionAUpdate(update, ahora = new Date()) {
    if (!update || typeof update !== 'object' || Array.isArray(update)) return update;
    const claves = Object.keys(update);
    const out = {};
    const planos = {};
    claves.forEach(k => {
        if (k.startsWith('$')) out[k] = { ...(update[k] || {}) };
        else planos[k] = update[k];
    });
    if (Object.keys(planos).length) out.$set = { ...(out.$set || {}), ...planos };
    const tocaRevision = (out.$set && Object.prototype.hasOwnProperty.call(out.$set, 'revision'))
        || (out.$inc && Object.prototype.hasOwnProperty.call(out.$inc, 'revision'));
    if (!tocaRevision) out.$inc = { ...(out.$inc || {}), revision: 1 };
    const tocaFecha = out.$set && Object.prototype.hasOwnProperty.call(out.$set, 'colaboracionActualizadaEn');
    if (!tocaFecha) out.$set = { ...(out.$set || {}), colaboracionActualizadaEn: ahora };
    return out;
}

// Hooks de Mongoose: cualquier escritura (estado, convertir a proyecto,
// cancelar venta, archivos, folios, portal...) incrementa la revisión. Así una
// PC vieja siempre detecta que la nube cambió.
function instalarRevisionAutomatica(schema) {
    schema.pre('save', function () {
        if (this.isNew) {
            if (!this.colaboracionActualizadaEn) this.colaboracionActualizadaEn = new Date();
            return;
        }
        if (this.$locals && this.$locals.sinRevision) return;
        if (!this.isModified()) return;
        if (!this.isModified('revision')) this.revision = numero(this.revision, 0) + 1;
        if (!this.isModified('colaboracionActualizadaEn')) this.colaboracionActualizadaEn = new Date();
    });
    schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
        const opciones = typeof this.getOptions === 'function' ? this.getOptions() : {};
        if (opciones && opciones.sinRevision) return;
        const update = this.getUpdate();
        const nuevo = aplicarRevisionAUpdate(update);
        if (nuevo !== update) this.setUpdate(nuevo);
    });
}

module.exports = {
    MAX_OFFLINE_AGE_MS,
    MIN_OFFLINE_APP_VERSION,
    CAMPOS_PROTEGIDOS_OFFLINE,
    numero,
    esIdTemporal,
    compararVersiones,
    esPeticionColaOffline,
    esPeticionOffline,
    validarClienteOffline,
    conflictoDeRevision,
    quitarCamposProtegidos,
    folioOfflineDebeRegenerarse,
    aplicarRevisionAUpdate,
    instalarRevisionAutomatica
};
