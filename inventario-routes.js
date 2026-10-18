/* ─── INVENTARIO DE RED (portal de clientes) ───────────────────────────────
   Módulo independiente, mismo patrón que archivos-routes.js.
   Se carga desde server_2.js con:
       require('./inventario-routes')({ app, mongoose, authCliente });

   Modelo: UN documento por cuenta/empresa (CRMInventario) con sucursales,
   sites, equipos (switch / patch panel / NVR) y puntos de red.
   Acceso (igual que los proyectos): accesosPortal = clientes que pueden VER,
   editoresPortal = clientes que pueden EDITAR. Los admins de Naisata
   (req.cliente.isAdmin) ven y editan todo.
   TODAS las rutas exigen authCliente: el inventario trae IPs y MACs.
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const LIM = { sucursales: 200, sites: 500, equipos: 2000, puntos: 20000 };
const TIPOS_EQ = ['switch', 'patch', 'nvr'];
const ESTADOS = ['activo', 'falla', 'libre', 'retirado'];
const MAX_PROPIOS = 10;   // inventarios que un cliente (no admin) puede crear por su cuenta

/* ── Sanitización (funciones puras, sin dependencias) ───────────────────── */
const str = (v, max = 120) => (v == null ? '' : String(v)).trim().slice(0, max);
const num = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 && n < 100000 ? n : null; };
const idOk = v => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
const refId = v => (v == null || v === '' ? '' : idOk(v) ? v : '');

function sanitizarInventario(body) {
    const err = m => { const e = new Error(m); e.status = 400; throw e; };
    const arr = (k) => {
        const a = body[k];
        if (!Array.isArray(a)) err(`"${k}" debe ser una lista`);
        if (a.length > LIM[k]) err(`Demasiados registros en "${k}" (máx. ${LIM[k]})`);
        const ids = new Set();
        a.forEach(x => {
            if (!x || !idOk(x.id)) err(`Registro inválido en "${k}"`);
            if (ids.has(x.id)) err(`ID repetido en "${k}": ${x.id}`);
            ids.add(x.id);
        });
        return a;
    };
    const sucursales = arr('sucursales').map(s => ({ id: s.id, nombre: str(s.nombre) || 'Sin nombre', clave: str(s.clave, 30), direccion: str(s.direccion, 200) }));
    const sucIds = new Set(sucursales.map(s => s.id));

    const sites = arr('sites').map(t => {
        if (!sucIds.has(t.sucursalId)) err(`El site "${str(t.nombre)}" apunta a una sucursal que no existe`);
        return { id: t.id, sucursalId: t.sucursalId, tipo: t.tipo === 'IDF' ? 'IDF' : 'MDF', nombre: str(t.nombre) || 'Sin nombre', ubicacion: str(t.ubicacion, 200) };
    });
    const siteIds = new Set(sites.map(t => t.id));

    const equipos = arr('equipos').map(e => {
        if (!siteIds.has(e.siteId)) err(`El equipo "${str(e.nombre)}" apunta a un site que no existe`);
        const puertos = num(e.puertos);
        if (!TIPOS_EQ.includes(e.tipo)) err(`Tipo de equipo inválido: ${str(e.tipo, 20)}`);
        if (!puertos || puertos > 96) err(`Cantidad de puertos inválida en "${str(e.nombre)}"`);
        return { id: e.id, siteId: e.siteId, tipo: e.tipo, nombre: str(e.nombre) || 'Sin nombre', modelo: str(e.modelo), ip: str(e.ip, 45), puertos, rack: str(e.rack, 60) };
    });

    const puntos = arr('puntos').map(p => {
        if (!sucIds.has(p.sucursalId) || !siteIds.has(p.siteId)) err(`El punto "${str(p.nombre)}" apunta a una sucursal o site que no existe`);
        return {
            id: p.id, nombre: str(p.nombre) || 'Sin nombre', tipo: str(p.tipo, 40) || 'Otro',
            sucursalId: p.sucursalId, siteId: p.siteId,
            patchId: refId(p.patchId), patchPuerto: num(p.patchPuerto),
            switchId: refId(p.switchId), swPuerto: num(p.swPuerto),
            nvrId: refId(p.nvrId), nvrCanal: num(p.nvrCanal),
            vlan: num(p.vlan), ip: str(p.ip, 45), mac: str(p.mac, 30), ubicacion: str(p.ubicacion, 200),
            estado: ESTADOS.includes(p.estado) ? p.estado : 'activo', proyecto: str(p.proyecto, 60), fecha: str(p.fecha, 10),
            entregableId: refId(p.entregableId)
        };
    });
    return { sucursales, sites, equipos, puntos };
}

