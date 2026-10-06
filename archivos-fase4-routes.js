// Fase 4 (sin paquetes nuevos): descarga de carpeta como ZIP, cuota por usuario, tipos bloqueados y auditoría.
// Se registra al INICIO de archivos-routes.js (antes de las demás rutas) para que el middleware de auditoría las vea todas.
const zlib = require('zlib');

const CUOTA_MB = Number(process.env.ARCHIVOS_CUOTA_MB) || 500;   // por usuario (propietario)
const BLOQUEADAS = (process.env.ARCHIVOS_EXT_BLOQUEADAS || 'exe,bat,cmd,com,scr,msi,vbs,vbe,ps1,jar,dll,pif,lnk,hta,reg')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DIAS_AUDITORIA = 180;

// CRC32 (zlib.crc32 existe en Node >= 20.15 / 22; si no, tabla propia)
const TABLA = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = TABLA[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
};
const dosFecha = d => ({ t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), f: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });

// Escritor ZIP mínimo: entradas deflate, nombres UTF-8, escribe en streaming a `salida` (sin archiver).
function crearZip(salida) {
    const central = []; let offset = 0;
    const escribir = b => { salida.write(b); offset += b.length; };
    return {
        agregar(nombre, datos, fecha) {
            const nom = Buffer.from(nombre, 'utf8'), crc = crc32(datos), comp = zlib.deflateRawSync(datos);
            const usar = comp.length < datos.length, cuerpo = usar ? comp : datos, met = usar ? 8 : 0, { t, f } = dosFecha(fecha || new Date());
            const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(met, 8);
            h.writeUInt16LE(t, 10); h.writeUInt16LE(f, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(cuerpo.length, 18); h.writeUInt32LE(datos.length, 22); h.writeUInt16LE(nom.length, 26);
            central.push({ nom, crc, cs: cuerpo.length, us: datos.length, met, t, f, off: offset, dir: /\/$/.test(nombre) });
            escribir(h); escribir(nom); escribir(cuerpo);
        },
        cerrar() {
            const ini = offset;
            for (const e of central) {
                const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.met, 10);
                c.writeUInt16LE(e.t, 12); c.writeUInt16LE(e.f, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.cs, 20); c.writeUInt32LE(e.us, 24); c.writeUInt16LE(e.nom.length, 28);
                if (e.dir) c.writeUInt32LE(0x10, 38); c.writeUInt32LE(e.off, 42);
                escribir(c); escribir(e.nom);
            }
            const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(central.length, 8); fin.writeUInt16LE(central.length, 10);
            fin.writeUInt32LE(offset - ini, 12); fin.writeUInt32LE(ini, 16);
            salida.end(fin);
        }
    };
}

