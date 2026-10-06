/* ============================================================================
   archivos-extra-routes.js — FASE 3 (parcial): Hojas de cálculo propias del CRM
   Se registra al final de archivos-routes.js. Una "hoja" es un nodo tipo 'archivo'
   con contentType 'application/x-crm-hoja' cuyo contenido (JSON de Univer) vive en CRMArchivo.
   ========================================================================== */
const HOJA_CT = 'application/x-crm-hoja';
const MAX_BYTES = 12 * 1024 * 1024;   // base64 + límite 16 MB de documento en MongoDB
const MAX_VERSIONES = 20;             // por hoja
const INTERVALO_VERSION_MS = 5 * 60 * 1000;   // como máximo una versión automática cada 5 min

module.exports = function ({ app, mongoose, Nodo, CRMArchivo, auth, puedeLeer, puedeEditar, dto, avisar, nombreLibre, nombreValido, err }) {
    // ---------- Historial de versiones ----------
    // Cada versión guarda el contenido que se SOBRESCRIBE (así siempre se puede volver atrás).
    const Version = mongoose.models.CRMHojaVersion || mongoose.model('CRMHojaVersion', new mongoose.Schema({
        nodoId: { type: String, index: true }, fecha: Date, autor: String, datos: String, tamanio: Number, motivo: String
    }, { timestamps: { createdAt: 'creado', updatedAt: false } }));
    async function guardarVersion(nodo, arch, motivo, forzar) {
        if (!arch || !arch.datos || arch.datos === 'e30=') return;   // vacío ("{}"): nada que conservar
        if (!forzar) {
            const ult = await Version.findOne({ nodoId: nodo._id }).sort({ creado: -1 }).select('creado');
            if (ult && Date.now() - ult.creado.getTime() < INTERVALO_VERSION_MS) return;
        }
        await Version.create({ nodoId: nodo._id, fecha: nodo.modificado, autor: nodo.modificadoPorNombre || '', datos: arch.datos, tamanio: arch.tamanio, motivo: motivo || 'auto' });
        const sobran = await Version.find({ nodoId: nodo._id }).sort({ creado: -1 }).skip(MAX_VERSIONES).select('_id');
        if (sobran.length) await Version.deleteMany({ _id: { $in: sobran.map(v => v._id) } });
    }
    const hojaViva = async (id, u) => {
        const nodo = await Nodo.findById(id);
        return nodo && !nodo.eliminadoEn && nodo.contentType === HOJA_CT && puedeLeer(nodo, u) ? nodo : null;
    };

    // Listar versiones (solo quien puede editar)
    app.get('/api/archivos-crm/:id/hoja/versiones', auth, async (req, res) => {
        try {
            const nodo = await hojaViva(req.params.id, req.u.id);
            if (!nodo) return res.status(404).json({ error: 'Hoja no disponible' });
            if (!puedeEditar(nodo, req.u.id)) return res.status(403).json({ error: 'Solo quien puede editar ve el historial' });
            const vs = await Version.find({ nodoId: nodo._id }).sort({ creado: -1 }).select('fecha autor tamanio motivo creado');
            res.json({ max: MAX_VERSIONES, versiones: vs.map(v => ({ _id: v._id, fecha: v.fecha || v.creado, autor: v.autor, tamanio: v.tamanio, motivo: v.motivo })) });
        } catch (e) { err(res, e); }
    });

    // Restaurar una versión (antes se guarda la actual, así la restauración también se puede deshacer)
    app.post('/api/archivos-crm/:id/hoja/versiones/:vid/restaurar', auth, async (req, res) => {
        try {
            const nodo = await hojaViva(req.params.id, req.u.id);
            if (!nodo) return res.status(404).json({ error: 'Hoja no disponible' });
            if (!puedeEditar(nodo, req.u.id)) return res.status(403).json({ error: 'No tienes permiso de edición' });
            const v = await Version.findOne({ _id: req.params.vid, nodoId: nodo._id });
            if (!v) return res.status(404).json({ error: 'Versión no encontrada' });
            const arch = await CRMArchivo.findById(nodo.archivoId);
            if (arch) await guardarVersion(nodo, arch, 'antes de restaurar', true);
            await CRMArchivo.findByIdAndUpdate(nodo.archivoId, { datos: v.datos, tamanio: v.tamanio });
            nodo.tamanio = v.tamanio; nodo.modificadoPorNombre = req.u.nombre; nodo.modificado = new Date(); await nodo.save();
            avisar(req, { hoja: nodo._id });
            res.json({ ok: true, modificado: nodo.modificado });
        } catch (e) { err(res, e); }
    });

    // Crear hoja vacía: body { padreId, nombre }
    app.post('/api/archivos-crm/hoja', auth, async (req, res) => {
        try {
            const padreId = req.body?.padreId || null;
            let padre = null;
            if (padreId) {
                padre = await Nodo.findById(padreId);
                if (!padre || padre.eliminadoEn || padre.tipo !== 'carpeta') return res.status(404).json({ error: 'Carpeta destino no encontrada' });
                if (!puedeEditar(padre, req.u.id)) return res.status(403).json({ error: 'No tienes permiso en esta carpeta' });
            }
            let nombre = String(req.body?.nombre || 'Hoja de cálculo').trim().replace(/\.hoja$/i, '');
            if (!nombreValido(nombre)) return res.status(400).json({ error: 'Nombre no válido (no uses \\ / : * ? " < > |)' });
            const datos = Buffer.from('{}').toString('base64');
            const cont = await CRMArchivo.create({ nombre: nombre + '.hoja', contentType: HOJA_CT, datos, tamanio: 2 });
            const nodo = await Nodo.create({
                tipo: 'archivo', nombre: await nombreLibre(padreId, nombre + '.hoja'), padreId,
                propietarioId: padre ? padre.propietarioId : req.u.id, propietarioNombre: padre ? padre.propietarioNombre : req.u.nombre,
                creadoPorNombre: req.u.nombre, visibilidad: padre ? padre.visibilidad : 'privada', compartidoCon: padre ? padre.compartidoCon : [],
                archivoId: String(cont._id), contentType: HOJA_CT, tamanio: 2
            });
            avisar(req);
            res.json({ item: dto(nodo, req.u.id) });
        } catch (e) { err(res, e); }
    });

    // Leer hoja
    app.get('/api/archivos-crm/:id/hoja', auth, async (req, res) => {
        try {
            const nodo = await hojaViva(req.params.id, req.u.id);
            if (!nodo) return res.status(404).json({ error: 'Hoja no disponible' });
            const arch = await CRMArchivo.findById(nodo.archivoId);
            if (!arch) return res.status(404).json({ error: 'Contenido no encontrado' });
            let data = null;
            try { const j = JSON.parse(Buffer.from(arch.datos, 'base64').toString('utf8')); if (j && j.sheets) data = j; } catch (_) {}
            res.json({ nombre: nodo.nombre.replace(/\.hoja$/i, ''), data, modificado: nodo.modificado, editable: puedeEditar(nodo, req.u.id) });
        } catch (e) { err(res, e); }
    });

    // Guardar hoja: body { data, base } — base = "modificado" que el cliente cargó (detecta choques)
    app.put('/api/archivos-crm/:id/hoja', auth, async (req, res) => {
        try {
            const nodo = await hojaViva(req.params.id, req.u.id);
            if (!nodo) return res.status(404).json({ error: 'Hoja no disponible' });
            if (!puedeEditar(nodo, req.u.id)) return res.status(403).json({ error: 'Solo lectura: no tienes permiso de edición' });
            const { data, base } = req.body || {};
            if (!data || typeof data !== 'object' || !data.sheets) return res.status(400).json({ error: 'Contenido de hoja no válido' });
            if (base && new Date(base).getTime() !== new Date(nodo.modificado).getTime())
                return res.status(409).json({ error: 'Otra persona guardó cambios en esta hoja. Recarga para ver su versión.', modificado: nodo.modificado });
            const buf = Buffer.from(JSON.stringify(data), 'utf8');
            if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'La hoja supera el tamaño máximo (12 MB)' });
            const actual = await CRMArchivo.findById(nodo.archivoId);
            try { await guardarVersion(nodo, actual); } catch (e) { console.error('Hoja: no se pudo guardar versión', e.message); }   // nunca bloquea el guardado
            await CRMArchivo.findByIdAndUpdate(nodo.archivoId, { datos: buf.toString('base64'), tamanio: buf.length });
            nodo.tamanio = buf.length; nodo.modificadoPorNombre = req.u.nombre; nodo.modificado = new Date(); await nodo.save();
            avisar(req, { hoja: nodo._id });
            res.json({ ok: true, modificado: nodo.modificado });
        } catch (e) { err(res, e); }
    });
};
