require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const path = require('path');

const app = express();
const PORT = process.env.EMAIL_SERVER_PORT || 4010;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] } });
const uploadEntregables = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 15 },
});

// ─────────────────────────────────────────────────────────────────────────────
// CORS & JSON
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// SERVIR ARCHIVOS FRONTEND (Para https://em.naisata.com)
// ─────────────────────────────────────────────────────────────────────────────
const parentDir = path.join(__dirname, '..');
app.get('/', (req, res) => res.sendFile(path.join(parentDir, 'em.html')));
app.get('/em.html', (req, res) => res.sendFile(path.join(parentDir, 'em.html')));
app.get('/correo.css', (req, res) => res.sendFile(path.join(parentDir, 'correo.css')));
app.get('/correo.js', (req, res) => res.sendFile(path.join(parentDir, 'correo.js')));
app.get('/entregables.html', (req, res) => res.sendFile(path.join(parentDir, 'entregables.html')));
app.get('/entregables.css', (req, res) => res.sendFile(path.join(parentDir, 'entregables.css')));
app.get('/entregables.js', (req, res) => res.sendFile(path.join(parentDir, 'entregables.js')));

// ─────────────────────────────────────────────────────────────────────────────
// SEGURIDAD API (Validar token de CRM)
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/email', (req, res, next) => {
    const SECRET = process.env.API_SECRET_TOKEN || 'tu_token_secreto_muy_seguro_123';
    if (req.headers['x-api-token'] !== SECRET) {
        return res.status(401).json({ ok: false, error: 'Acceso denegado al API de correos' });
    }
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MONGODB — Misma base de datos que server_2.js
// ─────────────────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI ||
    'mongodb+srv://jarvis:Hola2025@cluster0.jih3lub.mongodb.net/naisata_db?appName=Cluster0';

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
})
.then(() => process.stdout.write('[EMAIL SERVER] ✅ Conectado a MongoDB\n'))
.catch(err => process.stdout.write(`[EMAIL SERVER] ❌ MongoDB error: ${err.message}\n`));

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA — Cuentas de correo
// ─────────────────────────────────────────────────────────────────────────────
const EmailCuentaSchema = new mongoose.Schema({
    nombre:        { type: String, required: true },          // etiqueta amigable ej: "Ventas"
    email:         { type: String, required: true },          // daniel@naisata.com
    password:      { type: String, required: true },          // contraseña IMAP/SMTP
    imapHost:      { type: String, default: 'correo.naisata.com' },
    imapPort:      { type: Number, default: 993 },
    imapTLS:       { type: Boolean, default: true },
    smtpHost:      { type: String, default: 'correo.naisata.com' },
    smtpPort:      { type: Number, default: 465 },
    smtpTLS:       { type: Boolean, default: true },
    activa:        { type: Boolean, default: true },
    creadaEn:      { type: Date, default: Date.now },
});

const EmailCuenta = mongoose.model('EmailCuenta', EmailCuentaSchema);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — IMAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abre una conexión IMAP y la resuelve cuando está lista.
 */
function abrirImap(cuenta) {
    return new Promise((resolve, reject) => {
        const imap = new Imap({
            user:     cuenta.email,
            password: cuenta.password,
            host:     cuenta.imapHost,
            port:     cuenta.imapPort,
            tls:      cuenta.imapTLS,
            tlsOptions: { rejectUnauthorized: false },
            connTimeout: 15000,
            authTimeout: 10000,
        });
        imap.once('ready', () => resolve(imap));
        imap.once('error', reject);
        imap.connect();
    });
}

/**
 * Obtiene la lista de carpetas IMAP.
 */
