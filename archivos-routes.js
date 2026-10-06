/* ============================================================================
   archivos-routes.js — API del módulo "Archivos" del CRM (FASE 1)
   Se registra desde server_2.js con:
       require('./archivos-routes')({ app, mongoose, upload, CRMArchivo });
   Reutiliza CRMArchivo (contenido en base64) y agrega la colección CRMNodo
   (carpetas y metadatos de archivo + visibilidad).

   IMPORTANTE: igual que el resto de la API de server_2.js, la identidad del
   usuario viene del cliente (cabecera x-user-id). Sirve para separar "privado"
   y "publicado" dentro del CRM, pero NO es seguridad fuerte hasta que exista
   autenticación con token (ver FASE_2_PENDIENTES.md).
   ========================================================================== */
module.exports = function registrarArchivosCrm({ app, mongoose, upload, CRMArchivo }) {
    const NodoSchema = new mongoose.Schema({
        _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
        tipo: { type: String, enum: ['carpeta', 'archivo'], required: true },
        nombre: { type: String, required: true, trim: true },
        padreId: { type: String, default: null, index: true },
        propietarioId: { type: String, required: true, index: true },
        propietarioNombre: String,
        visibilidad: { type: String, enum: ['privada', 'compartida', 'publica'], default: 'privada' },
        // Fase 2: compartir con usuarios específicos. Ya soportado en los permisos de abajo.
        compartidoCon: { type: [{ _id: false, userId: String, nombre: String, permiso: { type: String, default: 'lectura' } }], default: [] },
        archivoId: String,      // referencia a CRMArchivo (solo tipo 'archivo')
        contentType: String,
        tamanio: Number
    }, { timestamps: { createdAt: 'creado', updatedAt: 'modificado' } });
    const Nodo = mongoose.models.CRMNodo || mongoose.model('CRMNodo', NodoSchema);

    // ---------- Identidad y permisos ----------
    const auth = (req, res, next) => {
        const id = String(req.get('x-user-id') || req.query.uid || '').trim();
        if (!id) return res.status(401).json({ error: 'Usuario no identificado. Inicia sesión de nuevo.' });
        let nombre = '';
        try { nombre = decodeURIComponent(req.get('x-user-name') || ''); } catch (_) { /* cabecera mal codificada */ }
        req.u = { id, nombre };
        next();
    };
    const puedeLeer = (n, u) => n.propietarioId === u || n.visibilidad === 'publica' || (n.compartidoCon || []).some(c => c.userId === u);
    const puedeEditar = (n, u) => n.propietarioId === u || (n.compartidoCon || []).some(c => c.userId === u && c.permiso === 'edicion');
    const dto = (n, u) => ({
        _id: n._id, tipo: n.tipo, nombre: n.nombre, padreId: n.padreId, visibilidad: n.visibilidad,
        propietarioNombre: n.propietarioNombre, esMio: n.propietarioId === u, editable: puedeEditar(n, u),
        contentType: n.contentType, tamanio: n.tamanio, creado: n.creado, modificado: n.modificado
    });
    const err = (res, e) => res.status(500).json({ error: e.message });

    async function descendientes(id) {
        const out = []; let nivel = [id];
        while (nivel.length) {
            const hijos = await Nodo.find({ padreId: { $in: nivel } }).select('_id tipo archivoId');
            out.push(...hijos);
            nivel = hijos.filter(h => h.tipo === 'carpeta').map(h => h._id);
        }
        return out;
    }
    // Evita duplicados en la misma carpeta: "Plano.pdf" -> "Plano (2).pdf"
    async function nombreLibre(padreId, propietarioId, nombre) {
        const punto = nombre.lastIndexOf('.');
        const [base, ext] = punto > 0 ? [nombre.slice(0, punto), nombre.slice(punto)] : [nombre, ''];
        let candidato = nombre, n = 1;
        while (await Nodo.exists({ padreId, propietarioId, nombre: candidato })) candidato = `${base} (${++n})${ext}`;
        return candidato;
    }
    const nombreValido = n => typeof n === 'string' && n.trim() && n.trim().length <= 120 && !/[\\/:*?"<>|]/.test(n);

    // ---------- Listar ----------
    // vista: mios | equipo (publicado por otros) | publicados (publicado por mí)
    app.get('/api/archivos-crm', auth, async (req, res) => {
        try {
            const u = req.u.id, vista = req.query.vista || 'mios', padreId = req.query.padreId || null;
            let items = [], ruta = [];
            if (padreId) {
                const padre = await Nodo.findById(padreId);
                if (!padre || padre.tipo !== 'carpeta' || !puedeLeer(padre, u)) return res.status(404).json({ error: 'Carpeta no disponible' });
                items = (await Nodo.find({ padreId })).filter(n => puedeLeer(n, u));
                for (let c = padre; c && puedeLeer(c, u); c = c.padreId ? await Nodo.findById(c.padreId) : null) ruta.unshift({ _id: c._id, nombre: c.nombre });
            } else if (vista === 'mios') {
                items = await Nodo.find({ propietarioId: u, padreId: null });
            } else {
                const filtro = vista === 'equipo'
                    ? { visibilidad: 'publica', propietarioId: { $ne: u } }
                    : { visibilidad: 'publica', propietarioId: u };
                const todos = await Nodo.find(filtro);
                const ids = new Set(todos.map(n => n._id));
                items = todos.filter(n => !n.padreId || !ids.has(n.padreId));   // solo la "raíz" de lo publicado
            }
            items.sort((a, b) => (a.tipo === b.tipo ? a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }) : a.tipo === 'carpeta' ? -1 : 1));
            res.json({ items: items.map(n => dto(n, u)), ruta });
        } catch (e) { err(res, e); }
    });

    // ---------- Crear carpeta ----------
    app.post('/api/archivos-crm/carpetas', auth, async (req, res) => {
        try {
            const { nombre, padreId } = req.body || {};
            if (!nombreValido(nombre)) return res.status(400).json({ error: 'Nombre no válido (no uses \\ / : * ? " < > |)' });
            let padre = null;
            if (padreId) {
                padre = await Nodo.findById(padreId);
                if (!padre || padre.tipo !== 'carpeta') return res.status(404).json({ error: 'Carpeta destino no encontrada' });
                if (!puedeEditar(padre, req.u.id)) return res.status(403).json({ error: 'No tienes permiso en esta carpeta' });
            }
            if (await Nodo.exists({ padreId: padreId || null, propietarioId: req.u.id, nombre: nombre.trim() }))
                return res.status(409).json({ error: 'Ya existe un elemento con ese nombre aquí' });
            const nodo = await Nodo.create({
                tipo: 'carpeta', nombre: nombre.trim(), padreId: padreId || null,
                propietarioId: req.u.id, propietarioNombre: req.u.nombre,
                visibilidad: padre ? padre.visibilidad : 'privada',
                compartidoCon: padre ? padre.compartidoCon : []
            });
            res.json(dto(nodo, req.u.id));
        } catch (e) { err(res, e); }
    });

    // ---------- Subir archivos (hasta 10 por envío, 15 MB c/u) ----------
    const subirMw = (req, res, next) => upload.array('archivos', 10)(req, res, e =>
        e ? res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'Máximo 15 MB por archivo' : e.message }) : next());

    app.post('/api/archivos-crm/subir', auth, subirMw, async (req, res) => {
        try {
            const padreId = req.body.padreId || null;
            let padre = null;
            if (padreId) {
                padre = await Nodo.findById(padreId);
                if (!padre || padre.tipo !== 'carpeta') return res.status(404).json({ error: 'Carpeta destino no encontrada' });
                if (!puedeEditar(padre, req.u.id)) return res.status(403).json({ error: 'No tienes permiso en esta carpeta' });
            }
            const creados = [];
            for (const f of req.files || []) {
                const original = Buffer.from(f.originalname, 'latin1').toString('utf8');   // corrige acentos
                const contenido = await CRMArchivo.create({
                    nombre: original, contentType: f.mimetype, datos: f.buffer.toString('base64'), tamanio: f.size
                });
                const nodo = await Nodo.create({
                    tipo: 'archivo', nombre: await nombreLibre(padreId, req.u.id, original), padreId,
                    propietarioId: req.u.id, propietarioNombre: req.u.nombre,
                    visibilidad: padre ? padre.visibilidad : 'privada', compartidoCon: padre ? padre.compartidoCon : [],
                    archivoId: String(contenido._id), contentType: f.mimetype, tamanio: f.size
                });
                creados.push(dto(nodo, req.u.id));
            }
            res.json({ items: creados });
        } catch (e) { err(res, e); }
    });

    // ---------- Renombrar / cambiar visibilidad (solo el propietario) ----------
    app.put('/api/archivos-crm/:id', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo) return res.status(404).json({ error: 'No encontrado' });
            if (nodo.propietarioId !== req.u.id) return res.status(403).json({ error: 'Solo el propietario puede modificarlo' });
            const { nombre, visibilidad } = req.body || {};
            if (nombre !== undefined) {
                if (!nombreValido(nombre)) return res.status(400).json({ error: 'Nombre no válido (no uses \\ / : * ? " < > |)' });
                const dup = await Nodo.exists({ _id: { $ne: nodo._id }, padreId: nodo.padreId, propietarioId: nodo.propietarioId, nombre: nombre.trim() });
                if (dup) return res.status(409).json({ error: 'Ya existe un elemento con ese nombre aquí' });
                nodo.nombre = nombre.trim();
            }
            if (visibilidad !== undefined) {
                if (!['privada', 'publica'].includes(visibilidad)) return res.status(400).json({ error: 'Visibilidad no válida' });
                nodo.visibilidad = visibilidad;
                if (nodo.tipo === 'carpeta') {   // el contenido hereda la visibilidad de la carpeta
                    const ids = (await descendientes(nodo._id)).map(d => d._id);
                    await Nodo.updateMany({ _id: { $in: ids } }, { $set: { visibilidad } });
                }
            }
            await nodo.save();
            res.json(dto(nodo, req.u.id));
        } catch (e) { err(res, e); }
    });

    // ---------- Eliminar (carpeta incluye su contenido) ----------
    app.delete('/api/archivos-crm/:id', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo) return res.status(404).json({ error: 'No encontrado' });
            if (nodo.propietarioId !== req.u.id) return res.status(403).json({ error: 'Solo el propietario puede eliminarlo' });
            const todos = [nodo, ...(await descendientes(nodo._id))];
            const archivoIds = todos.map(n => n.archivoId).filter(Boolean);
            if (archivoIds.length) await CRMArchivo.deleteMany({ _id: { $in: archivoIds } });
            await Nodo.deleteMany({ _id: { $in: todos.map(n => n._id) } });
            res.json({ ok: true, eliminados: todos.length });
        } catch (e) { err(res, e); }
    });

    // ---------- Abrir / descargar ----------
    app.get('/api/archivos-crm/:id/archivo', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo || nodo.tipo !== 'archivo' || !puedeLeer(nodo, req.u.id)) return res.status(404).json({ error: 'Archivo no disponible' });
            const arch = await CRMArchivo.findById(nodo.archivoId);
            if (!arch) return res.status(404).json({ error: 'Contenido no encontrado' });
            res.set('Content-Type', arch.contentType || 'application/octet-stream');
            res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nodo.nombre)}`);
            res.send(Buffer.from(arch.datos, 'base64'));
        } catch (e) { err(res, e); }
    });
};
