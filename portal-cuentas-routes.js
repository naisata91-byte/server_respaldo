/* ─── PORTAL DE CLIENTES → CUENTAS, MEMBRESÍAS Y PERMISOS ──────────────────
   Módulo independiente (mismo patrón que inventario-routes.js). server_2.js lo
   carga dentro de un try/catch: si este archivo falla, el portal sigue igual
   que antes.

   Idea: una cuenta del portal (CRMClientePortal) puede ser MIEMBRO de uno o
   varios clientes registrados (colección "sites": Gelpharma, etc.) y en cada
   uno tiene un rol + permisos por módulo. Varias cuentas pueden pertenecer al
   mismo cliente con permisos distintos.

   Colección nueva: portal_membresias
     { _id, cuentaId, siteId, rol, permisos:{cotizaciones,entregables,inventario,proyectos}, creadoPor, creadoEn, actualizadoEn }

   Niveles: 'ninguno' < 'ver' < 'editar'
     cotizaciones: ninguno / ver / editar (editar = puede crear copia modificada)
     entregables:  ninguno / ver
     inventario:   ninguno / ver / editar
     proyectos:    ninguno / ver

   Cuentas SIN membresías se comportan exactamente como antes (compatibilidad).
   Cuentas CON membresías: el acceso sale de sus membresías + los accesos
   explícitos que ya existían (accesosPortal). Dejan de aplicar las
   coincidencias por texto (empresa/contacto) en cotizaciones.

   Rutas admin (empleado admin/socio; cabeceras x-crm-user-id + x-crm-token, o
   x-cliente-token de un admin del portal):
     GET    /api/admin/portal-cuentas
     PUT    /api/admin/portal-cuentas/:cuentaId/membresia      { siteId, rol, permisos, aprobar? }
     DELETE /api/admin/portal-cuentas/:cuentaId/membresia/:siteId
   Ruta del cliente:
     GET    /api/clientes/mi-cuenta
   Helper para otros módulos: app.locals.portalCuentas
   ─────────────────────────────────────────────────────────────────────── */
'use strict';

const NIVELES = { ninguno: 0, ver: 1, editar: 2 };
const NOMBRES_NIVEL = ['ninguno', 'ver', 'editar'];
const MODULOS = {
    cotizaciones: { nombre: 'Cotizaciones', max: 2 },
    entregables: { nombre: 'Entregables', max: 1 },
    inventario: { nombre: 'Inventario de red', max: 2 },
    proyectos: { nombre: 'Proyectos', max: 1 }
};
const ROLES = {
    administrador: { nombre: 'Administrador de cuenta', permisos: { cotizaciones: 'editar', entregables: 'ver', inventario: 'editar', proyectos: 'ver' } },
    tecnico: { nombre: 'Técnico / operación', permisos: { cotizaciones: 'ninguno', entregables: 'ver', inventario: 'editar', proyectos: 'ver' } },
    lectura: { nombre: 'Solo lectura', permisos: { cotizaciones: 'ver', entregables: 'ver', inventario: 'ver', proyectos: 'ver' } },
    personalizado: { nombre: 'Personalizado', permisos: { cotizaciones: 'ninguno', entregables: 'ninguno', inventario: 'ninguno', proyectos: 'ninguno' } }
};

/* Deja los permisos completos y dentro de lo que cada módulo admite. */
function limpiarPermisos(entrada, base) {
    const out = {};
    Object.keys(MODULOS).forEach(m => {
        let n = NIVELES[String(entrada && entrada[m] !== undefined ? entrada[m] : (base && base[m]) || 'ninguno').toLowerCase()];
        if (n === undefined) n = 0;
        out[m] = NOMBRES_NIVEL[Math.min(n, MODULOS[m].max)];
    });
    return out;
}