function sanitizarBranding(b) {
    b = b || {};
    const out = { nombre: str(b.nombre, 80), color: /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '' };
    if (b.logo) {
        if (!/^data:image\/(png|jpe?g|webp|svg\+xml|gif);base64,[A-Za-z0-9+/=]+$/.test(b.logo) || b.logo.length > 450000) {
            const e = new Error('Logo inválido o mayor a 300 KB'); e.status = 400; throw e;
        }
        out.logo = b.logo;
    } else out.logo = '';
    return out;
}

/* ── Rutas ──────────────────────────────────────────────────────────────── */
module.exports = function ({ app, mongoose, authCliente }) {
    const S = mongoose.Schema;
    const CRMInventario = mongoose.models.CRMInventario || mongoose.model('CRMInventario', new S({
        _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
        nombre: { type: String, required: true, trim: true },
        siteId: { type: String, index: true },   // cliente (colección "sites" del CRM) al que pertenece este inventario
        accesosPortal: [String],   // clientes con acceso de lectura
        editoresPortal: [String],  // clientes que además pueden editar
        branding: { nombre: String, color: String, logo: String },
        sucursales: [{ _id: false, id: String, nombre: String, clave: String, direccion: String }],
        sites: [{ _id: false, id: String, sucursalId: String, tipo: String, nombre: String, ubicacion: String }],
        equipos: [{ _id: false, id: String, siteId: String, tipo: String, nombre: String, modelo: String, ip: String, puertos: Number, rack: String }],
        puntos: [{
            _id: false, id: String, nombre: String, tipo: String, sucursalId: String, siteId: String,
            patchId: String, patchPuerto: Number, switchId: String, swPuerto: Number, nvrId: String, nvrCanal: Number,
            vlan: Number, ip: String, mac: String, ubicacion: String, estado: String, proyecto: String, fecha: String,
            entregableId: String   // entregable (ticket) del que salió este punto
        }],
        version: { type: Number, default: 1 },
        creadoPor: String,
        actualizadoPor: String,
        actualizadoEn: Date,
        creadoEn: { type: Date, default: Date.now }
    }));

    const miId = req => String(req.cliente._id);
    const permisos = (inv, req) => {
        const id = miId(req);
        const edit = !!req.cliente.isAdmin || (inv.editoresPortal || []).includes(id);
        return { ver: edit || (inv.accesosPortal || []).includes(id), editar: edit };
    };
    const soloAdmin = (req, res) => { if (!req.cliente.isAdmin) { res.status(403).json({ error: 'Solo el equipo de Naisata puede hacer esto' }); return false; } return true; };
    const falla = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Error en el inventario' });

    // Lista de inventarios a los que tengo acceso
    app.get('/api/clientes/inventarios', authCliente, async (req, res) => {
        try {
            const q = req.cliente.isAdmin ? {} : { $or: [{ accesosPortal: miId(req) }, { editoresPortal: miId(req) }] };
            const lista = await CRMInventario.find(q).select('nombre').sort({ nombre: 1 }).lean();
            res.json({ isAdmin: !!req.cliente.isAdmin, inventarios: lista.map(i => ({ _id: i._id, nombre: i.nombre })) });
        } catch (e) { falla(res, e); }
    });

    // Inventario completo
    app.get('/api/clientes/inventario/:id', authCliente, async (req, res) => {
        try {
            const inv = await CRMInventario.findById(req.params.id).lean();
            if (!inv) return res.status(404).json({ error: 'Inventario no encontrado' });
            const p = permisos(inv, req);
            if (!p.ver) return res.status(403).json({ error: 'No tienes acceso a este inventario' });
            const out = {
                _id: inv._id, nombre: inv.nombre, version: inv.version, canEdit: p.editar, branding: inv.branding || {},
                sucursales: inv.sucursales, sites: inv.sites, equipos: inv.equipos, puntos: inv.puntos,
                actualizadoEn: inv.actualizadoEn
            };
            if (req.cliente.isAdmin) { out.accesosPortal = inv.accesosPortal; out.editoresPortal = inv.editoresPortal; }
            res.json(out);
        } catch (e) { falla(res, e); }
    });

    // Guardar (control de versión: evita que dos personas se pisen)
    app.put('/api/clientes/inventario/:id', authCliente, async (req, res) => {
        try {
            const inv = await CRMInventario.findById(req.params.id).select('accesosPortal editoresPortal version').lean();
            if (!inv) return res.status(404).json({ error: 'Inventario no encontrado' });
            if (!permisos(inv, req).editar) return res.status(403).json({ error: 'No tienes permiso para editar este inventario' });
            const datos = sanitizarInventario(req.body || {});
            const base = Number(req.body.baseVersion);
            const nuevo = await CRMInventario.findOneAndUpdate(
                { _id: req.params.id, version: base },
                { $set: { ...datos, actualizadoPor: req.cliente.nombre || miId(req), actualizadoEn: new Date() }, $inc: { version: 1 } },
                { new: true }
            ).select('version').lean();
            if (!nuevo) return res.status(409).json({ error: 'Otra persona modificó el inventario. Se recargó la versión más reciente.', conflicto: true });
            res.json({ version: nuevo.version });
        } catch (e) { falla(res, e); }
    });

    // Marca del cliente (nombre, color, logo)
    app.put('/api/clientes/inventario/:id/branding', authCliente, async (req, res) => {
        try {
            const inv = await CRMInventario.findById(req.params.id).select('accesosPortal editoresPortal').lean();
            if (!inv) return res.status(404).json({ error: 'Inventario no encontrado' });
            if (!permisos(inv, req).editar) return res.status(403).json({ error: 'No tienes permiso para personalizar este portal' });
            const branding = sanitizarBranding(req.body);
            await CRMInventario.updateOne({ _id: req.params.id }, { $set: { branding } });
            res.json({ branding });
        } catch (e) { falla(res, e); }
    });

    // ── Administración (solo Naisata) ──────────────────────────────────────
    // Crear un inventario: NO depende de proyectos. Cualquier cliente aprobado puede crear el suyo
    // (queda como editor); el admin de Naisata puede crear los que quiera y asignarlos después.
    app.post('/api/clientes/inventarios', authCliente, async (req, res) => {
        try {
            const nombre = str(req.body && req.body.nombre, 100);
            if (!nombre) return res.status(400).json({ error: 'Escribe el nombre de la empresa' });
            const admin = !!req.cliente.isAdmin;
            if (!admin) {
                const propios = await CRMInventario.countDocuments({ creadoPor: miId(req) });
                if (propios >= MAX_PROPIOS) return res.status(400).json({ error: `Ya creaste ${MAX_PROPIOS} inventarios. Pide a Naisata si necesitas más.` });
            }
            const inv = await CRMInventario.create({ nombre, creadoPor: miId(req), editoresPortal: admin ? [] : [miId(req)], sucursales: [], sites: [], equipos: [], puntos: [] });
            res.json({ _id: inv._id, nombre: inv.nombre });
        } catch (e) { falla(res, e); }
    });

    app.get('/api/clientes/admin/clientes', authCliente, async (req, res) => {
        try {
            if (!soloAdmin(req, res)) return;
            const lista = await mongoose.models.CRMClientePortal.find({ aprobado: true }).select('nombre empresa correo').sort({ empresa: 1, nombre: 1 }).lean();
            res.json(lista.map(c => ({ _id: c._id, nombre: c.nombre, empresa: c.empresa || '', correo: c.correo })));
        } catch (e) { falla(res, e); }
    });

    app.put('/api/clientes/inventarios/:id/accesos', authCliente, async (req, res) => {
        try {
            if (!soloAdmin(req, res)) return;
            const limpio = v => [...new Set((Array.isArray(v) ? v : []).map(String))].slice(0, 200);
            const editar = limpio(req.body.editar);
            const ver = limpio(req.body.ver).filter(id => !editar.includes(id));
            const validos = new Set((await mongoose.models.CRMClientePortal.find({ _id: { $in: [...ver, ...editar] }, aprobado: true }).select('_id').lean()).map(c => String(c._id)));
            const r = await CRMInventario.updateOne({ _id: req.params.id }, { $set: { accesosPortal: ver.filter(i => validos.has(i)), editoresPortal: editar.filter(i => validos.has(i)) } });
            if (!r.matchedCount) return res.status(404).json({ error: 'Inventario no encontrado' });
            res.json({ message: 'Accesos actualizados' });
        } catch (e) { falla(res, e); }
    });

    // Entregables → inventario (Gemini, "Asignarle site") y vista de entregables del portal.
    // Si este módulo falla, el inventario sigue funcionando.
    try {
        require('./entregables-inventario-routes')({ app, mongoose, authCliente, CRMInventario, sanitizarInventario, str, num });
    } catch (e) {
        process.stderr.write('[Entregables-Inventario] Modulo no cargado: ' + (e && e.message) + '\n');
    }
};

module.exports.sanitizarInventario = sanitizarInventario;
module.exports.sanitizarBranding = sanitizarBranding;