function obtenerCarpetas(imap) {
    return new Promise((resolve, reject) => {
        imap.getBoxes((err, boxes) => {
            if (err) return reject(err);
            const lista = [];
            const recorrer = (obj, prefijo = '') => {
                for (const nombre of Object.keys(obj)) {
                    const ruta = prefijo ? `${prefijo}${obj[nombre].delimiter || '/'}${nombre}` : nombre;
                    lista.push({ nombre, ruta, atributos: obj[nombre].attribs || [] });
                    if (obj[nombre].children) recorrer(obj[nombre].children, ruta);
                }
            };
            recorrer(boxes);
            resolve(lista);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — Resolver nombre real de carpeta IMAP (cPanel/Dovecot usa variantes)
// ─────────────────────────────────────────────────────────────────────────────

function abrirCarpeta(imap, nombre) {
    return new Promise((resolve, reject) => {
        // Intentar primero con el nombre exacto
        imap.openBox(nombre, false, (err, box) => {
            if (!err) return resolve({ box, folderUsed: nombre });

            // Si falla, pedimos el árbol de carpetas y buscamos dinámicamente
            obtenerCarpetas(imap).then(carpetas => {
                const clave = nombre.toLowerCase();
                let encontrada = null;

                // 1. Buscar por atributo especial de IMAP (ej. \Junk, \Sent, \Trash)
                const atrMap = { 'junk': '\\Junk', 'sent': '\\Sent', 'trash': '\\Trash', 'drafts': '\\Drafts' };
                if (atrMap[clave]) {
                    encontrada = carpetas.find(c => c.atributos.includes(atrMap[clave]));
                }

                // 2. Si no tiene atributo, buscar por coincidencia de nombre ignorando mayúsculas/minúsculas
                if (!encontrada) {
                    const terminos = clave === 'junk' ? ['spam', 'junk'] :
                                     clave === 'trash' ? ['trash', 'deleted', 'papelera'] :
                                     clave === 'sent' ? ['sent', 'enviados'] :
                                     clave === 'drafts' ? ['draft', 'borrador'] : [clave];
                    
                    encontrada = carpetas.find(c => {
                        const nomLow = c.nombre.toLowerCase();
                        return terminos.some(t => nomLow.includes(t));
                    });
                }

                if (!encontrada) {
                    return reject(new Error(`Carpeta no encontrada: "${nombre}"`));
                }

                // Intentar abrir la carpeta encontrada
                imap.openBox(encontrada.ruta, false, (e2, b2) => {
                    if (e2) return reject(new Error(`Error al abrir carpeta "${encontrada.ruta}": ${e2.message}`));
                    resolve({ box: b2, folderUsed: encontrada.ruta });
                });
            }).catch(e => {
                reject(new Error(`No se pudo leer la estructura de carpetas: ${e.message}`));
            });
        });
    });
}

/**
 * Obtiene resumen de correos en una carpeta (sin body completo).
 * Retorna los últimos `limite` correos.
 */
function obtenerCorreos(imap, carpeta = 'INBOX', limite = 50) {
    return new Promise(async (resolve, reject) => {
        let box;
        try {
            const result = await abrirCarpeta(imap, carpeta);
            box = result.box;
        } catch (err) { 
            // Si la carpeta no existe (ej. Spam nunca ha recibido correos), resolvemos vacío
            return resolve({ total: 0, correos: [] }); 
        }
        try {
            const total = box.messages.total;
            if (total === 0) return resolve({ total: 0, correos: [] });

            const inicio = Math.max(1, total - limite + 1);
            const rango = `${inicio}:${total}`;

            const correos = [];
            const f = imap.seq.fetch(rango, {
                bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)'],
                struct: true,
                markSeen: false,
            });

            f.on('message', (msg, seqno) => {
                let header = '';
                let uid = seqno;
                let flags = [];

                msg.on('body', (stream) => {
                    stream.on('data', (chunk) => { header += chunk.toString('utf8'); });
                });
                msg.once('attributes', (attrs) => {
                    uid = attrs.uid;
                    flags = attrs.flags || [];
                });
                msg.once('end', () => {
                    // Parse header lines manualmente (simple)
                    const lines = header.split(/\r?\n/);
                    const get = (key) => {
                        const line = lines.find(l => l.toLowerCase().startsWith(key.toLowerCase() + ':'));
                        return line ? line.substring(key.length + 1).trim() : '';
                    };
                    correos.push({
                        uid,
                        seqno,
                        de: get('From'),
                        para: get('To'),
                        asunto: get('Subject') || '(Sin asunto)',
                        fecha: get('Date'),
                        messageId: get('Message-ID'),
                        leido: flags.includes('\\Seen'),
                        marcado: flags.includes('\\Flagged'),
                    });
                });
            });

            f.once('error', reject);
            f.once('end', () => {
                correos.sort((a, b) => b.seqno - a.seqno);
                resolve({ total, correos });
            });
        } catch(e) { reject(e); }
    });
}

/**
 * Obtiene el cuerpo completo de un correo por UID.
 */
function obtenerCuerpoCorreo(imap, carpeta, uid) {
    return new Promise(async (resolve, reject) => {
        try { await abrirCarpeta(imap, carpeta); }
        catch (err) { return reject(err); }
        try {
            const f = imap.fetch([uid], { bodies: '', markSeen: true });
            let raw = Buffer.alloc(0);

            f.on('message', (msg) => {
                msg.on('body', (stream) => {
                    const chunks = [];
                    stream.on('data', (chunk) => chunks.push(chunk));
                    stream.once('end', () => { raw = Buffer.concat(chunks); });
                });
            });
            f.once('error', reject);
            f.once('end', async () => {
                try {
                    const parsed = await simpleParser(raw);
                    resolve({
                        de:       parsed.from?.text || '',
                        para:     parsed.to?.text || '',
                        cc:       parsed.cc?.text || '',
                        asunto:   parsed.subject || '',
                        fecha:    parsed.date?.toISOString() || '',
                        html:     parsed.html || null,
                        texto:    parsed.text || '',
                        adjuntos: (parsed.attachments || []).map(a => ({
                            nombre: a.filename,
                            tipo:   a.contentType,
                            tamaño: a.size,
                        })),
                    });
                } catch(e) { reject(e); }
            });
        } catch(e) { reject(e); }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// RUTAS — CUENTAS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/email/cuentas — listar todas
app.get('/api/email/cuentas', async (req, res) => {
    try {
        const cuentas = await EmailCuenta.find().select('-password').lean();
        res.json({ ok: true, cuentas });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/email/cuentas — agregar cuenta
app.post('/api/email/cuentas', async (req, res) => {
    try {
        const { nombre, email, password, imapHost, imapPort, imapTLS, smtpHost, smtpPort, smtpTLS } = req.body;
        if (!nombre || !email || !password) {
            return res.status(400).json({ ok: false, error: 'nombre, email y password son requeridos' });
        }
        const cuenta = new EmailCuenta({
            nombre,
            email,
            password,
            imapHost:  imapHost  || 'correo.naisata.com',
            imapPort:  imapPort  || 993,
            imapTLS:   imapTLS   !== undefined ? imapTLS : true,
            smtpHost:  smtpHost  || 'correo.naisata.com',
            smtpPort:  smtpPort  || 465,
            smtpTLS:   smtpTLS   !== undefined ? smtpTLS : true,
        });
        await cuenta.save();
        const obj = cuenta.toObject();
        delete obj.password;
        res.json({ ok: true, cuenta: obj });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// DELETE /api/email/cuentas/:id
app.delete('/api/email/cuentas/:id', async (req, res) => {
    try {
        await EmailCuenta.findByIdAndDelete(req.params.id);
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/email/cuentas/test — probar conexión IMAP
app.post('/api/email/cuentas/test', async (req, res) => {
    try {
        const { email, password, imapHost, imapPort, imapTLS } = req.body;
        const imap = await abrirImap({ email, password, imapHost: imapHost||'correo.naisata.com', imapPort: imapPort||993, imapTLS: imapTLS!==false });
        imap.end();
        res.json({ ok: true, mensaje: 'Conexión IMAP exitosa' });
    } catch(e) {
        res.status(400).json({ ok: false, error: `Error de conexión: ${e.message}` });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// RUTAS — CARPETAS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/email/carpetas/:id — carpetas IMAP de la cuenta
app.get('/api/email/carpetas/:id', async (req, res) => {
    let imap;
    try {
        const cuenta = await EmailCuenta.findById(req.params.id);
        if (!cuenta) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
        imap = await abrirImap(cuenta);
        const carpetas = await obtenerCarpetas(imap);
        imap.end();
        res.json({ ok: true, carpetas });
    } catch(e) {
        if (imap) try { imap.end(); } catch(_) {}
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// RUTAS — CORREOS (lista)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/email/correos/:id?carpeta=INBOX&limite=50
app.get('/api/email/correos/:id', async (req, res) => {
    let imap;
    try {
        const cuenta = await EmailCuenta.findById(req.params.id);
        if (!cuenta) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
        const carpeta = req.query.carpeta || 'INBOX';
        const limite = parseInt(req.query.limite) || 50;
        imap = await abrirImap(cuenta);
        const data = await obtenerCorreos(imap, carpeta, limite);
        imap.end();
        res.json({ ok: true, ...data });
    } catch(e) {
        if (imap) try { imap.end(); } catch(_) {}
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// RUTAS — CORREO individual
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/email/correo/:id/:uid?carpeta=INBOX
app.get('/api/email/correo/:id/:uid', async (req, res) => {
    let imap;
    try {
        const cuenta = await EmailCuenta.findById(req.params.id);
        if (!cuenta) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
        const uid = parseInt(req.params.uid);
        const carpeta = req.query.carpeta || 'INBOX';
        imap = await abrirImap(cuenta);
        const correo = await obtenerCuerpoCorreo(imap, carpeta, uid);
        imap.end();
        res.json({ ok: true, correo });
    } catch(e) {
        if (imap) try { imap.end(); } catch(_) {}
        res.status(500).json({ ok: false, error: e.message });
    }
});

// PATCH /api/email/correo/:id/:uid/leido — marcar leído/no leído
app.patch('/api/email/correo/:id/:uid/leido', async (req, res) => {
    let imap;
    try {
        const cuenta = await EmailCuenta.findById(req.params.id);
        if (!cuenta) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
        const uid = parseInt(req.params.uid);
        const carpeta = req.query.carpeta || 'INBOX';
        const { leido } = req.body; // true / false
        imap = await abrirImap(cuenta);
        await new Promise(async (resolve, reject) => {
            try { await abrirCarpeta(imap, carpeta); }
            catch (err) { return reject(err); }
            if (leido) {
                imap.addFlags([uid], '\\Seen', (e) => e ? reject(e) : resolve());
            } else {
                imap.delFlags([uid], '\\Seen', (e) => e ? reject(e) : resolve());
            }
        });
        imap.end();
        res.json({ ok: true });
    } catch(e) {
        if (imap) try { imap.end(); } catch(_) {}
        res.status(500).json({ ok: false, error: e.message });
    }
});

// DELETE /api/email/correo/:id/:uid — eliminar (mover a Trash / borrar)
app.delete('/api/email/correo/:id/:uid', async (req, res) => {
    let imap;
    try {
        const cuenta = await EmailCuenta.findById(req.params.id);
        if (!cuenta) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
        const uid = parseInt(req.params.uid);
        const carpeta = req.query.carpeta || 'INBOX';
        imap = await abrirImap(cuenta);
        await new Promise(async (resolve, reject) => {
            try { await abrirCarpeta(imap, carpeta); }
            catch (err) { return reject(err); }
            imap.addFlags([uid], '\\Deleted', (e) => {
                if (e) return reject(e);
                imap.expunge((ex) => ex ? reject(ex) : resolve());
            });
        });
        imap.end();
        res.json({ ok: true });
    } catch(e) {
        if (imap) try { imap.end(); } catch(_) {}
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// RUTAS — ENVÍO DE CORREO (SMTP via Nodemailer)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/email/enviar
app.post('/api/email/enviar', async (req, res) => {
    try {
        const { cuentaId, para, cc, bcc, asunto, html, texto, adjuntos } = req.body;
        if (!cuentaId || !para || !asunto) {
            return res.status(400).json({ ok: false, error: 'cuentaId, para y asunto son requeridos' });
        }

        const cuenta = await EmailCuenta.findById(cuentaId);
        if (!cuenta) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });

        const transporter = nodemailer.createTransport({
            host: cuenta.smtpHost,
            port: cuenta.smtpPort,
            secure: cuenta.smtpPort === 465,
            auth: { user: cuenta.email, pass: cuenta.password },
            tls: { rejectUnauthorized: false },
        });

        // Convertir adjuntos base64 a formato nodemailer
        const attachments = (adjuntos || []).map(a => ({
            filename: a.nombre,
            content:  Buffer.from(a.base64, 'base64'),
            contentType: a.tipo
        }));

        await transporter.sendMail({
            from:        `"${cuenta.nombre}" <${cuenta.email}>`,
            to:          para,
            cc:          cc || undefined,
            bcc:         bcc || undefined,
            subject:     asunto,
            html:        html || undefined,
            text:        texto || undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
        });

        res.json({ ok: true, mensaje: 'Correo enviado exitosamente' });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTREGABLES — Clientes, empresas y tickets de trabajo
//
// Estas rutas comparten las colecciones históricas `sites`, `companies` y
// `tickets` de la plataforma. Se usan colecciones nativas para aceptar tanto
// IDs String como ObjectId de los registros ya existentes.
// ─────────────────────────────────────────────────────────────────────────────
const dbCollection = (name) => mongoose.connection.db.collection(name);

function idCandidates(id) {
    const values = [String(id)];
    if (mongoose.Types.ObjectId.isValid(id)) values.push(new mongoose.Types.ObjectId(id));
    return values;
}

function idFilter(id) {
    return { $or: [{ _id: { $in: idCandidates(id) } }, { id: String(id) }] };
}

function publicDocument(doc) {
    if (!doc) return null;
    const value = { ...doc };
    value.id = String(value.id || value._id);
    delete value._id;
    return value;
}

// mongodb-driver v5 devuelve { value }, mientras que v6 devuelve el documento.
function resultValue(result) {
    if (!result) return null;
    return Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
}

function uploadedPhotos(files = []) {
    return files
        .filter(file => file && file.buffer)
        .map(file => `data:${file.mimetype || 'image/jpeg'};base64,${file.buffer.toString('base64')}`);
}

function emitTicket(event, ticket) {
    try { io.emit(event, publicDocument(ticket)); } catch (_) { /* Socket opcional */ }
}

// GET /api/sites — clientes disponibles para entregables
app.get('/api/sites', async (req, res) => {
    try {
        const sites = await dbCollection('sites').find({}).sort({ nombre: 1 }).toArray();
        res.json(sites.map(publicDocument));
    } catch (error) {
        res.status(500).json({ error: `No se pudieron obtener los clientes: ${error.message}` });
    }
});

// GET /api/companies — empresas disponibles para el encabezado del PDF
app.get('/api/companies', async (req, res) => {
    try {
        const companies = await dbCollection('companies').find({}).sort({ nombre: 1 }).toArray();
        res.json(companies.map(publicDocument));
    } catch (error) {
        res.status(500).json({ error: `No se pudieron obtener las empresas: ${error.message}` });
    }
});

// GET /api/tickets/full/:id — debe declararse antes de /:siteId
app.get('/api/tickets/full/:id', async (req, res) => {
    try {
        const ticket = await dbCollection('tickets').findOne(idFilter(req.params.id));
        if (!ticket) return res.status(404).json({ error: 'Entregable no encontrado' });
        res.json(publicDocument(ticket));
    } catch (error) {
        res.status(500).json({ error: `No se pudo obtener el entregable: ${error.message}` });
    }
});

// GET /api/tickets/:siteId — entregables por cliente
app.get('/api/tickets/:siteId', async (req, res) => {
    try {
        const tickets = await dbCollection('tickets')
            .find({ siteId: { $in: idCandidates(req.params.siteId) } })
            .sort({ createdAt: -1, _id: -1 })
            .toArray();
        res.json(tickets.map(publicDocument));
    } catch (error) {
        res.status(500).json({ error: `No se pudieron obtener los entregables: ${error.message}` });
    }
});

// POST /api/tickets — crear entregable con fotos y firmas
app.post('/api/tickets', uploadEntregables.array('fotos', 15), async (req, res) => {
    try {
        const { siteId, folio, nombreTrabajo, descripcion, vendedor = '', ordenCompra = '', nombreTecnico = '', empresaId = '', firmaTecnico = '', firmaCliente = '' } = req.body;
        if (!siteId || !folio || !nombreTrabajo || !descripcion) {
            return res.status(400).json({ error: 'siteId, folio, nombreTrabajo y descripcion son requeridos' });
        }

        const site = await dbCollection('sites').findOne(idFilter(siteId));
        const now = new Date();
        const ticket = {
            _id: new mongoose.Types.ObjectId().toString(),
            siteId: String(siteId),
            nombreCliente: site?.nombre || '',
            folio: String(folio),
            nombreTrabajo: String(nombreTrabajo),
            titulo: String(nombreTrabajo),
            descripcion: String(descripcion),
            vendedor: String(vendedor),
            ordenCompra: String(ordenCompra),
            nombreTecnico: String(nombreTecnico),
            empresaId: empresaId ? String(empresaId) : '',
            firmaTecnico: firmaTecnico || '',
            firmaCliente: firmaCliente || '',
            fotos: uploadedPhotos(req.files),
            estado: 'terminado',
            createdAt: now,
            updatedAt: now,
        };
        await dbCollection('tickets').insertOne(ticket);
        emitTicket('new_ticket', ticket);
        res.status(201).json(publicDocument(ticket));
    } catch (error) {
        res.status(500).json({ error: `No se pudo crear el entregable: ${error.message}` });
    }
});

// PUT /api/tickets/:id — actualizar datos del entregable y, opcionalmente, cliente
app.put('/api/tickets/:id', uploadEntregables.none(), async (req, res) => {
    try {
        const { folio, nombreTrabajo, descripcion, vendedor = '', ordenCompra = '', nombreTecnico = '', siteId } = req.body;
        if (!folio || !nombreTrabajo || !descripcion) {
            return res.status(400).json({ error: 'folio, nombreTrabajo y descripcion son requeridos' });
        }
        const patch = { folio: String(folio), nombreTrabajo: String(nombreTrabajo), titulo: String(nombreTrabajo), descripcion: String(descripcion), vendedor: String(vendedor), ordenCompra: String(ordenCompra), nombreTecnico: String(nombreTecnico), updatedAt: new Date() };
        if (siteId) {
            const site = await dbCollection('sites').findOne(idFilter(siteId));
            patch.siteId = String(siteId);
            patch.nombreCliente = site?.nombre || '';
        }
        const result = await dbCollection('tickets').findOneAndUpdate(idFilter(req.params.id), { $set: patch }, { returnDocument: 'after' });
        const updated = resultValue(result);
        if (!updated) return res.status(404).json({ error: 'Entregable no encontrado' });
        emitTicket('ticket_updated', updated);
        res.json(publicDocument(updated));
    } catch (error) {
        res.status(500).json({ error: `No se pudo actualizar el entregable: ${error.message}` });
    }
});

// DELETE /api/tickets/:id — eliminar entregable completo
app.delete('/api/tickets/:id', async (req, res) => {
    try {
        const result = await dbCollection('tickets').findOneAndDelete(idFilter(req.params.id));
        const deleted = resultValue(result);
        if (!deleted) return res.status(404).json({ error: 'Entregable no encontrado' });
        emitTicket('ticket_deleted', deleted);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: `No se pudo eliminar el entregable: ${error.message}` });
    }
});

// POST /api/tickets/:id/photos — adjuntar más evidencias
app.post('/api/tickets/:id/photos', uploadEntregables.array('fotos', 15), async (req, res) => {
    try {
        const photos = uploadedPhotos(req.files);
        if (!photos.length) return res.status(400).json({ error: 'Debes adjuntar al menos una foto' });
        const result = await dbCollection('tickets').findOneAndUpdate(
            idFilter(req.params.id),
            { $push: { fotos: { $each: photos } }, $set: { updatedAt: new Date() } },
            { returnDocument: 'after' }
        );
        const updated = resultValue(result);
        if (!updated) return res.status(404).json({ error: 'Entregable no encontrado' });
        emitTicket('ticket_updated', updated);
        res.json(publicDocument(updated));
    } catch (error) {
        res.status(500).json({ error: `No se pudieron subir las fotos: ${error.message}` });
    }
});

// DELETE /api/tickets/:id/photos/:index — retirar una evidencia
app.delete('/api/tickets/:id/photos/:index', async (req, res) => {
    try {
        const ticket = await dbCollection('tickets').findOne(idFilter(req.params.id));
        if (!ticket) return res.status(404).json({ error: 'Entregable no encontrado' });
        const index = Number.parseInt(req.params.index, 10);
        if (!Number.isInteger(index) || index < 0 || index >= (ticket.fotos || []).length) {
            return res.status(400).json({ error: 'Índice de foto inválido' });
        }
        const fotos = [...ticket.fotos]; fotos.splice(index, 1);
        const result = await dbCollection('tickets').findOneAndUpdate(idFilter(req.params.id), { $set: { fotos, updatedAt: new Date() } }, { returnDocument: 'after' });
        const updated = resultValue(result);
        emitTicket('ticket_updated', updated);
        res.json(publicDocument(updated));
    } catch (error) {
        res.status(500).json({ error: `No se pudo eliminar la foto: ${error.message}` });
    }
});

// POST /api/tickets/:id/clear-signature — habilita nuevamente la firma remota
app.post('/api/tickets/:id/clear-signature', async (req, res) => {
    try {
        const result = await dbCollection('tickets').findOneAndUpdate(idFilter(req.params.id), { $set: { firmaCliente: '', updatedAt: new Date() } }, { returnDocument: 'after' });
        const updated = resultValue(result);
        if (!updated) return res.status(404).json({ error: 'Entregable no encontrado' });
        emitTicket('ticket_updated', updated);
        res.json(publicDocument(updated));
    } catch (error) {
        res.status(500).json({ error: `No se pudo borrar la firma: ${error.message}` });
    }
});



// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ ok: true, servicio: 'Email Server', puerto: PORT, ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    process.stdout.write(`[EMAIL SERVER] ✅ Servidor de correo corriendo en http://localhost:${PORT}\n`);
});