module.exports = function ({ app, mongoose, authCliente }) {
    const db = () => mongoose.connection.db;
    const idCands = id => { const v = [String(id)]; if (mongoose.Types.ObjectId.isValid(id)) v.push(new mongoose.Types.ObjectId(id)); return v; };
    const idFilter = id => ({ _id: { $in: idCands(id) } });
    let indexado = false;
    const col = () => {
        const c = db().collection('portal_membresias');
        if (!indexado) { indexado = true; c.createIndex({ cuentaId: 1, siteId: 1 }, { unique: true }).catch(() => { indexado = false; }); c.createIndex({ siteId: 1 }).catch(() => {}); }
        return c;
    };
    const falla = (res, e) => {
        if (!e.status) { try { console.error('[PortalCuentas]', e); } catch (_) { /* sin log */ } }
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Error en las cuentas del portal' });
    };
    const err = (status, message) => Object.assign(new Error(message), { status });

    /* ── Lectura de membresías (con memo por petición) ───────────────────── */
    const memo = new WeakMap();
    async function membresias(cliente) {
        if (!cliente || cliente.isAdmin || !cliente._id) return [];
        if (memo.has(cliente)) return memo.get(cliente);
        const p = col().find({ cuentaId: String(cliente._id) }).toArray().catch(() => []);
        memo.set(cliente, p);
        return p;
    }
    /* siteIds donde la cuenta tiene al menos `minimo` en `modulo`. */
    async function sitesCon(cliente, modulo, minimo) {
        const min = NIVELES[minimo || 'ver'];
        return (await membresias(cliente)).filter(m => (NIVELES[(m.permisos || {})[modulo]] || 0) >= min).map(m => String(m.siteId));
    }
    async function nivel(cliente, modulo, siteId) {
        const m = (await membresias(cliente)).find(x => String(x.siteId) === String(siteId));
        return m ? (NIVELES[(m.permisos || {})[modulo]] || 0) : 0;
    }
    async function tieneMembresias(cliente) { return (await membresias(cliente)).length > 0; }

    /* ── Ganchos usados por server_2.js ──────────────────────────────────── */
    async function ajustarQueryCotizaciones(cliente, query) {
        if (cliente.isAdmin || !(await tieneMembresias(cliente))) return query;
        const sites = await sitesCon(cliente, 'cotizaciones', 'ver');
        const or = [{ accesosPortal: String(cliente._id) }];
        if (sites.length) or.push({ clienteId: { $in: sites }, estado: { $nin: ['Neutral'] } });
        return { $or: or };
    }
    async function cotizacion(cliente, cot, esSuyaLegacy) {
        if (cliente.isAdmin) return { ver: true, editar: false };
        if (!(await tieneMembresias(cliente))) return { ver: !!esSuyaLegacy, editar: false };
        const explicito = !!(cot.accesosPortal && cot.accesosPortal.includes(String(cliente._id)));
        const n = cot.estado === 'Neutral' ? 0 : await nivel(cliente, 'cotizaciones', cot.clienteId);
        return { ver: explicito || n >= 1, editar: n >= 2 };
    }
    async function queryProyectos(cliente) {
        const base = { accesosPortal: String(cliente._id) };
        const sites = await sitesCon(cliente, 'proyectos', 'ver');
        return sites.length ? { $or: [base, { clienteId: { $in: sites } }] } : base;
    }
    async function verProyecto(cliente, proyecto) {
        return (await nivel(cliente, 'proyectos', proyecto.clienteId)) >= 1;
    }

    /* ── Autenticación de administradores ────────────────────────────────── */
    async function authAdmin(req, res, next) {
        try {
            const uid = String(req.headers['x-crm-user-id'] || '').trim();
            const tk = String(req.headers['x-crm-token'] || '').trim();
            const ct = String(req.headers['x-cliente-token'] || '').trim();
            let u = null;
            if (uid && tk && uid.length <= 100 && tk.length <= 200) u = await db().collection('users').findOne({ _id: { $in: idCands(uid) }, tokenCrm: tk });
            else if (ct && ct.length <= 200) u = await db().collection('users').findOne({ tokenPortal: ct });
            if (!u) throw err(401, 'Inicia sesión como administrador.');
            if (['pendiente', 'rechazada', 'inactiva', 'suspendida', 'revocada'].includes(String(u.estadoCuenta || '').toLowerCase())) throw err(401, 'Tu cuenta no tiene acceso.');
            const esAdmin = /admin|socio|master/i.test(String(u.rol || '')) || String(u.correo || '').toLowerCase() === 'jonathan@naisata.com';
            if (!esAdmin) throw err(403, 'Solo administradores pueden gestionar las cuentas del portal.');
            req.adminPortal = { id: String(u._id), nombre: `${u.nombre || ''} ${u.apellido || ''}`.trim() };
            next();
        } catch (e) { falla(res, e); }
    }

    const nombreSite = async siteId => {
        const s = await db().collection('sites').findOne(idFilter(siteId), { projection: { nombre: 1 } });
        return s ? String(s.nombre || '') : null;
    };

    /* ── Admin: listado ──────────────────────────────────────────────────── */
    app.get('/api/admin/portal-cuentas', authAdmin, async (req, res) => {
        try {
            const Cuenta = mongoose.models.CRMClientePortal;
            const [cuentas, membs, sites] = await Promise.all([
                Cuenta.find().select('-passwordHash -token').sort({ fechaRegistro: -1 }).lean(),
                col().find({}).toArray(),
                db().collection('sites').find({}, { projection: { nombre: 1 } }).sort({ nombre: 1 }).toArray()
            ]);
            const nombres = new Map(sites.map(s => [String(s._id), String(s.nombre || '')]));
            const porCuenta = new Map();
            membs.forEach(m => {
                const l = porCuenta.get(m.cuentaId) || [];
                l.push({ siteId: m.siteId, siteNombre: nombres.get(String(m.siteId)) || '(cliente eliminado)', rol: m.rol, permisos: m.permisos });
                porCuenta.set(m.cuentaId, l);
            });
            res.json({
                cuentas: cuentas.map(c => ({
                    _id: c._id, nombre: c.nombre, correo: c.correo, telefono: c.telefono || '', empresa: c.empresa || '',
                    aprobado: !!c.aprobado, fechaRegistro: c.fechaRegistro, membresias: porCuenta.get(String(c._id)) || []
                })),
                sites: sites.map(s => ({ id: String(s._id), nombre: String(s.nombre || '') })),
                roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { nombre: v.nombre, permisos: v.permisos }])),
                modulos: Object.fromEntries(Object.entries(MODULOS).map(([k, v]) => [k, { nombre: v.nombre, max: v.max }]))
            });
        } catch (e) { falla(res, e); }
    });

    /* ── Admin: asignar / actualizar membresía (opcionalmente aprueba la cuenta) ── */
    app.put('/api/admin/portal-cuentas/:cuentaId/membresia', authAdmin, async (req, res) => {
        try {
            const Cuenta = mongoose.models.CRMClientePortal;
            const cuentaId = String(req.params.cuentaId);
            const cuenta = await Cuenta.findById(cuentaId).select('_id').lean();
            if (!cuenta) throw err(404, 'Cuenta no encontrada');
            const siteId = String((req.body && req.body.siteId) || '').trim();
            if (!siteId || siteId.length > 60) throw err(400, 'Elige el cliente.');
            if ((await nombreSite(siteId)) === null) throw err(404, 'Cliente no encontrado');
            const rol = ROLES[req.body.rol] ? req.body.rol : 'personalizado';
            const permisos = rol === 'personalizado' || req.body.permisos
                ? limpiarPermisos(req.body.permisos, ROLES[rol].permisos)
                : limpiarPermisos(ROLES[rol].permisos);
            const ahora = new Date();
            await col().updateOne(
                { cuentaId, siteId },
                { $set: { rol, permisos, actualizadoEn: ahora, actualizadoPor: req.adminPortal.nombre || req.adminPortal.id }, $setOnInsert: { creadoEn: ahora, creadoPor: req.adminPortal.nombre || req.adminPortal.id } },
                { upsert: true }
            );
            if (req.body.aprobar === true) await Cuenta.updateOne({ _id: cuentaId }, { $set: { aprobado: true } });
            res.json({ message: 'Acceso guardado', rol, permisos });
        } catch (e) { falla(res, e); }
    });

    app.delete('/api/admin/portal-cuentas/:cuentaId/membresia/:siteId', authAdmin, async (req, res) => {
        try {
            const r = await col().deleteOne({ cuentaId: String(req.params.cuentaId), siteId: String(req.params.siteId) });
            if (!r.deletedCount) throw err(404, 'Esa cuenta no pertenece a ese cliente');
            res.json({ message: 'Acceso retirado' });
        } catch (e) { falla(res, e); }
    });

    /* ── Cliente: mi pertenencia y qué módulos ve ────────────────────────── */
    app.get('/api/clientes/mi-cuenta', authCliente, async (req, res) => {
        try {
            const c = req.cliente;
            const todos = Object.fromEntries(Object.keys(MODULOS).map(m => [m, true]));
            if (c.isAdmin) return res.json({ isAdmin: true, asociada: true, clientes: [], modulos: todos });
            const membs = await membresias(c);
            if (!membs.length) return res.json({ isAdmin: false, asociada: false, legado: true, clientes: [], modulos: todos });

            const yo = String(c._id);
            const M = mongoose.models;
            const cuenta = async (modelo, filtro) => (M[modelo] ? M[modelo].countDocuments(filtro).catch(() => 0) : 0);
            const [cot, proy, inv] = await Promise.all([
                cuenta('CRMCotizacion', { accesosPortal: yo }),
                cuenta('CRMProyecto', { accesosPortal: yo }),
                cuenta('CRMInventario', { $or: [{ accesosPortal: yo }, { editoresPortal: yo }] })
            ]);
            const alguno = m => membs.some(x => (NIVELES[(x.permisos || {})[m]] || 0) >= 1);
            const nombres = new Map((await db().collection('sites').find({ _id: { $in: membs.flatMap(m => idCands(m.siteId)) } }, { projection: { nombre: 1 } }).toArray()).map(s => [String(s._id), String(s.nombre || '')]));
            res.json({
                isAdmin: false, asociada: true,
                clientes: membs.map(m => ({ siteId: m.siteId, nombre: nombres.get(String(m.siteId)) || '', rol: m.rol, rolNombre: (ROLES[m.rol] || {}).nombre || '', permisos: m.permisos })),
                modulos: {
                    cotizaciones: alguno('cotizaciones') || cot > 0,
                    entregables: alguno('entregables') || proy > 0 || inv > 0,
                    inventario: alguno('inventario') || inv > 0,
                    proyectos: alguno('proyectos') || proy > 0
                }
            });
        } catch (e) { falla(res, e); }
    });

    app.locals.portalCuentas = { membresias, sitesCon, nivel, tieneMembresias, ajustarQueryCotizaciones, cotizacion, queryProyectos, verProyecto, ROLES, MODULOS };
};

module.exports.limpiarPermisos = limpiarPermisos;
module.exports.ROLES = ROLES;
module.exports.MODULOS = MODULOS;
