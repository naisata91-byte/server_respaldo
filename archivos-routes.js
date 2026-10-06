/* ============================================================================
   archivos-routes.js — API del módulo "Archivos" del CRM (FASE 2)
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
        creadoPorNombre: String,
        archivoId: String,      // referencia a CRMArchivo (solo tipo 'archivo')
        contentType: String,
        tamanio: Number,
        modificadoPorNombre: String,
        // Papelera (borrado lógico): eliminadoRaiz marca solo el elemento que el usuario borró; su contenido comparte eliminadoLote
        eliminadoEn: { type: Date, default: null, index: true },
        eliminadoPor: String, eliminadoPorNombre: String, eliminadoLote: String, eliminadoRaiz: Boolean
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
    // Quien tiene permiso de edición puede renombrar/eliminar/mover contenido DENTRO de la carpeta compartida,
    // pero no la carpeta raíz compartida ni cambiar sus permisos (eso es solo del propietario).
    const puedeModificar = (n, u) => n.propietarioId === u || (!!n.padreId && puedeEditar(n, u));
    const dto = (n, u) => ({
        _id: n._id, tipo: n.tipo, nombre: n.nombre, padreId: n.padreId, visibilidad: n.visibilidad,
        propietarioNombre: n.propietarioNombre, esMio: n.propietarioId === u, editable: puedeEditar(n, u),
        contentType: n.contentType, tamanio: n.tamanio, creado: n.creado, modificado: n.modificado,
        modificable: puedeModificar(n, u), creadoPor: n.creadoPorNombre || n.propietarioNombre,
        compartidoCon: n.propietarioId === u ? (n.compartidoCon || []) : undefined,
        permiso: n.propietarioId === u ? 'propietario' : ((n.compartidoCon || []).find(c => c.userId === u) || {}).permiso || (n.visibilidad === 'publica' ? 'lectura' : '')
    });
    // Tiempo real: aviso ligero (sin datos) para que los clientes refresquen su lista
    const avisar = (req, extra = {}) => { try { global.io?.emit('archivos_crm_cambio', { actor: req.u.id, ...extra }); } catch (_) {} };
    const err = (res, e) => res.status(500).json({ error: e.message });

    const vivo = { eliminadoEn: null };   // filtro: excluye lo que está en la papelera
    const DIAS_PAPELERA = 30;
    // filtro = vivo (por defecto) o {} para incluir también lo eliminado
    async function descendientes(id, filtro = vivo) {
        const out = []; let nivel = [id];
        while (nivel.length) {
            const hijos = await Nodo.find({ padreId: { $in: nivel }, ...filtro }).select('_id tipo archivoId');
            out.push(...hijos);
            nivel = hijos.filter(h => h.tipo === 'carpeta').map(h => h._id);
        }
        return out;
    }
    // Evita duplicados en la misma carpeta: "Plano.pdf" -> "Plano (2).pdf"
    async function nombreLibre(padreId, nombre) {
        const punto = nombre.lastIndexOf('.');
        const [base, ext] = punto > 0 ? [nombre.slice(0, punto), nombre.slice(punto)] : [nombre, ''];
        let candidato = nombre, n = 1;
        while (await Nodo.exists({ padreId, nombre: candidato, ...vivo })) candidato = `${base} (${++n})${ext}`;
        return candidato;
    }
    const nombreValido = n => typeof n === 'string' && n.trim() && n.trim().length <= 120 && !/[\\/:*?"<>|]/.test(n);

    // Fase 4: auditoría, cuota/tipos bloqueados y ZIP de carpeta (se registra antes de las rutas para auditarlas todas)
    const fase4 = require('./archivos-fase4-routes')({ app, mongoose, getNodo: () => Nodo, CRMArchivo, auth, puedeLeer, vivo, err });

    // ---------- Listar ----------
    // vista: mios | equipo (publicado por otros) | publicados (publicado por mí)
    app.get('/api/archivos-crm', auth, async (req, res) => {
        try {
            const u = req.u.id, vista = req.query.vista || 'mios', padreId = req.query.padreId || null;
            let items = [], ruta = [], editable = !padreId && vista === 'mios';
            if (padreId) {
                const padre = await Nodo.findById(padreId);
                if (!padre || padre.eliminadoEn || padre.tipo !== 'carpeta' || !puedeLeer(padre, u)) return res.status(404).json({ error: 'Carpeta no disponible' });
                editable = puedeEditar(padre, u);
                items = (await Nodo.find({ padreId, ...vivo })).filter(n => puedeLeer(n, u));
                for (let c = padre; c && puedeLeer(c, u); c = c.padreId ? await Nodo.findById(c.padreId) : null) ruta.unshift({ _id: c._id, nombre: c.nombre });
            } else if (vista === 'mios') {
                items = await Nodo.find({ propietarioId: u, padreId: null, ...vivo });
            } else if (vista === 'conmigo') {
                const todos = await Nodo.find({ propietarioId: { $ne: u }, 'compartidoCon.userId': u, ...vivo });
                const ids = new Set(todos.map(n => n._id));
                items = todos.filter(n => !n.padreId || !ids.has(n.padreId));
            } else {
                const filtro = vista === 'equipo'
                    ? { visibilidad: 'publica', propietarioId: { $ne: u } }
                    : { visibilidad: 'publica', propietarioId: u };
                const todos = await Nodo.find({ ...filtro, ...vivo });
                const ids = new Set(todos.map(n => n._id));
                items = todos.filter(n => !n.padreId || !ids.has(n.padreId));   // solo la "raíz" de lo publicado
            }
            items.sort((a, b) => (a.tipo === b.tipo ? a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }) : a.tipo === 'carpeta' ? -1 : 1));
            res.json({ items: items.map(n => dto(n, u)), ruta, editable });
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
            if (await Nodo.exists({ padreId: padreId || null, nombre: nombre.trim(), ...vivo }))
                return res.status(409).json({ error: 'Ya existe un elemento con ese nombre aquí' });
            const nodo = await Nodo.create({
                tipo: 'carpeta', nombre: nombre.trim(), padreId: padreId || null,
                propietarioId: padre ? padre.propietarioId : req.u.id, propietarioNombre: padre ? padre.propietarioNombre : req.u.nombre,
                creadoPorNombre: req.u.nombre,
                visibilidad: padre ? padre.visibilidad : 'privada',
                compartidoCon: padre ? padre.compartidoCon : []
            });
            avisar(req);
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
            // El contenido de una carpeta compartida pertenece a la carpeta, no a
            // quien lo cargó. Así todos los colaboradores conservan el mismo
            // acceso y la cuota se contabiliza al propietario real del contenido.
            const propietarioId = padre ? padre.propietarioId : req.u.id;
            const propietarioNombre = padre ? padre.propietarioNombre : req.u.nombre;
            const motivo = await fase4.validarSubida(propietarioId, req.files);
            if (motivo) return res.status(400).json({ error: motivo });
            const creados = [];
            for (const f of req.files || []) {
                const original = Buffer.from(f.originalname, 'latin1').toString('utf8');   // corrige acentos
                const contenido = await CRMArchivo.create({
                    nombre: original, contentType: f.mimetype, datos: f.buffer.toString('base64'), tamanio: f.size
                });
                const nodo = await Nodo.create({
                    tipo: 'archivo', nombre: await nombreLibre(padreId, original), padreId,
                    propietarioId, propietarioNombre,
                    visibilidad: padre ? padre.visibilidad : 'privada', compartidoCon: padre ? padre.compartidoCon : [],
                    archivoId: String(contenido._id), contentType: f.mimetype, tamanio: f.size
                });
                creados.push(dto(nodo, req.u.id));
            }
            avisar(req);
            res.json({ items: creados });
        } catch (e) { err(res, e); }
    });

    // ---------- Renombrar / cambiar visibilidad (solo el propietario) ----------
    app.put('/api/archivos-crm/:id', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo) return res.status(404).json({ error: 'No encontrado' });
            const { nombre, visibilidad } = req.body || {};
            if (!puedeModificar(nodo, req.u.id) || (visibilidad !== undefined && nodo.propietarioId !== req.u.id))
                return res.status(403).json({ error: 'No tienes permiso para modificarlo' });
            if (nombre !== undefined) {
                if (!nombreValido(nombre)) return res.status(400).json({ error: 'Nombre no válido (no uses \\ / : * ? " < > |)' });
                const dup = await Nodo.exists({ _id: { $ne: nodo._id }, padreId: nodo.padreId, nombre: nombre.trim(), ...vivo });
                if (dup) return res.status(409).json({ error: 'Ya existe un elemento con ese nombre aquí' });
                nodo.nombre = nombre.trim();
            }
            if (visibilidad !== undefined) {
                if (!['privada', 'publica'].includes(visibilidad)) return res.status(400).json({ error: 'Visibilidad no válida' });
                nodo.visibilidad = visibilidad;
                if (visibilidad === 'privada') nodo.compartidoCon = [];   // "Privada" = solo yo
                if (nodo.tipo === 'carpeta') {   // el contenido hereda visibilidad y accesos de la carpeta
                    const ids = (await descendientes(nodo._id)).map(d => d._id);
                    const set = { visibilidad }; if (visibilidad === 'privada') set.compartidoCon = [];
                    await Nodo.updateMany({ _id: { $in: ids } }, { $set: set });
                }
            }
            await nodo.save();
            avisar(req);
            res.json(dto(nodo, req.u.id));
        } catch (e) { err(res, e); }
    });

    // ---------- Eliminar = enviar a la papelera (carpeta incluye su contenido; se conserva 30 días) ----------
    app.delete('/api/archivos-crm/:id', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo || nodo.eliminadoEn) return res.status(404).json({ error: 'No encontrado' });
            if (!puedeModificar(nodo, req.u.id)) return res.status(403).json({ error: 'No tienes permiso para eliminarlo' });
            const lote = new mongoose.Types.ObjectId().toString(), ahora = new Date();
            const ids = [nodo._id, ...(await descendientes(nodo._id)).map(d => d._id)];
            await Nodo.updateMany({ _id: { $in: ids } }, { $set: { eliminadoEn: ahora, eliminadoLote: lote, eliminadoPor: req.u.id, eliminadoPorNombre: req.u.nombre, eliminadoRaiz: false } });
            await Nodo.updateOne({ _id: nodo._id }, { $set: { eliminadoRaiz: true } });
            avisar(req);
            res.json({ ok: true, eliminados: ids.length, enPapelera: true });
        } catch (e) { err(res, e); }
    });

    // ---------- Papelera ----------
    const puedeVerPapelera = (n, u) => n.propietarioId === u || n.eliminadoPor === u;
    async function borrarDefinitivo(nodo) {
        const todos = [nodo, ...(await descendientes(nodo._id, {}))];
        const archivoIds = todos.map(n => n.archivoId).filter(Boolean);
        if (archivoIds.length) {
            await CRMArchivo.deleteMany({ _id: { $in: archivoIds } });
            try { await mongoose.models.CRMHojaVersion?.deleteMany({ nodoId: { $in: todos.map(n => n._id) } }); } catch (_) {}
        }
        await Nodo.deleteMany({ _id: { $in: todos.map(n => n._id) } });
        return todos.length;
    }
    // Limpieza automática: lo que lleva más de 30 días en la papelera se borra de verdad
    async function purgarPapelera() {
        try {
            const limite = new Date(Date.now() - DIAS_PAPELERA * 86400000);
            for (const n of await Nodo.find({ eliminadoRaiz: true, eliminadoEn: { $lt: limite } })) await borrarDefinitivo(n);
        } catch (e) { console.error('Papelera: error al purgar', e.message); }
    }
    setTimeout(purgarPapelera, 60 * 1000).unref?.();
    setInterval(purgarPapelera, 6 * 3600 * 1000).unref?.();

    app.get('/api/archivos-crm/papelera', auth, async (req, res) => {
        try {
            const u = req.u.id;
            const raices = (await Nodo.find({ eliminadoRaiz: true, eliminadoEn: { $ne: null }, $or: [{ propietarioId: u }, { eliminadoPor: u }] })).filter(n => puedeVerPapelera(n, u));
            raices.sort((a, b) => b.eliminadoEn - a.eliminadoEn);
            res.json({ dias: DIAS_PAPELERA, items: raices.map(n => ({
                _id: n._id, tipo: n.tipo, nombre: n.nombre, contentType: n.contentType, tamanio: n.tamanio,
                eliminado: n.eliminadoEn, eliminadoPor: n.eliminadoPorNombre || '', esMio: n.propietarioId === u,
                venceEn: new Date(n.eliminadoEn.getTime() + DIAS_PAPELERA * 86400000)
            })) });
        } catch (e) { err(res, e); }
    });

    // Restaurar: vuelve a su carpeta original; si ya no existe (o también está en la papelera), va a la raíz del propietario
    app.post('/api/archivos-crm/:id/restaurar', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo || !nodo.eliminadoEn || !nodo.eliminadoRaiz || !puedeVerPapelera(nodo, req.u.id)) return res.status(404).json({ error: 'No está en la papelera' });
            let padre = nodo.padreId ? await Nodo.findById(nodo.padreId) : null;
            if (padre && padre.eliminadoEn) padre = null;
            const padreId = padre ? padre._id : null;
            if (!padre) { nodo.padreId = null; nodo.visibilidad = 'privada'; nodo.compartidoCon = []; }
            nodo.nombre = await nombreLibre(padreId, nodo.nombre);
            const lote = nodo.eliminadoLote;
            await Nodo.updateMany({ eliminadoLote: lote, _id: { $ne: nodo._id } }, { $set: { eliminadoEn: null, eliminadoRaiz: false }, $unset: { eliminadoLote: '', eliminadoPor: '', eliminadoPorNombre: '' } });
            if (!padre && nodo.tipo === 'carpeta') {   // sin carpeta de origen: el contenido pasa a privado, igual que la raíz
                const ids = (await descendientes(nodo._id)).map(d => d._id);
                if (ids.length) await Nodo.updateMany({ _id: { $in: ids } }, { $set: { visibilidad: 'privada', compartidoCon: [] } });
            }
            nodo.eliminadoEn = null; nodo.eliminadoRaiz = false;
            nodo.eliminadoLote = undefined; nodo.eliminadoPor = undefined; nodo.eliminadoPorNombre = undefined;
            await nodo.save();
            avisar(req);
            res.json({ ok: true, item: dto(nodo, req.u.id), enRaiz: !padre });
        } catch (e) { err(res, e); }
    });

    // Eliminar definitivamente un elemento de la papelera
    app.delete('/api/archivos-crm/:id/definitivo', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo || !nodo.eliminadoEn || !nodo.eliminadoRaiz || !puedeVerPapelera(nodo, req.u.id)) return res.status(404).json({ error: 'No está en la papelera' });
            const n = await borrarDefinitivo(nodo);
            avisar(req);
            res.json({ ok: true, eliminados: n });
        } catch (e) { err(res, e); }
    });

    // ---------- Abrir / descargar ----------
    app.get('/api/archivos-crm/:id/archivo', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo || nodo.eliminadoEn || nodo.tipo !== 'archivo' || !puedeLeer(nodo, req.u.id)) return res.status(404).json({ error: 'Archivo no disponible' });
            const arch = await CRMArchivo.findById(nodo.archivoId);
            if (!arch) return res.status(404).json({ error: 'Contenido no encontrado' });
            res.set('Content-Type', arch.contentType || 'application/octet-stream');
            res.set('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(nodo.nombre)}`);
            res.send(Buffer.from(arch.datos, 'base64'));
        } catch (e) { err(res, e); }
    });

    // ======================= FASE 2 =======================
    // ---------- Compartir con usuarios específicos (solo el propietario) ----------
    // body: { usuarios: [{ userId, nombre, permiso: 'lectura' | 'edicion' }] }  ([] = dejar de compartir)
    app.put('/api/archivos-crm/:id/compartir', auth, async (req, res) => {
        try {
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo) return res.status(404).json({ error: 'No encontrado' });
            if (nodo.propietarioId !== req.u.id) return res.status(403).json({ error: 'Solo el propietario puede compartir' });
            const vistos = new Set();
            const lista = (Array.isArray(req.body?.usuarios) ? req.body.usuarios : [])
                .map(c => ({ userId: String(c.userId || '').trim(), nombre: String(c.nombre || '').slice(0, 120), permiso: c.permiso === 'edicion' ? 'edicion' : 'lectura' }))
                .filter(c => c.userId && c.userId !== req.u.id && !vistos.has(c.userId) && vistos.add(c.userId));
            const antes = new Set((nodo.compartidoCon || []).map(c => c.userId));
            const visibilidad = nodo.visibilidad === 'publica' ? 'publica' : (lista.length ? 'compartida' : 'privada');
            nodo.compartidoCon = lista; nodo.visibilidad = visibilidad;
            const ids = nodo.tipo === 'carpeta' ? (await descendientes(nodo._id)).map(d => d._id) : [];
            if (ids.length) await Nodo.updateMany({ _id: { $in: ids } }, { $set: { compartidoCon: lista, visibilidad } });
            await nodo.save();
            const nuevos = lista.map(c => c.userId).filter(id => !antes.has(id));
            avisar(req, { compartidoA: nuevos, por: req.u.nombre, nombre: nodo.nombre });
            res.json(dto(nodo, req.u.id));
        } catch (e) { err(res, e); }
    });

    // ---------- Árbol de carpetas (las que puedo leer) ----------
    app.get('/api/archivos-crm/arbol', auth, async (req, res) => {
        try {
            const u = req.u.id;
            const todas = await Nodo.find({ tipo: 'carpeta', ...vivo, $or: [{ propietarioId: u }, { 'compartidoCon.userId': u }] }).select('nombre padreId propietarioId compartidoCon');
            res.json({ carpetas: todas.map(c => ({ _id: c._id, nombre: c.nombre, padreId: c.padreId, esMio: c.propietarioId === u, editable: puedeEditar(c, u) })) });
        } catch (e) { err(res, e); }
    });

    // ---------- Mover (solo dentro de lo que es mío) ----------
    app.put('/api/archivos-crm/:id/mover', auth, async (req, res) => {
        try {
            const u = req.u.id, destinoId = req.body?.destinoId || null;
            const nodo = await Nodo.findById(req.params.id);
            if (!nodo || nodo.eliminadoEn) return res.status(404).json({ error: 'No encontrado' });
            if (nodo.propietarioId !== u) return res.status(403).json({ error: 'Solo puedes mover elementos tuyos' });
            let destino = null;
            if (destinoId) {
                destino = await Nodo.findById(destinoId);
                if (!destino || destino.tipo !== 'carpeta' || destino.propietarioId !== u) return res.status(403).json({ error: 'Solo puedes mover a carpetas tuyas' });
                const desc = nodo.tipo === 'carpeta' ? (await descendientes(nodo._id)).map(d => d._id) : [];
                if (destinoId === nodo._id || desc.includes(destinoId)) return res.status(400).json({ error: 'No se puede mover una carpeta dentro de sí misma' });
            }
            if ((nodo.padreId || null) === destinoId) return res.json(dto(nodo, u));
            nodo.padreId = destinoId;
            nodo.nombre = await nombreLibre(destinoId, nodo.nombre);
            nodo.visibilidad = destino ? destino.visibilidad : 'privada';
            nodo.compartidoCon = destino ? destino.compartidoCon : [];
            if (nodo.tipo === 'carpeta') {
                const ids = (await descendientes(nodo._id)).map(d => d._id);
                if (ids.length) await Nodo.updateMany({ _id: { $in: ids } }, { $set: { visibilidad: nodo.visibilidad, compartidoCon: nodo.compartidoCon } });
            }
            await nodo.save();
            avisar(req);
            res.json(dto(nodo, u));
        } catch (e) { err(res, e); }
    });

    // ---------- Copiar (a una carpeta donde tenga permiso de edición) ----------
    app.post('/api/archivos-crm/:id/copiar', auth, async (req, res) => {
        try {
            const u = req.u.id, destinoId = req.body?.destinoId || null;
            const origen = await Nodo.findById(req.params.id);
            if (!origen || origen.eliminadoEn || !puedeLeer(origen, u)) return res.status(404).json({ error: 'No encontrado' });
            let destino = null;
            if (destinoId) {
                destino = await Nodo.findById(destinoId);
                if (!destino || destino.tipo !== 'carpeta' || !puedeEditar(destino, u)) return res.status(403).json({ error: 'No tienes permiso en la carpeta destino' });
                if (origen.tipo === 'carpeta') {
                    const desc = (await descendientes(origen._id)).map(d => d._id);
                    if (destinoId === origen._id || desc.includes(destinoId)) return res.status(400).json({ error: 'No se puede copiar una carpeta dentro de sí misma' });
                }
            }
            const base = {
                propietarioId: destino ? destino.propietarioId : u, propietarioNombre: destino ? destino.propietarioNombre : req.u.nombre,
                creadoPorNombre: req.u.nombre, visibilidad: destino ? destino.visibilidad : 'privada', compartidoCon: destino ? destino.compartidoCon : []
            };
            let total = 0;
            async function clonar(n, padreDestino) {
                const copia = { ...base, tipo: n.tipo, padreId: padreDestino, nombre: await nombreLibre(padreDestino, n.nombre), contentType: n.contentType, tamanio: n.tamanio };
                if (n.tipo === 'archivo') {
                    const a = await CRMArchivo.findById(n.archivoId);
                    if (!a) return null;
                    const nuevo = await CRMArchivo.create({ nombre: a.nombre, contentType: a.contentType, datos: a.datos, tamanio: a.tamanio });
                    copia.archivoId = String(nuevo._id);
                }
                const creado = await Nodo.create(copia); total++;
                if (n.tipo === 'carpeta') for (const h of await Nodo.find({ padreId: n._id, ...vivo })) await clonar(h, creado._id);
                return creado;
            }
            const raiz = await clonar(origen, destinoId);
            avisar(req);
            res.json({ ok: true, copiados: total, item: raiz ? dto(raiz, u) : null });
        } catch (e) { err(res, e); }
    });

    // ---------- FASE 3 (parcial): hojas de cálculo propias ----------
    const extra = { app, mongoose, Nodo, CRMArchivo, auth, puedeLeer, puedeEditar, dto, avisar, nombreLibre, nombreValido, err };
    require('./archivos-extra-routes')(extra);
};
