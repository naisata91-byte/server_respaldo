/* ═══ TICKETS DE SEGUIMIENTO (portal de clientes ↔ CRM) ═══════════════════════
   Distintos de los "tickets" de entregables (colección `tickets` de server_email).
   Se montan desde server_2.js:
     require('./tickets-soporte-routes')({ app, mongoose, authCliente, CRMArchivo, UserRef, notificar })

   Rutas del cliente (header x-cliente-token):
     GET  /api/clientes/tickets
     GET  /api/clientes/tickets/:id
     POST /api/clientes/tickets
     POST /api/clientes/tickets/:id/mensajes
   Rutas del CRM (headers x-crm-user-id + x-crm-token): ver más abajo.
   ════════════════════════════════════════════════════════════════════════════ */
'use strict';

const ESTADOS = ['abierto', 'en_proceso', 'esperando_cliente', 'resuelto', 'cerrado'];
const CATEGORIAS = ['falla', 'solicitud', 'duda', 'otro'];
const PRIORIDADES = ['normal', 'urgente'];
const TIPOS_RELACION = ['cotizacion', 'proyecto', 'entregable'];
const MAX_FOTOS = 5;
const MAX_BYTES_FOTO = 5 * 1024 * 1024;
const TIPOS_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'];

function httpErr(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

function responderError(res, e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[Tickets soporte]', e);
    return res.status(500).json({ error: 'No se pudo procesar el ticket. Intenta de nuevo.' });
}

function textoValido(valor, min, max, campo) {
    const t = typeof valor === 'string' ? valor.trim() : '';
    if (t.length < min || t.length > max) throw httpErr(400, `${campo} debe tener entre ${min} y ${max} caracteres`);
    return t;
}

// Revisa las fotos SIN guardar nada; devuelve [{ nombre, contentType, buffer }]
function validarFotos(fotos) {
    if (fotos === undefined || fotos === null) return [];
    if (!Array.isArray(fotos)) throw httpErr(400, 'Formato de fotos inválido');
    if (fotos.length > MAX_FOTOS) throw httpErr(400, `Máximo ${MAX_FOTOS} fotos por mensaje`);
    return fotos.map((f, i) => {
        const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(String((f && f.dataUrl) || ''));
        if (!m) throw httpErr(400, 'Formato de foto inválido');
        const contentType = m[1].toLowerCase();
        if (!TIPOS_IMAGEN.includes(contentType)) throw httpErr(400, 'Sólo se aceptan fotos JPG, PNG o WEBP');
        const buffer = Buffer.from(m[2], 'base64');
        if (buffer.length > MAX_BYTES_FOTO) throw httpErr(413, 'Cada foto debe pesar menos de 5 MB');
        const nombre = String((f && f.nombre) || `foto-${i + 1}.jpg`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
        return { nombre, contentType, buffer };
    });
}

function validarRelacion(relacion) {
    if (relacion === undefined || relacion === null || relacion === '') return undefined;
    if (typeof relacion !== 'object' || !TIPOS_RELACION.includes(relacion.tipo) || !relacion.id) {
        throw httpErr(400, 'Relación inválida');
    }
    return {
        tipo: relacion.tipo,
        id: String(relacion.id).slice(0, 100),
        folio: relacion.folio ? String(relacion.folio).slice(0, 60) : undefined
    };
}

module.exports = function ({ app, mongoose, authCliente, CRMArchivo, UserRef, notificar }) {
    const avisar = typeof notificar === 'function' ? notificar : () => {};

    const MensajeSchema = new mongoose.Schema({
        autorTipo: { type: String, enum: ['cliente', 'equipo'], required: true },
        autorNombre: String,
        texto: String,
        fotos: [String],
        fecha: { type: Date, default: Date.now }
    }, { _id: false });

    const TicketSchema = new mongoose.Schema({
        folio: { type: String, unique: true },
        clienteId: { type: String, index: true },
        clienteNombre: String,
        empresa: String,
        asunto: String,
        categoria: { type: String, enum: CATEGORIAS },
        prioridad: { type: String, enum: PRIORIDADES, default: 'normal' },
        relacion: {
            type: new mongoose.Schema({ tipo: String, id: String, folio: String }, { _id: false }),
            default: undefined
        },
        estado: { type: String, enum: ESTADOS, default: 'abierto', index: true },
        mensajes: [MensajeSchema],
        asignadoA: String,
        noLeidoCliente: { type: Number, default: 0 },
        noLeidoEquipo: { type: Number, default: 0 }
    }, { timestamps: true });

    const CRMTicketSoporte = mongoose.models.CRMTicketSoporte || mongoose.model('CRMTicketSoporte', TicketSchema);
    const contadores = () => mongoose.connection.collection('crmcontadores');

    async function siguienteFolio() {
        const r = await contadores().findOneAndUpdate(
            { _id: 'ticketSoporte' },
            { $inc: { valor: 1 } },
            { upsert: true, returnDocument: 'after' }
        );
        const doc = r && r.value !== undefined ? r.value : r; // driver 4/5 vs 6
        return 'TS-' + String(doc.valor).padStart(4, '0');
    }

    async function guardarFotos(fotos) {
        const rutas = [];
        for (const f of fotos) {
            const a = await CRMArchivo.create({
                nombre: f.nombre,
                contentType: f.contentType,
                datos: f.buffer.toString('base64'),
                tamanio: f.buffer.length
            });
            rutas.push(`/api/archivos/${a._id}`);
        }
        return rutas;
    }

    function ultimoMensaje(t) {
        const m = (t.mensajes || [])[t.mensajes.length - 1];
        return m ? { autorTipo: m.autorTipo, autorNombre: m.autorNombre, texto: String(m.texto || '').slice(0, 160), fecha: m.fecha } : null;
    }

    function resumenLista(t) {
        return {
            _id: String(t._id), folio: t.folio, asunto: t.asunto, categoria: t.categoria, prioridad: t.prioridad,
            estado: t.estado, relacion: t.relacion, clienteNombre: t.clienteNombre, empresa: t.empresa,
            asignadoA: t.asignadoA, noLeidoCliente: t.noLeidoCliente, noLeidoEquipo: t.noLeidoEquipo,
            createdAt: t.createdAt, updatedAt: t.updatedAt, ultimoMensaje: ultimoMensaje(t)
        };
    }

    function completo(t) {
        const o = typeof t.toObject === 'function' ? t.toObject() : t;
        return { ...o, _id: String(o._id) };
    }

    // Un cliente sólo ve los suyos; la cuenta de administración del portal ve todos.
    async function buscarDelCliente(req) {
        const id = String(req.params.id || '');
        if (!mongoose.Types.ObjectId.isValid(id)) return null;
        const filtro = { _id: id };
        if (!req.cliente.isAdmin) filtro.clienteId = String(req.cliente._id);
        return CRMTicketSoporte.findOne(filtro);
    }

    /* ── Cliente ─────────────────────────────────────────────────────────── */

    app.get('/api/clientes/tickets', authCliente, async (req, res) => {
        try {
            const filtro = req.cliente.isAdmin ? {} : { clienteId: String(req.cliente._id) };
            const lista = await CRMTicketSoporte.find(filtro).sort({ updatedAt: -1 }).limit(300).lean();
            res.json(lista.map(resumenLista));
        } catch (e) { responderError(res, e); }
    });

    app.get('/api/clientes/tickets/:id', authCliente, async (req, res) => {
        try {
            const t = await buscarDelCliente(req);
            if (!t) throw httpErr(404, 'Ticket no encontrado');
            if (t.noLeidoCliente) {
                t.noLeidoCliente = 0;
                await t.save({ timestamps: false });
            }
            res.json(completo(t));
        } catch (e) { responderError(res, e); }
    });

    app.post('/api/clientes/tickets', authCliente, async (req, res) => {
        try {
            const b = req.body || {};
            const asunto = textoValido(b.asunto, 3, 150, 'El asunto');
            const texto = textoValido(b.texto, 1, 5000, 'La descripción');
            if (!CATEGORIAS.includes(b.categoria)) throw httpErr(400, 'Categoría inválida');
            const prioridad = b.prioridad === undefined ? 'normal' : b.prioridad;
            if (!PRIORIDADES.includes(prioridad)) throw httpErr(400, 'Prioridad inválida');
            const relacion = validarRelacion(b.relacion);
            const fotos = validarFotos(b.fotos);

            const rutas = await guardarFotos(fotos);
            const t = await CRMTicketSoporte.create({
                folio: await siguienteFolio(),
                clienteId: String(req.cliente._id),
                clienteNombre: req.cliente.nombre,
                empresa: req.cliente.empresa,
                asunto, categoria: b.categoria, prioridad, relacion,
                estado: 'abierto',
                mensajes: [{ autorTipo: 'cliente', autorNombre: req.cliente.nombre, texto, fotos: rutas }],
                noLeidoEquipo: 1
            });
            avisar({ tipo: 'ticket_nuevo', ticket: t, cliente: req.cliente });
            res.status(201).json(completo(t));
        } catch (e) { responderError(res, e); }
    });

    app.post('/api/clientes/tickets/:id/mensajes', authCliente, async (req, res) => {
        try {
            const t = await buscarDelCliente(req);
            if (!t) throw httpErr(404, 'Ticket no encontrado');
            if (t.estado === 'cerrado') throw httpErr(409, 'Este ticket está cerrado. Abre uno nuevo.');
            const texto = textoValido((req.body || {}).texto, 1, 5000, 'El mensaje');
            const fotos = validarFotos((req.body || {}).fotos);
            const rutas = await guardarFotos(fotos);
            t.mensajes.push({ autorTipo: 'cliente', autorNombre: req.cliente.nombre, texto, fotos: rutas });
            if (t.estado === 'resuelto' || t.estado === 'esperando_cliente') t.estado = 'abierto';
            t.noLeidoEquipo = (t.noLeidoEquipo || 0) + 1;
            await t.save();
            avisar({ tipo: 'ticket_mensaje', ticket: t, cliente: req.cliente });
            res.status(201).json(completo(t));
        } catch (e) { responderError(res, e); }
    });

    /* ── CRM (equipo de Naisata) ─────────────────────────────────────────── */

    const CUENTA_BLOQUEADA = ['pendiente', 'rechazada', 'inactiva', 'suspendida', 'revocada'];
    const idCands = id => {
        const v = [String(id)];
        if (mongoose.Types.ObjectId.isValid(id)) v.push(new mongoose.Types.ObjectId(id));
        return v;
    };

    async function authCrm(req, res, next) {
        try {
            const userId = String(req.headers['x-crm-user-id'] || '').trim();
            const token = String(req.headers['x-crm-token'] || '').trim();
            if (!userId || !token || userId.length > 100 || token.length > 200) throw httpErr(401, 'Inicia sesión en el CRM para usar esta función.');
            const u = await mongoose.connection.collection('users').findOne(
                { _id: { $in: idCands(userId) }, tokenCrm: token },
                { projection: { nombre: 1, apellido: 1, estadoCuenta: 1, rol: 1, correo: 1 } }
            );
            if (!u || CUENTA_BLOQUEADA.includes(String(u.estadoCuenta || '').toLowerCase())) {
                throw httpErr(401, 'Tu sesión del CRM expiró. Vuelve a iniciar sesión.');
            }
            // Sólo administradores: misma regla que aplicarPermisosCrm() en proyectos.js.
            const esAdmin = /admin|socio|master/i.test(String(u.rol || '')) || String(u.correo || '').trim().toLowerCase() === 'jonathan@naisata.com';
            if (!esAdmin) throw httpErr(403, 'Sólo los administradores pueden ver los tickets de clientes.');
            req.empleado = { id: String(u._id), nombre: `${u.nombre || ''} ${u.apellido || ''}`.trim() || String(u._id) };
            next();
        } catch (e) { responderError(res, e); }
    }

    async function buscarPorId(id) {
        if (!mongoose.Types.ObjectId.isValid(String(id || ''))) return null;
        return CRMTicketSoporte.findById(String(id));
    }

    const escaparRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Búsqueda que ignora acentos: "camara" encuentra "cámara".
    function regexSinAcentos(q) {
        const grupos = { a: 'aáàä', e: 'eéèë', i: 'iíìï', o: 'oóòö', u: 'uúùü', n: 'nñ' };
        const base = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const patron = escaparRegex(base).replace(/[aeioun]/g, c => `[${grupos[c]}]`);
        return new RegExp(patron, 'i');
    }

    app.get('/api/tickets-soporte/resumen', authCrm, async (req, res) => {
        try {
            const [abiertos, noLeidos] = await Promise.all([
                CRMTicketSoporte.countDocuments({ estado: { $in: ['abierto', 'en_proceso', 'esperando_cliente'] } }),
                CRMTicketSoporte.countDocuments({ noLeidoEquipo: { $gt: 0 } })
            ]);
            res.json({ abiertos, noLeidos });
        } catch (e) { responderError(res, e); }
    });

    app.get('/api/tickets-soporte', authCrm, async (req, res) => {
        try {
            const filtro = {};
            const estado = String(req.query.estado || '');
            if (estado) {
                if (!ESTADOS.includes(estado)) throw httpErr(400, 'Estado inválido');
                filtro.estado = estado;
            }
            const q = String(req.query.q || '').trim().slice(0, 80);
            if (q) {
                const rx = regexSinAcentos(q);
                filtro.$or = [{ folio: rx }, { asunto: rx }, { clienteNombre: rx }, { empresa: rx }];
            }
            const lista = await CRMTicketSoporte.find(filtro).sort({ updatedAt: -1 }).limit(500).lean();
            res.json(lista.map(resumenLista));
        } catch (e) { responderError(res, e); }
    });

    app.get('/api/tickets-soporte/:id', authCrm, async (req, res) => {
        try {
            const t = await buscarPorId(req.params.id);
            if (!t) throw httpErr(404, 'Ticket no encontrado');
            if (t.noLeidoEquipo) {
                t.noLeidoEquipo = 0;
                await t.save({ timestamps: false });
            }
            res.json(completo(t));
        } catch (e) { responderError(res, e); }
    });

    app.post('/api/tickets-soporte/:id/mensajes', authCrm, async (req, res) => {
        try {
            const t = await buscarPorId(req.params.id);
            if (!t) throw httpErr(404, 'Ticket no encontrado');
            const texto = textoValido((req.body || {}).texto, 1, 5000, 'El mensaje');
            const fotos = validarFotos((req.body || {}).fotos);
            const rutas = await guardarFotos(fotos);
            t.mensajes.push({ autorTipo: 'equipo', autorNombre: req.empleado.nombre, texto, fotos: rutas });
            if (t.estado === 'abierto') t.estado = 'en_proceso';
            t.noLeidoCliente = (t.noLeidoCliente || 0) + 1;
            t.noLeidoEquipo = 0;
            await t.save();
            avisar({ tipo: 'ticket_respuesta', ticket: t, empleado: req.empleado });
            res.status(201).json(completo(t));
        } catch (e) { responderError(res, e); }
    });

    app.patch('/api/tickets-soporte/:id', authCrm, async (req, res) => {
        try {
            const b = req.body || {};
            if (b.estado !== undefined && !ESTADOS.includes(b.estado)) throw httpErr(400, 'Estado inválido');
            if (b.prioridad !== undefined && !PRIORIDADES.includes(b.prioridad)) throw httpErr(400, 'Prioridad inválida');
            const t = await buscarPorId(req.params.id);
            if (!t) throw httpErr(404, 'Ticket no encontrado');
            const antes = t.estado;
            if (b.estado !== undefined) t.estado = b.estado;
            if (b.prioridad !== undefined) t.prioridad = b.prioridad;
            if (b.asignadoA !== undefined) t.asignadoA = String(b.asignadoA || '').slice(0, 120);
            await t.save();
            if (t.estado !== antes) avisar({ tipo: 'ticket_estado', ticket: t, empleado: req.empleado });
            res.json(completo(t));
        } catch (e) { responderError(res, e); }
    });

    return {
        CRMTicketSoporte,
        _internos: { httpErr, responderError, textoValido, validarFotos, guardarFotos, resumenLista, completo, ESTADOS, PRIORIDADES }
    };
};