module.exports = function ({ app, mongoose, getNodo, CRMArchivo, auth, puedeLeer, vivo, err }) {
    const Aud = mongoose.models.CRMArchivoAuditoria || mongoose.model('CRMArchivoAuditoria', new mongoose.Schema({
        actorId: { type: String, index: true }, actorNombre: String, metodo: String, accion: String,
        nodoId: { type: String, index: true }, detalle: String, ip: String,
        creado: { type: Date, default: Date.now, expires: DIAS_AUDITORIA * 86400 }
    }));

    // ---------- Auditoría: registra toda operación que MODIFICA (POST/PUT/DELETE) y terminó bien ----------
    app.use('/api/archivos-crm', (req, res, next) => {
        if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
        res.on('finish', () => {
            if (res.statusCode >= 400) return;
            try {
                const id = String(req.get('x-user-id') || req.query.uid || '').trim(); if (!id) return;
                let nombre = ''; try { nombre = decodeURIComponent(req.get('x-user-name') || ''); } catch (_) {}
                const partes = req.path.split('/').filter(Boolean);   // /:id/accion  |  /subir  |  /carpetas ...
                const nodoId = /^[a-f0-9]{24}$/i.test(partes[0] || '') ? partes[0] : undefined;
                const accion = (nodoId ? partes[1] : partes[0]) || (req.method === 'DELETE' ? 'eliminar' : 'modificar');
                const b = req.body || {};
                const detalle = [b.nombre && 'nombre=' + String(b.nombre).slice(0, 80), b.visibilidad && 'visibilidad=' + b.visibilidad, b.destinoId && 'destino=' + b.destinoId,
                    (req.files || []).length && 'archivos=' + req.files.map(f => Buffer.from(f.originalname, 'latin1').toString('utf8')).join(', ').slice(0, 200)].filter(Boolean).join(' · ');
                Aud.create({ actorId: id, actorNombre: nombre, metodo: req.method, accion: req.method === 'DELETE' && !nodoId ? 'eliminar' : accion, nodoId, detalle, ip: req.ip }).catch(() => {});
            } catch (_) { /* la auditoría nunca debe romper la operación */ }
        });
        next();
    });
    app.get('/api/archivos-crm/auditoria/mia', auth, async (req, res) => {
        try {
            const lim = Math.min(Number(req.query.limit) || 100, 500);
            res.json({ dias: DIAS_AUDITORIA, items: await Aud.find({ actorId: req.u.id }).sort({ creado: -1 }).limit(lim).lean() });
        } catch (e) { err(res, e); }
    });
    // Historial de un elemento: solo su propietario
    app.get('/api/archivos-crm/:id/auditoria', auth, async (req, res) => {
        try {
            const n = await getNodo().findById(req.params.id);
            if (!n || n.propietarioId !== req.u.id) return res.status(403).json({ error: 'Solo el propietario ve el historial de actividad' });
            res.json({ dias: DIAS_AUDITORIA, items: await Aud.find({ nodoId: n._id }).sort({ creado: -1 }).limit(200).lean() });
        } catch (e) { err(res, e); }
    });

    // ---------- Cuota ----------
    async function usoBytes(uid) {
        const r = await getNodo().aggregate([{ $match: { propietarioId: uid, tipo: 'archivo', eliminadoEn: null } }, { $group: { _id: null, t: { $sum: '$tamanio' } } }]);
        return r[0] ? r[0].t : 0;
    }
    app.get('/api/archivos-crm/cuota/mia', auth, async (req, res) => {
        try { res.json({ usado: await usoBytes(req.u.id), limite: CUOTA_MB * 1024 * 1024, bloqueadas: BLOQUEADAS }); } catch (e) { err(res, e); }
    });

    // ---------- Descargar carpeta como ZIP ----------
    app.get('/api/archivos-crm/:id/zip', auth, async (req, res) => {
        try {
            const Nodo = getNodo(), raiz = await Nodo.findById(req.params.id);
            if (!raiz || raiz.eliminadoEn || raiz.tipo !== 'carpeta' || !puedeLeer(raiz, req.u.id)) return res.status(404).json({ error: 'Carpeta no disponible' });
            const limpio = s => s.replace(/[\\/:*?"<>|]/g, '_');
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(limpio(raiz.nombre) + '.zip')}`);
            const zip = crearZip(res); const usados = new Set();
            const unico = ruta => { let r = ruta, k = 1; while (usados.has(r.toLowerCase())) { const p = ruta.lastIndexOf('.'); r = p > ruta.lastIndexOf('/') + 1 ? `${ruta.slice(0, p)} (${++k})${ruta.slice(p)}` : `${ruta} (${++k})`; } usados.add(r.toLowerCase()); return r; };
            let total = 0; const MAX_ZIP = 500 * 1024 * 1024;
            async function recorrer(carpeta, prefijo) {
                zip.agregar(prefijo, Buffer.alloc(0), carpeta.modificado);
                const hijos = (await Nodo.find({ padreId: carpeta._id, ...vivo })).filter(n => puedeLeer(n, req.u.id))
                    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
                for (const h of hijos) {
                    if (h.tipo === 'carpeta') { await recorrer(h, prefijo + limpio(h.nombre) + '/'); continue; }
                    const a = await CRMArchivo.findById(h.archivoId); if (!a) continue;
                    const buf = Buffer.from(a.datos || '', 'base64'); total += buf.length;
                    if (total > MAX_ZIP) throw new Error('La carpeta supera 500 MB; descárgala por partes');
                    zip.agregar(unico(prefijo + limpio(h.nombre)), buf, h.modificado);
                }
            }
            await recorrer(raiz, limpio(raiz.nombre) + '/');
            zip.cerrar();
        } catch (e) { if (res.headersSent) { res.destroy(); } else err(res, e); }
    });

    // Validación que usa la ruta de subida (ver archivos-routes.js)
    return {
        async validarSubida(propietarioId, files) {
            for (const f of files || []) {
                const nombre = Buffer.from(f.originalname, 'latin1').toString('utf8'), ext = (nombre.split('.').pop() || '').toLowerCase();
                if (nombre.includes('.') && BLOQUEADAS.includes(ext)) return `Tipo de archivo no permitido: .${ext}`;
            }
            const nuevo = (files || []).reduce((s, f) => s + f.size, 0);
            if (nuevo && (await usoBytes(propietarioId)) + nuevo > CUOTA_MB * 1024 * 1024)
                return `Cuota excedida (${CUOTA_MB} MB por usuario). Elimina archivos o vacía la papelera.`;
            return null;
        }
    };
};
