require('dotenv').config();

// Registro de diagnóstico en memoria
const waLog = {
    ultimoError: null,
    ultimaActividad: null,
    ultimoMensaje: null,
    historial: [],
    errores: [],   // Log de errores reales con stack
    add(msg) {
        const ts = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
        this.historial.unshift(`[${ts}] ${msg}`);
        if (this.historial.length > 30) this.historial.pop();
    },
    addError(label, err) {
        const ts = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
        const entry = `[${ts}] ❌ ${label}: ${err && err.message ? err.message : String(err)}${err && err.stack ? '\n' + err.stack.split('\n').slice(1,4).join('\n') : ''}`;
        this.errores.unshift(entry);
        if (this.errores.length > 50) this.errores.pop();
        this.ultimoError = entry;
        this.historial.unshift(`[${ts}] ❌ ERROR: ${label}: ${err && err.message ? err.message.substring(0,80) : String(err).substring(0,80)}`);
        if (this.historial.length > 30) this.historial.pop();
    }
};

// Redirigir console.error y console.warn al waLog (no silenciarlos)
console.log = function() {};
console.info = function() {};
console.warn = function(...args) {
    waLog.add(`⚠️ [warn] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').substring(0,120)}`);
};
console.error = function(...args) {
    const msg = args.map(a => {
        if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack.split('\n').slice(1,4).join('\n') : '');
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
    }).join(' ');
    const ts = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    const entry = `[${ts}] ❌ ${msg}`;
    waLog.errores.unshift(entry);
    if (waLog.errores.length > 50) waLog.errores.pop();
    waLog.ultimoError = entry;
    waLog.historial.unshift(`[${ts}] ❌ ${msg.substring(0,100)}`);
    if (waLog.historial.length > 30) waLog.historial.pop();
};

// Errores conocidos y transitorios de Puppeteer/WhatsApp Web que se pueden ignorar
const PUPPETEER_IGNORABLE_ERRORS = [
    'Execution context was destroyed',
    'Session closed',
    'Target closed',
    'Protocol error',
    'Cannot find context with specified id',
    'Navigating frame was detached',
    // Errores transitorios de MongoDB Atlas (elección de primary / failover)
    'primary marked stale',
    'No primary found',
    'Server selection timed out',
    'connection timed out',
    'ECONNRESET',
    'ECONNREFUSED',
];
const isPuppeteerNoise = (err) => {
    const msg = (err && err.message) ? err.message : String(err);
    return PUPPETEER_IGNORABLE_ERRORS.some(e => msg.includes(e));
};

// Capturar errores no manejados globalmente
process.on('uncaughtException', async (err) => {
    if (isPuppeteerNoise(err)) return; // ignorar ruido de Puppeteer
    
    // ENOENT del ZIP = /app era read-only. Ahora usamos /tmp, no debe ocurrir.
    // NO borrar la sesión de MongoDB — puede ser válida y recuperable.
    if (err.code === 'ENOENT' && err.message && err.message.includes('RemoteAuth')) {
        waLog.add('⚠️ ZIP de sesión no encontrado en disco (ENOENT). Reiniciando bot para reintentar...');
        waStatus = 'DESCONECTADO';
        waReady = false;
        waInitializing = false;
        try {
            if (waClient) { try { await waClient.destroy(); } catch(_) {} waClient = null; }
        } catch(_) {}
        setTimeout(() => process.exit(1), 3000);
        return; // NO borrar MongoDB — la sesión puede seguir siendo válida
    }
    
    waLog.addError('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
    if (isPuppeteerNoise(reason)) return; // ignorar ruido de Puppeteer
    waLog.addError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// Variable global para el cliente
let waClient = null;
let waReady = false;
let waHealthCheckInterval = null;

// Función global para enviar mensajes

// ─── INFERIDOR DE GÉNERO POR NOMBRE ─────────────────────────────────────────
const NOMBRES_FEMENINOS = new Set([
    'sofia','sofía','maria','maría','ana','laura','gabriela','isabel','patricia',
    'alejandra','andrea','monica','mónica','rosa','carmen','lucía','lucia',
    'fernanda','daniela','valeria','victoria','cristina','elena','beatriz',
    'claudia','mariana','veronica','verónica','irene','silvia','esperanza',
    'yolanda','alicia','martha','marta','susana','adriana','rebeca','jaqueline',
    'jacqueline','lorena','diana','paula','sara','blanca','leticia','eva',
    'gloria','lourdes','pilar','concepcion','concepción','dolores','amparo',
    'antonia','francisca','josefa','natalia','esther','julia','teresa','raquel',
    'celia','consuelo','marisol','maribel','griselda','lidia','norma','karla',
    'karina','nadia','wendy','brenda','paola','alejandrina','guadalupe','lupe',
    'rocio','rocío','miriam','mirna','elsa','araceli','fabiola','vanessa'
]);
const NOMBRES_MASCULINOS = new Set([
    'daniel','carlos','juan','jose','josé','miguel','luis','antonio','francisco',
    'pedro','jesus','jesús','manuel','jorge','alejandro','roberto','david',
    'eduardo','ricardo','fernando','sergio','mario','rafael','victor','víctor',
    'alberto','oscar','óscar','hector','héctor','raul','raúl','arturo','pablo',
    'felipe','andres','andrés','enrique','guillermo','javier','gerardo','ernesto',
    'gabriel','rodrigo','alejandro','ivan','iván','martin','martín','omar','hugo',
    'armando','alfredo','diego','ignacio','antonio','edgar','cesar','césar',
    'benjamin','benjamín','samuel','santiago','adam','adan','adrián','adrian',
    'alan','alexis','angel','ángel','benito','beto','chuy','dario','darío',
    'efrain','efraín','emilio','erick','erik','ezequiel','fabian','fabián',
    'fidel','frank','freddy','gilberto','gonzalo','gustavo','heberto','hilario',
    'jaime','jonatan','jonathan','kevin','leo','leonel','lino','lucas','marco',
    'marcos','maximiliano','memo','nahum','noe','noé','octavio','oswaldo',
    'ramiro','rene','rené','reynaldo','roberto','rogelio','roque','ruben','rubén',
    'salvador','simon','simón','tomas','tomás','ulises','uriel','willian','william'
]);

function inferirGenero(nombre) {
    if (!nombre) return 'masculino'; // fallback
    // Tomar el primer nombre si hay varios
    const primerNombre = nombre.trim().split(/[\s,]+/)[0].toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quitar acentos para comparar
    if (NOMBRES_FEMENINOS.has(primerNombre)) return 'femenino';
    if (NOMBRES_MASCULINOS.has(primerNombre)) return 'masculino';
    // Heurística de terminación: nombres en -a tienden a ser femeninos
    if (primerNombre.endsWith('a') && !['mia','luca'].includes(primerNombre)) return 'femenino';
    return 'masculino'; // fallback
}
// ────────────────────────────────────────────────────────────────────────────

async function sendWhatsAppMessage(to, body, opciones = {}) { console.log('[DUMMY WA] Mensaje a ' + to); }

async function sendWhatsAppMedia(to, mediaObj, caption = '') { console.log('[DUMMY WA MEDIA] a ' + to); }
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Asegurar que el directorio de archivos exista (necesario en Render y otros servidores)
const ARCHIVOS_DIR = path.join(__dirname, 'public', 'archivos');
if (!fs.existsSync(ARCHIVOS_DIR)) {
    fs.mkdirSync(ARCHIVOS_DIR, { recursive: true });
    // console.log('📁 Directorio /public/archivos creado automáticamente');
}

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB max por archivo
});

const app = express();
const PORT = process.env.PORT || 4000; // Puerto CRM local

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});
global.io = io; // Expose io globally to routes

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://jarvis:Hola2025@cluster0.jih3lub.mongodb.net/naisata_db?appName=Cluster0';

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    heartbeatFrequencyMS: 10000,
    socketTimeoutMS: 45000,
})
    .then(() => console.log('✅ CRM Conectado a MongoDB exitosamente'))
    .catch(err => console.error('❌ Error conectando a MongoDB desde CRM:', err.message));


// --- Schemas (Específicos para CRM/ERP) ---

// Schemas para lectura cruzada desde la DB principal (Tracking App)
const VehicleTransactionRefSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    vehicleId: { type: String, ref: 'VehicleRef' },
    userId: String,
    userName: String,
    tipoMovimiento: String,
    proyectoId: String,
    notas: String,
    checklist: Object,
    checklistNotas: String,
    imgReporteDanos: String,
    estadoConfirmacion: String,
    fecha: Date,
    fechaFirma: Date,
    nivelesReportados: String
}, { collection: 'vehicletransactions' });
const VehicleRefSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    placas: String, modelo: String, marca: String, estado: String, destinoSugeridoCRM: String, crmActividadId: String, crmProyectoId: String
}, { collection: 'vehicles' });
const InvTransactionRefSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    itemId: { type: String, ref: 'InvItemRef' }, // String en lugar de ObjectId (migración BD)
    tipoMovimiento: String, cantidad: Number, responsable: String, proyectoId: String, fecha: Date
}, { collection: 'inventorytransactions' });
const InvItemRefSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    nombre: String, tipo: String
}, { collection: 'inventoryitems' });
const UserRefSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    nombre: String, apellido: String, telefono: String,
    correo: String, password: String, rol: String, estadoCuenta: String, tokenPortal: String,
    categoria: { type: String, enum: ['Electricidad', 'Voz y Datos', 'Aires Acondicionados', 'Aislamiento', 'Tablaroca'], default: '' },
    sueldoBase: { type: Number, default: 0 }
}, { collection: 'users' });

// Schema de lectura cruzada: Tickets/Entregables de la app principal
const TicketRefSchema = new mongoose.Schema({
    _id: { type: String },
    siteId: String,
    proyectoId: String, // Algunos tickets tienen referencia directa al proyecto
    firmaTecnico: String,
    firmaCliente: String, // Si tiene valor = entregable firmado
    nombreCliente: String,
    folio: String,
    estado: String
}, { collection: 'tickets' });

const VehicleTransactionRef = mongoose.model('VehicleTransactionRef', VehicleTransactionRefSchema);
const VehicleRef = mongoose.model('VehicleRef', VehicleRefSchema);
const InvTransactionRef = mongoose.model('InvTransactionRef', InvTransactionRefSchema);
const InvItemRef = mongoose.model('InvItemRef', InvItemRefSchema);
const UserRef = mongoose.model('UserRef', UserRefSchema);
const TicketRef = mongoose.model('TicketRef', TicketRefSchema);

// --- Client Portal Schema ---
const CRMClientePortalSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    nombre: { type: String, required: true },
    telefono: { type: String },
    empresa: String,
    correo: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    aprobado: { type: Boolean, default: false },
    token: String,
    fechaRegistro: { type: Date, default: Date.now }
});
const CRMClientePortal = mongoose.model('CRMClientePortal', CRMClientePortalSchema);

const CRMCotizacionSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    folio: { type: String, unique: true, sparse: true },
    clienteId: String,
    clienteNombre: String,
    vendedorId: String,
    descripcion: String,
    lugarEjecucion: String,
    contacto: String,
    categoria: { type: String, enum: ['Electricidad', 'Voz y Datos', 'Aires Acondicionados', 'Aislamiento', 'Tablaroca'] },
    condiciones: String,
    notas: String,
    creadorNombre: String,
    creadorCorreo: String,
    creadorTelefono: String,
    estado: { 
        type: String, 
        enum: ['Neutral', 'Levantamiento', 'Cotizando', 'En Seguimiento', 'Aprobado', 'Perdido', 'Perdida', 'Terminada', 'Cerrada', 'En Proceso', 'Ganada'], 
        default: 'Neutral' 
    },
    partidas: [{
        descripcion: String,
        cantidad: Number,
        um: String,
        precioUnitario: Number,
        total: Number
    }],
    subtotal: Number,
    iva: Number,
    total: Number,
    productosSugeridos: [{
        cantidad: Number,
        numeroParte: String,
        marca: String,
        descripcion: String,
        costo: Number
    }],
    fechaCreacion: { type: Date, default: Date.now },
    fechaSeguimiento: Date,
    requiereRevision: { type: Boolean, default: false },
    proyectoActivoId: String, // Se llena cuando se aprueba y pasa a ERP
    archivos: [String], // URLs de documentos adjuntos (planos, fotos, PDFs del cliente)
    accesosPortal: [String], // IDs de clientes del portal con acceso
    permisosPortalModificacion: [String], // IDs de clientes con permiso para modificar
    cotizacionOriginalId: String, // Referencia a la original si esta es copia modificada
    esModificadaPorCliente: { type: Boolean, default: false } // Bandera de si fue hecha por cliente
});
const CRMCotizacion = mongoose.model('CRMCotizacion', CRMCotizacionSchema);

const CRMProyectoSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    cotizacionId: String, // Referencia a la cotización original
    folio: String, // Identificador de proyecto heredado o nuevo
    nombre: String,
    clienteId: String,
    clienteNombre: String,
    residenteId: String, // Encargado
    trabajadoresAsignados: [String],
    vehiculosAsignados: [String],
    estado: { type: String, enum: ['Activo', 'Pausado', 'Terminado', 'Cancelado', 'Terminada', 'Cerrada'], default: 'Activo' },
    fechaInicio: { type: Date, default: Date.now },
    fechaFin: Date,
    // Finanzas
    facturas: [{
        folio: String,
        descripcion: String,
        monto: Number,
        tipo: { type: String, enum: ['Ingreso', 'Egreso'] },
        archivoUrl: String, // PDF o Imagen
        fecha: { type: Date, default: Date.now }
    }],
    porcentajeAvance: { type: Number, default: 0 },
    avances: [{
        fecha: { type: Date, default: Date.now },
        empleado: String,
        porcentaje: Number,
        porcentajeProyecto: Number,
        comentario: String,
        fotos: [String]
    }],
    // Historial Diario / Bitácora
    bitacoraDiaria: [{
        fecha: Date,
        descripcion: String,
        personalAsistente: [String], // Quiénes fueron ese día
        vehiculosUtilizados: [String], // Qué carros se llevaron
        fotos: [String]
    }],
    archivos: [String], // IDs de documentos CRMArchivo en MongoDB
    accesosPortal: [String] // IDs de clientes con acceso de solo lectura al panel operativo
});
const CRMProyecto = mongoose.model('CRMProyecto', CRMProyectoSchema);

// Schema para almacenar archivos/imágenes en MongoDB (Base64)
const CRMArchivoSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    nombre: String,
    contentType: String,
    datos: String, // Base64
    tamanio: Number,
    fechaSubida: { type: Date, default: Date.now }
});
const CRMArchivo = mongoose.model('CRMArchivo', CRMArchivoSchema);

const CRMActividadSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    descripcion: String,
    asignadoAId: String, 
    asignadoANombre: String,
    cuadrillaNombres: [String],
    vehiculosAsignados: [String],
    herramientasAsignadas: Array,
    tipoDestino: String,
    proyectoId: String,
    estado: { type: String, enum: ['Pendiente', 'En Camino', 'En Sitio', 'En Progreso', 'Completada'], default: 'Pendiente' },
    fechaVencimiento: Date,
    horaInicio: String,  // "09:00" formato HH:MM
    horaFin: String,     // "13:00" formato HH:MM (opcional)
    avanceReportado: { type: Boolean, default: false },
    comentarioCierre: String,
    porcentajeAvance: { type: Number, default: 0 },
    avances: [{
        fecha: { type: Date, default: Date.now },
        empleado: String,
        porcentaje: Number,
        comentario: String,
        fotos: [String]
    }],
    fechaCreacion: { type: Date, default: Date.now }
});
const CRMActividad = mongoose.model('CRMActividad', CRMActividadSchema);

const CRMEventoSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    tipo: { type: String, enum: ['Junta', 'Levantamiento', 'Llamada', 'Otro'], default: 'Junta' },
    titulo: String,
    descripcion: String,
    fechaInicio: Date,
    fechaFin: Date,
    participantes: [String],
    vehiculosAsignados: [String],
    recordatorioEnviado: { type: Boolean, default: false },
    fechaCreacion: { type: Date, default: Date.now }
});
const CRMEvento = mongoose.model('CRMEvento', CRMEventoSchema);

const CRMAjustesSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    tipo: { type: String, default: 'general' },
    logoBase64: String,
    folioInicio: { type: Number, default: 1 },
    metaAnual: { type: Number, default: 5000000 }
});
const CRMAjustes = mongoose.model('CRMAjustes', CRMAjustesSchema);

// --- Finanzas Schemas ---
const CRMFinanzasNominaSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    empleadoId: String,
    empleadoNombre: String,
    monto: Number,
    periodo: String,
    tipoPago: { type: String, enum: ['Sueldo', 'Bono', 'Adelanto'], default: 'Sueldo' },
    semanasAdelantadas: { type: Number, default: 1 },
    proyectoId: String,
    proyectoNombre: String,
    estatus: { type: String, enum: ['Pendiente', 'Pagado', 'Programado'], default: 'Pendiente' },
    fechaProgramada: Date,
    comprobanteUrl: String,
    fechaPago: Date,
    fechaCreacion: { type: Date, default: Date.now }
});
const CRMFinanzasNomina = mongoose.model('CRMFinanzasNomina', CRMFinanzasNominaSchema);

const CRMFinanzasGastoSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    categoria: { type: String, enum: ['Renta', 'Servicios', 'Mantenimiento', 'Viáticos', 'Materiales', 'Otros'] },
    descripcion: String,
    monto: Number,
    responsable: String,
    proyectoId: String,
    proyectoNombre: String,
    comprobanteUrl: String,
    fechaGasto: { type: Date, default: Date.now },
    fechaCreacion: { type: Date, default: Date.now }
});
const CRMFinanzasGasto = mongoose.model('CRMFinanzasGasto', CRMFinanzasGastoSchema);

// Helper: obtener el siguiente número de folio disponible
async function getNextFolioNumber() {
    const ajustes = await CRMAjustes.findOne({ tipo: 'general' });
    const folioInicio = ajustes?.folioInicio || 1;
    // Buscar el mayor número de folio existente con formato C1, C2... o legacy C-NNN
    const cots = await CRMCotizacion.find({ folio: { $regex: /^C\d+$|^C-\d+$/ } }).select('folio');
    let maxNum = folioInicio - 1;
    cots.forEach(c => {
        const num = parseInt(c.folio.replace('C-', '').replace('C', ''), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
    });
    return Math.max(maxNum + 1, folioInicio);
}

// --- PriceList Schema for Tabulador de Precios (CRM compatibility)
const PriceListItemSchema = new mongoose.Schema({
    descripcion: { type: String, required: true },
    cantidad: { type: Number, default: 1 },
    precio: { type: Number, default: 0 }
}, { _id: false });

const PriceListSchema = new mongoose.Schema({
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    siteId: { type: String, required: true, index: true, ref: 'Site' },
    nombre: { type: String, required: true },
    items: { type: [PriceListItemSchema], default: [] },
    createdBy: { type: String, default: null }
}, { timestamps: true });


// ============================================================================
// ENDPOINTS DE CLIENTES (SITES)
// ============================================================================
app.get('/api/sites', async (req, res) => {
    try {
        const sites = await mongoose.connection.collection('sites').find({}).sort({ nombre: 1 }).toArray();
        res.json(sites.map(s => {
            if(s._id) { s.id = s._id.toString(); delete s._id; }
            return s;
        }));
    } catch (error) {
        console.error('Error fetching sites:', error);
        res.status(500).json({ error: 'No se pudieron obtener los clientes.' });
    }
});

app.post('/api/sites', upload.single('logo'), async (req, res) => {
    try {
        const { nombre, ubicacion, empresaId } = req.body;
        if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
        
        let logoBase64 = null;
        if (req.file) {
            logoBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        }

        const newSite = {
            nombre,
            ubicacion: ubicacion || '',
            empresaId: empresaId || '',
            logo: logoBase64,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await mongoose.connection.collection('sites').insertOne(newSite);
        const created = await mongoose.connection.collection('sites').findOne({ _id: result.insertedId });
        if(created._id) { created.id = created._id.toString(); delete created._id; }
        
        try { if (typeof io !== 'undefined' && io && typeof io.emit === 'function') io.emit('site_updated', created); } catch(_) {}
        res.status(201).json(created);
    } catch (error) {
        console.error('Error creating site:', error);
        res.status(500).json({ error: 'Error al crear cliente' });
    }
});

app.put('/api/sites/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, ubicacion, empresaId } = req.body;
        
        const patch = { updatedAt: new Date() };
        if (nombre) patch.nombre = nombre;
        if (ubicacion !== undefined) patch.ubicacion = ubicacion;
        if (empresaId !== undefined) patch.empresaId = empresaId;

        const result = await mongoose.connection.collection('sites').findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(id) },
            { $set: patch },
            { returnDocument: 'after' }
        );
        
        if (!result) return res.status(404).json({ error: 'Cliente no encontrado' });
        if(result._id) { result.id = result._id.toString(); delete result._id; }
        
        try { if (typeof io !== 'undefined' && io && typeof io.emit === 'function') io.emit('site_updated', result); } catch(_) {}
        res.json(result);
    } catch (error) {
        console.error('Error updating site:', error);
        res.status(500).json({ error: 'Error al actualizar cliente' });
    }
});

app.put('/api/sites/:id/logo', upload.single('logo'), async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.file) return res.status(400).json({ error: 'Logo no proporcionado' });
        
        const logoBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        
        const result = await mongoose.connection.collection('sites').findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(id) },
            { $set: { logo: logoBase64, updatedAt: new Date() } },
            { returnDocument: 'after' }
        );
        
        if (!result) return res.status(404).json({ error: 'Cliente no encontrado' });
        if(result._id) { result.id = result._id.toString(); delete result._id; }
        
        try { if (typeof io !== 'undefined' && io && typeof io.emit === 'function') io.emit('site_updated', result); } catch(_) {}
        res.json(result);
    } catch (error) {
        console.error('Error updating site logo:', error);
        res.status(500).json({ error: 'Error al actualizar logo' });
    }
});

app.delete('/api/sites/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await mongoose.connection.collection('sites').findOneAndDelete({ _id: new mongoose.Types.ObjectId(id) });
        if (!result) return res.status(404).json({ error: 'Cliente no encontrado' });
        
        try { if (typeof io !== 'undefined' && io && typeof io.emit === 'function') io.emit('site_deleted', { id }); } catch(_) {}
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting site:', error);
        res.status(500).json({ error: 'Error al eliminar cliente' });
    }
});
// ============================================================================


const PriceList = mongoose.models.PriceList || mongoose.model('PriceList', PriceListSchema);

// PriceList Endpoints (CRUD) - compatible con /api/sites/:siteId/pricelists
app.get('/api/sites/:siteId/pricelists', async (req, res) => {
    try {
        const { siteId } = req.params;
        const lists = await PriceList.find({ siteId }).sort({ createdAt: -1 }).lean();
        const mapped = lists.map(l => ({ ...l, id: l._id.toString() }));
        res.json(mapped);
    } catch (e) {
        console.error('Error getting pricelists (CRM):', e);
        res.status(500).json({ error: 'Error obteniendo listas de precios.' });
    }
});

app.get('/api/sites/:siteId/pricelists/:id', async (req, res) => {
    try {
        const { siteId, id } = req.params;
        const list = await PriceList.findById(id).lean();
        if (!list || list.siteId !== siteId) return res.status(404).json({ error: 'Lista no encontrada para este cliente.' });
        res.json({ ...list, id: list._id.toString() });
    } catch (e) {
        console.error('Error getting pricelist (CRM):', e);
        res.status(500).json({ error: 'Error obteniendo la lista de precios.' });
    }
});

app.post('/api/sites/:siteId/pricelists', async (req, res) => {
    try {
        const { siteId } = req.params;
        const { nombre, items, createdBy } = req.body;
        if (!nombre) return res.status(400).json({ error: 'El nombre de la lista es requerido.' });

        const newList = new PriceList({ siteId, nombre, items: Array.isArray(items) ? items : [], createdBy: createdBy || null });
        await newList.save();
        const responseObj = { ...newList.toObject(), id: newList._id.toString() };
        // Emit socket event if available (non-fatal)
        try { if (typeof io !== 'undefined' && io && typeof io.emit === 'function') io.emit('pricelist_created', responseObj); } catch(_) {}
        res.status(201).json(responseObj);
    } catch (e) {
        console.error('Error creating pricelist (CRM):', e);
        res.status(500).json({ error: 'Error creando la lista de precios.' });
    }
});

app.put('/api/sites/:siteId/pricelists/:id', async (req, res) => {
    try {
        const { siteId, id } = req.params;
        const { nombre, items } = req.body;
        const list = await PriceList.findById(id);
        if (!list || list.siteId !== siteId) return res.status(404).json({ error: 'Lista no encontrada para este cliente.' });
        if (nombre) list.nombre = nombre;
        if (items && Array.isArray(items)) list.items = items;
        await list.save();
        const responseObj = { ...list.toObject(), id: list._id.toString() };
        try { if (typeof io !== 'undefined' && io && typeof io.emit === 'function') io.emit('pricelist_updated', responseObj); } catch(_) {}
        res.json(responseObj);
    } catch (e) {
        console.error('Error updating pricelist (CRM):', e);
        res.status(500).json({ error: 'Error actualizando la lista de precios.' });
    }
});

app.delete('/api/sites/:siteId/pricelists/:id', async (req, res) => {
    try {
        const { siteId, id } = req.params;
        const list = await PriceList.findById(id);
        if (!list || list.siteId !== siteId) return res.status(404).json({ error: 'Lista no encontrada para este cliente.' });
        await PriceList.findByIdAndDelete(id);
        try { if (typeof io !== 'undefined' && io && typeof io.emit === 'function') io.emit('pricelist_deleted', { id }); } catch(_) {}
        res.json({ message: 'Lista eliminada.' });
    } catch (e) {
        console.error('Error deleting pricelist (CRM):', e);
        res.status(500).json({ error: 'Error eliminando la lista de precios.' });
    }
});

// --- API Routes ---

// ==========================================
// PUENTE DE COMUNICACIÓN CON SERVER_BOT.JS
// ==========================================
app.post('/api/bridge/receive', (req, res) => {
    const token = req.headers['x-api-token'];
    // Validar token de seguridad (debe coincidir con el del bot)
    const SECRET = process.env.API_SECRET_TOKEN || 'tu_token_secreto_muy_seguro_123';
    
    if (token !== SECRET) {
        return res.status(401).json({ error: 'Acceso denegado al CRM: Token inválido' });
    }
    
    const data = req.body;
    console.log(`\n[CRM] 🤖 Notificación entrante del Bot Avanzado:`, data);
    
    // Aquí el CRM procesará la información que manda el bot (guardar historial, actualizar base de datos, etc)
    // ...

    res.json({ status: 'success', message: 'CRM recibió los datos del bot correctamente' });
});
// ==========================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'CRM Server is running' });
});

app.get('/api/ping', (req, res) => res.status(200).send('ok'));

// Endpoint de diagnóstico — verifica estado de la conexión a MongoDB
app.get('/api/debug/status', (req, res) => {
    const estados = { 0: 'desconectado', 1: 'conectado', 2: 'conectando', 3: 'desconectando' };
    const dbState = mongoose.connection.readyState;
    res.json({
        server: 'OK',
        mongodb: estados[dbState] || `estado-${dbState}`,
        mongodbReadyState: dbState,
        uri_source: process.env.MONGODB_URI ? 'variable de entorno' : 'hardcoded',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/usuarios', async (req, res) => {
    try {
        const users = await UserRef.find().select('nombre apellido telefono').sort('nombre');
        res.json(users);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Obtener perfil de usuario por ID (incluye `categoria`)
app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await UserRef.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(user);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Actualizar la categoría del usuario (DB-only)
app.put('/api/users/:id/categoria', async (req, res) => {
    try {
        const { categoria } = req.body;
        if (!categoria) return res.status(400).json({ error: 'Falta el campo categoria' });
        const updated = await UserRef.findOneAndUpdate(
            { _id: req.params.id },
            { $set: { categoria } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        res.json(updated);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/test-phones', async (req, res) => {
    try {
        const users = await mongoose.connection.db.collection('users').find({}).toArray();
        res.json(users);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vehiculos/disponibles', async (req, res) => {
    try {
        // Obtenemos todos los vehiculos. El admin elegirá
        const vehs = await VehicleRef.find().select('placas modelo marca destinoSugeridoCRM').sort('modelo');
        res.json(vehs);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Rutas de Ajustes (Logo)
app.get('/api/ajustes/logo', async (req, res) => {
    try {
        const ajustes = await CRMAjustes.findOne({ tipo: 'general' });
        res.json({ logo: ajustes ? ajustes.logoBase64 : null });
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/ajustes/logo', async (req, res) => {
    try {
        const { logoBase64 } = req.body;
        let ajustes = await CRMAjustes.findOne({ tipo: 'general' });
        if (!ajustes) {
            ajustes = new CRMAjustes({ tipo: 'general', logoBase64 });
        } else {
            ajustes.logoBase64 = logoBase64;
        }
        await ajustes.save();
        res.json({ message: 'Logo guardado con éxito' });
    } catch(err) { res.status(500).json({error: err.message}); }
});

// Rutas de Ajustes (Folio)
app.get('/api/ajustes/folio', async (req, res) => {
    try {
        const ajustes = await CRMAjustes.findOne({ tipo: 'general' });
        res.json({ folioInicio: ajustes?.folioInicio || 1 });
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/ajustes/folio', async (req, res) => {
    try {
        const { folioInicio } = req.body;
        const num = parseInt(folioInicio, 10);
        if (isNaN(num) || num < 1) return res.status(400).json({ error: 'Número inválido' });
        let ajustes = await CRMAjustes.findOne({ tipo: 'general' });
        if (!ajustes) {
            ajustes = new CRMAjustes({ tipo: 'general', folioInicio: num });
        } else {
            ajustes.folioInicio = num;
        }
        await ajustes.save();
        res.json({ message: `Folio inicial configurado a ${num}` });
    } catch(err) { res.status(500).json({error: err.message}); }
});

// Rutas de Ajustes (Meta Anual)
app.get('/api/ajustes/meta', async (req, res) => {
    try {
        const ajustes = await CRMAjustes.findOne({ tipo: 'general' });
        res.json({ metaAnual: ajustes?.metaAnual || 5000000 });
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/ajustes/meta', async (req, res) => {
    try {
        const { metaAnual } = req.body;
        const num = parseFloat(metaAnual);
        if (isNaN(num) || num < 1) return res.status(400).json({ error: 'Número inválido' });
        let ajustes = await CRMAjustes.findOne({ tipo: 'general' });
        if (!ajustes) {
            ajustes = new CRMAjustes({ tipo: 'general', metaAnual: num });
        } else {
            ajustes.metaAnual = num;
        }
        await ajustes.save();
        res.json({ message: `Meta anual configurada a $${num}` });
    } catch(err) { res.status(500).json({error: err.message}); }
});

// ==========================================
// ENDPOINTS FINANZAS
// ==========================================

app.get('/api/finanzas/resumen', async (req, res) => {
    try {
        const nominas = await CRMFinanzasNomina.find();
        const gastos = await CRMFinanzasGasto.find();
        
        let totalNominas = 0;
        let nominasPendientes = 0;
        nominas.forEach(n => {
            totalNominas += n.monto || 0;
            if (n.estatus === 'Pendiente') nominasPendientes += n.monto || 0;
        });

        let totalGastos = 0;
        gastos.forEach(g => {
            totalGastos += g.monto || 0;
        });

        res.json({
            totalNominas,
            nominasPendientes,
            totalGastos,
            balance: - (totalNominas + totalGastos)
        });
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.get('/api/finanzas/gastos', async (req, res) => {
    try {
        const gastos = await CRMFinanzasGasto.find().sort({ fechaGasto: -1 });
        res.json(gastos);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/finanzas/gastos', async (req, res) => {
    try {
        const nuevo = new CRMFinanzasGasto(req.body);
        await nuevo.save();
        res.json(nuevo);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.get('/api/finanzas/nominas', async (req, res) => {
    try {
        const nominas = await CRMFinanzasNomina.find().sort({ fechaCreacion: -1 });
        res.json(nominas);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/finanzas/nominas', async (req, res) => {
    try {
        const nuevo = new CRMFinanzasNomina(req.body);
        await nuevo.save();
        res.json(nuevo);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/finanzas/nominas/pago-rapido', async (req, res) => {
    try {
        const { empleadoId, empleadoNombre, monto, periodo } = req.body;
        const nuevo = new CRMFinanzasNomina({
            empleadoId, empleadoNombre, monto, periodo,
            tipoPago: 'Sueldo', semanasAdelantadas: 1, estatus: 'Pagado', fechaPago: new Date()
        });
        await nuevo.save();
        res.json(nuevo);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.put('/api/finanzas/nominas/:id', async (req, res) => {
    try {
        const updated = await CRMFinanzasNomina.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
        if (!updated) return res.status(404).json({ error: 'Nómina no encontrada' });
        res.json(updated);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.delete('/api/finanzas/gastos/:id', async (req, res) => {
    try {
        await CRMFinanzasGasto.findByIdAndDelete(req.params.id);
        res.json({ message: 'Gasto eliminado' });
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.delete('/api/finanzas/nominas/:id', async (req, res) => {
    try {
        await CRMFinanzasNomina.findByIdAndDelete(req.params.id);
        res.json({ message: 'Nómina eliminada' });
    } catch(err) { res.status(500).json({error: err.message}); }
});

// Rutas Empleados/Sueldos (Finanzas)
app.get('/api/finanzas/config-empleados', async (req, res) => {
    try {
        const users = await UserRef.find().select('nombre apellido correo rol sueldoBase').sort('nombre');
        res.json(users);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/finanzas/config-empleados/:id', async (req, res) => {
    try {
        const { sueldoBase } = req.body;
        const updated = await UserRef.findByIdAndUpdate(req.params.id, { sueldoBase: parseFloat(sueldoBase) || 0 }, { new: true });
        res.json(updated);
    } catch(err) { res.status(500).json({error: err.message}); }
});

// Rutas de Cotizaciones
app.get('/api/cotizaciones', async (req, res) => {
    try {
        const cots = await CRMCotizacion.find().sort({ fechaCreacion: -1 });
        res.json(cots);
    } catch(err) { res.status(500).json({error: err.message}); }
});

// Asignar folios a TODAS las cotizaciones que no lo tengan (debe ir ANTES de /:id)
app.post('/api/cotizaciones/asignar-folios-todos', async (req, res) => {
    try {
        const sinFolio = await CRMCotizacion.find({
            $or: [
                { folio: { $exists: false } },
                { folio: null },
                { folio: '' },
                { folio: 'Sin folio' }
            ]
        }).sort({ fechaCreacion: 1 });

        let count = 0;
        for (const cot of sinFolio) {
            const num = await getNextFolioNumber();
            cot.folio = `C${num}`;
            await cot.save();
            count++;
        }
        res.json({ message: `${count} cotizaciones actualizadas con folio.`, total: count });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cotizaciones/:id', async (req, res) => {
    try {
        const cot = await CRMCotizacion.findById(req.params.id);
        if (!cot) return res.status(404).json({ error: 'No encontrado' });
        res.json(cot);
    } catch(err) { res.status(500).json({error: err.message}); }
});

// Endpoint para buscar si una cotización tiene una versión de cliente
app.get('/api/cotizaciones/:id/version-cliente', async (req, res) => {
    try {
        // Buscar una cotización cuya cotizacionOriginalId sea la que pedimos
        const versionCliente = await CRMCotizacion.findOne({ cotizacionOriginalId: req.params.id }).sort({ fechaCreacion: -1 });
        if (!versionCliente) return res.status(404).json({ error: 'No se encontró versión de cliente' });
        res.json(versionCliente);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/cotizaciones', async (req, res) => {
    try {
        const data = req.body;

        // Generar folio único — si hay colisión por concurrencia, reintentamos
        const folioManual = data.folio && data.folio.trim() !== '' && data.folio !== 'Sin folio' && data.folio !== 'Asignación Automática';

        if (folioManual) {
            // Folio proporcionado manualmente: verificar que no esté en uso
            const existe = await CRMCotizacion.findOne({ folio: data.folio.trim() });
            if (existe) {
                return res.status(409).json({ error: `El folio "${data.folio.trim()}" ya está en uso. Se asignará uno automáticamente.` });
            }
            data.folio = data.folio.trim();
        } else {
            // Folio automático con protección ante colisión por concurrencia
            let intentos = 0;
            let folioGenerado;
            while (intentos < 5) {
                const num = await getNextFolioNumber();
                folioGenerado = `C${num}`;
                const existe = await CRMCotizacion.findOne({ folio: folioGenerado });
                if (!existe) break; // folio disponible
                intentos++;
            }
            data.folio = folioGenerado;
        }

        const newCotizacion = new CRMCotizacion(data);
        await newCotizacion.save();
        try { if (global.io) global.io.emit('cotizacion_creada', newCotizacion); } catch(_) {}
        res.json({ message: 'Cotización creada con éxito', data: newCotizacion });
    } catch(err) {
        if (err.code === 11000) {
            // Error de índice único en MongoDB (race condition extrema)
            return res.status(409).json({ error: 'El folio generado ya existe. Por favor intenta de nuevo.' });
        }
        res.status(500).json({error: err.message});
    }
});

app.put('/api/cotizaciones/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        
        // Prevent overwriting the folio with an empty string or default labels which trigger duplicate key E11000
        if (data.folio === '' || data.folio === 'Asignación Automática' || data.folio === 'Sin folio') {
            delete data.folio;
        }

        const updatedCot = await CRMCotizacion.findByIdAndUpdate(id, data, { returnDocument: 'after' });
        if (!updatedCot) return res.status(404).json({ error: 'Cotización no encontrada' });

        // Sincronizar la descripción en el Proyecto Operativo Activo (si existe)
        if (updatedCot.proyectoActivoId && data.descripcion !== undefined) {
            try {
                await CRMProyecto.findOneAndUpdate(
                    { folio: updatedCot.proyectoActivoId },
                    { descripcion: data.descripcion }
                );
            } catch (e) { console.error('Error sincronizando descripción al proyecto:', e); }
        }

        try { if (global.io) global.io.emit('cotizacion_actualizada', updatedCot); } catch(_) {}
        res.json({ message: 'Cotización actualizada con éxito', data: updatedCot });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar una cotización completa (acceso restringido a nivel de servidor)
app.delete('/api/cotizaciones/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cot = await CRMCotizacion.findById(id);
        if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

        // Verificar que la cotización no esté ligada a un proyecto operativo activo
        if (cot.proyectoActivoId) {
            return res.status(409).json({
                error: 'No se puede eliminar: esta cotización ya tiene un Proyecto Operativo activo vinculado.'
            });
        }

        // Eliminar archivos adjuntos en MongoDB si los hay
        if (cot.archivos && cot.archivos.length > 0) {
            for (const fileUrl of cot.archivos) {
                try {
                    const archivoId = fileUrl.split('/').pop();
                    await CRMArchivo.findByIdAndDelete(archivoId);
                } catch (_) { /* ignorar errores individuales de archivos */ }
            }
        }

        await CRMCotizacion.findByIdAndDelete(id);
        res.json({ message: `Cotización ${cot.folio || id} eliminada correctamente.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Subir archivos adjuntos a una cotización (planos, fotos, PDFs del cliente)
app.post('/api/cotizaciones/:id/archivos', upload.array('archivos', 10), async (req, res) => {
    try {
        const { id } = req.params;
        const cot = await CRMCotizacion.findById(id);
        if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
        if (!cot.archivos) cot.archivos = [];
        for (const file of req.files) {
            const archivo = new CRMArchivo({
                nombre: file.originalname,
                contentType: file.mimetype,
                datos: file.buffer.toString('base64'),
                tamanio: file.size
            });
            const saved = await archivo.save();
            cot.archivos.push(`/api/archivos/${saved._id}`);
        }
        await cot.save();
        res.json({ archivos: cot.archivos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar un archivo adjunto de una cotización
app.delete('/api/cotizaciones/:id/archivos/:archivoId', async (req, res) => {
    try {
        const { id, archivoId } = req.params;
        const cot = await CRMCotizacion.findById(id);
        if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
        cot.archivos = (cot.archivos || []).filter(u => !u.includes(archivoId));
        await cot.save();
        await CRMArchivo.findByIdAndDelete(archivoId);
        res.json({ archivos: cot.archivos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/cotizaciones/:id/estado', async (req, res) => {
    try {
        const { id } = req.params;
        const { estado } = req.body;
        
        const updatedCot = await CRMCotizacion.findByIdAndUpdate(id, { estado: estado }, { returnDocument: 'after' });
        if (!updatedCot) return res.status(404).json({ error: 'Cotización no encontrada' });
        
        res.json({ message: 'Estado actualizado', data: updatedCot });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Rutas de Proyectos
app.get('/api/proyectos', async (req, res) => {
    try {
        const proys = await CRMProyecto.find().sort({ fechaInicio: -1 });
        res.json(proys);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.post('/api/proyectos', async (req, res) => {
    try {
        const data = req.body;
        const count = await CRMProyecto.countDocuments();
        
        let folioFinal = `P${count + 1}`;
        
        // Asignar Folio heredado si existe
        if (data.cotizacionId) {
            const cot = await CRMCotizacion.findById(data.cotizacionId);
            if (cot && cot.folio) folioFinal = cot.folio;
            
            // Marcar cotizacion a "Ganada" si se pasa a proyectos operativos
            if (cot) {
                 cot.proyectoActivoId = folioFinal; 
                 cot.estado = 'Ganada';
                 await cot.save();
                 // Heredar documentos adjuntos de la cotización al proyecto
                 if (cot.archivos && cot.archivos.length > 0) {
                     data.archivos = cot.archivos;
                 }
            }
        }
        
        const newProy = new CRMProyecto({ ...data, folio: folioFinal });
        await newProy.save();
        res.json({ message: 'Proyecto creado con éxito', data: newProy });
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.put('/api/proyectos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;

        // Validación: Si se intenta cerrar/terminar, debe existir al menos un entregable firmado
        const ESTADOS_CIERRE = ['Terminada', 'Terminado', 'Cerrada', 'Cerrado', 'Cancelado'];
        if (data.estado && ESTADOS_CIERRE.includes(data.estado)) {
            const proyecto = await CRMProyecto.findById(id);
            if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

            // Se busca por: proyectoId directo, folio del proyecto, _id del proyecto o el campo folio del ticket
            const folioProyecto = proyecto.folio || '';
            const ticketQuery = {
                firmaCliente: { $exists: true, $ne: null, $ne: '' },
                $or: [
                    { proyectoId: id },
                    { proyectoId: folioProyecto },
                    { proyectoId: { $regex: folioProyecto, $options: 'i' } },
                    { folio: folioProyecto },
                    { folio: { $regex: folioProyecto, $options: 'i' } }
                ]
            };

            const ticketFirmado = await TicketRef.findOne(ticketQuery).select('_id folio firmaCliente');

            if (!ticketFirmado) {
                return res.status(422).json({
                    error: `No se puede cerrar el proyecto "${folioProyecto}" porque no tiene ningún entregable firmado por el cliente. Genera y solicita la firma del entregable en la sección de Tickets antes de cerrar.`
                });
            }

            // Segunda Validación: La suma de facturas debe igualar al total de la cotización (si existe cotización asociada)
            if (proyecto.cotizacionId) {
                const cotizacion = await CRMCotizacion.findById(proyecto.cotizacionId);
                if (cotizacion && (cotizacion.total || cotizacion.total === 0)) {
                    const sumaFacturas = (proyecto.facturas || []).reduce((acc, f) => acc + (f.monto || 0), 0);
                    
                    // Permitir margen de $1 por posibles diferencias de redondeo en decimales
                    if (Math.abs(sumaFacturas - cotizacion.total) > 1) {
                        return res.status(422).json({
                            error: `No se puede cerrar el proyecto. La suma de facturas ($${sumaFacturas.toLocaleString('es-MX', {minimumFractionDigits:2})}) no coincide con el monto total de la cotización ($${cotizacion.total.toLocaleString('es-MX', {minimumFractionDigits:2})}).`
                        });
                    }
                }
            }

            // Tercera Validación: El porcentaje de avance del proyecto debe ser 100%
            if (proyecto.porcentajeAvance !== 100) {
                return res.status(422).json({
                    error: `No se puede cerrar el proyecto. El porcentaje de avance actual es del ${proyecto.porcentajeAvance || 0}%. Debe estar al 100% para poder finalizarlo.`
                });
            }
        }

        const updatedProy = await CRMProyecto.findByIdAndUpdate(id, data, { returnDocument: 'after' });
        if (!updatedProy) return res.status(404).json({ error: 'Proyecto no encontrado' });
        res.json({ message: 'Proyecto actualizado con éxito', data: updatedProy });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/proyectos/:id/recursos', async (req, res) => {
    try {
        const proj = await CRMProyecto.findById(req.params.id);
        if (!proj) return res.status(404).send("Proyecto no encontrado");
        
        let orConditions = [{ proyectoId: proj._id.toString() }];
        
        if (proj.folio && proj.folio.trim() !== '') {
            orConditions.push({ proyectoId: proj.folio.trim() });
            orConditions.push({ proyectoId: { $regex: proj.folio.trim(), $options: 'i' } });
            orConditions.push({ notas: { $regex: proj.folio.trim(), $options: 'i' } }); // Búsqueda en notas por [Destino CRM]
        }
        
        if (proj.nombre && proj.nombre.trim() !== '') {
            const safeSearch = proj.nombre.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            orConditions.push({ proyectoId: { $regex: safeSearch, $options: 'i' } });
            orConditions.push({ notas: { $regex: safeSearch, $options: 'i' } });
        } else if (proj.clienteNombre && proj.clienteNombre.trim() !== '') {
            const safeSearch = proj.clienteNombre.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            orConditions.push({ proyectoId: { $regex: safeSearch, $options: 'i' } });
            orConditions.push({ notas: { $regex: safeSearch, $options: 'i' } });
        }

        let q = { $or: orConditions };
        
        const vehTransactions = await VehicleTransactionRef.find(q)
                                        .populate('vehicleId')
                                        .sort({ fecha: -1 })
                                        .limit(50);
        
        const invTransactions = await InvTransactionRef.find(q)
                                        .populate('itemId')
                                        .sort({ fecha: -1 })
                                        .limit(50);
                                        
        // También incluir actividades CRM vinculadas para enriquecer historial
        const actividadesConditions = [
            { proyectoId: proj._id.toString() },
            { proyectoId: proj.folio }
        ];
        // Manejar formato legado "[Activo] P-003 - Nombre" que puede estar en la BD
        if (proj.folio) {
            actividadesConditions.push({ proyectoId: { $regex: proj.folio, $options: 'i' } });
        }
        if (proj.nombre) {
            const safeNombre = proj.nombre.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            actividadesConditions.push({ proyectoId: { $regex: safeNombre, $options: 'i' } });
        }
        if (proj.clienteNombre) {
            const safeCliente = proj.clienteNombre.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            actividadesConditions.push({ proyectoId: { $regex: safeCliente, $options: 'i' } });
        }
        const actividadesProy = await CRMActividad.find({ $or: actividadesConditions });

        // Personal de actividades CRM
        const personalCRM = new Set();
        actividadesProy.forEach(a => {
            if (a.asignadoANombre) personalCRM.add(a.asignadoANombre);
            (a.cuadrillaNombres || []).forEach(n => n && personalCRM.add(n));
        });

        // Vehículos de actividades CRM
        const vehiculosCRM = [];
        const allVehIds = new Set();
        actividadesProy.forEach(a => (a.vehiculosAsignados||[]).forEach(vid => allVehIds.add(vid)));
        if (allVehIds.size > 0) {
            const vehs = await VehicleRef.find({ _id: { $in: Array.from(allVehIds) } }).select('marca modelo placas');
            vehs.forEach(v => vehiculosCRM.push(v));
        }

        res.json({
            vehiculos: vehTransactions,
            herramientas: invTransactions,
            personalCRM: Array.from(personalCRM),
            vehiculosCRM,
            actividades: actividadesProy
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proyectos/:id/archivos', upload.array('archivos', 5), async (req, res) => {
    try {
        const { id } = req.params;
        const proj = await CRMProyecto.findById(id);
        if (!proj) return res.status(404).send("Proyecto no encontrado");
        if (!proj.archivos) proj.archivos = [];

        for (const file of req.files) {
            const archivo = new CRMArchivo({
                nombre: file.originalname,
                contentType: file.mimetype,
                datos: file.buffer.toString('base64'),
                tamanio: file.size
            });
            const saved = await archivo.save();
            proj.archivos.push(`/api/archivos/${saved._id}`);
        }
        await proj.save();
        res.json({ files: proj.archivos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Servir archivos guardados en MongoDB
app.get('/api/archivos/:id', async (req, res) => {
    try {
        const archivo = await CRMArchivo.findById(req.params.id);
        if (!archivo) return res.status(404).send('Archivo no encontrado');
        const buffer = Buffer.from(archivo.datos, 'base64');
        res.set('Content-Type', archivo.contentType);
        res.set('Content-Disposition', `inline; filename="${archivo.nombre}"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proyectos/:id/facturas', upload.single('archivo'), async (req, res) => {
    try {
        const { id } = req.params;
        const { folio, monto } = req.body;
        if (!req.file) {
            return res.status(400).json({ error: 'Es obligatorio subir un archivo (foto o PDF) para la factura.' });
        }
        
        const archivo = new CRMArchivo({
            nombre: req.file.originalname,
            contentType: req.file.mimetype,
            datos: req.file.buffer.toString('base64'),
            tamanio: req.file.size
        });
        const saved = await archivo.save();
        const archivoUrl = `/api/archivos/${saved._id}`;
        
        const proj = await CRMProyecto.findById(id);
        if (!proj) return res.status(404).send("Proyecto no encontrado");
        
        if (!proj.facturas) proj.facturas = [];
        proj.facturas.push({ folio, monto: parseFloat(monto) || 0, archivoUrl, tipo: 'Ingreso', fecha: new Date() });
        await proj.save();
        res.json({ success: true, facturas: proj.facturas });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar una factura de un proyecto
app.delete('/api/proyectos/:id/facturas/:facturaId', async (req, res) => {
    try {
        const { id, facturaId } = req.params;
        const proj = await CRMProyecto.findById(id);
        if (!proj) return res.status(404).json({ error: "Proyecto no encontrado" });
        
        const factura = proj.facturas.id(facturaId);
        if (!factura) return res.status(404).json({ error: "Factura no encontrada" });
        
        // Eliminar el archivo asociado si existe
        if (factura.archivoUrl) {
            const archivoId = factura.archivoUrl.split('/').pop();
            try {
                await CRMArchivo.findByIdAndDelete(archivoId);
            } catch(e) { console.error("Error eliminando archivo de factura:", e); }
        }
        
        // Remover factura del arreglo
        proj.facturas.pull(facturaId);
        await proj.save();
        
        res.json({ success: true, message: 'Factura eliminada', facturas: proj.facturas });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proyectos/:id/avance', upload.array('fotos', 5), async (req, res) => {
    try {
        const { id } = req.params;
        const { empleado, porcentajeTarea, porcentajeProyecto, comentario, actividadId } = req.body;
        
        let fotosUrls = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const archivo = new CRMArchivo({
                    nombre: file.originalname,
                    contentType: file.mimetype,
                    datos: file.buffer.toString('base64'),
                    tamanio: file.size
                });
                const saved = await archivo.save();
                fotosUrls.push(`/api/archivos/${saved._id}`);
            }
        }

        const proj = await CRMProyecto.findById(id);
        if (!proj) return res.status(404).json({ error: "Proyecto no encontrado" });

        // Si se envió el ID de la actividad, verificar que no se haya reportado ya
        if (actividadId) {
            const act = await CRMActividad.findById(actividadId);
            if (act) {
                if (act.avanceReportado) {
                    return res.status(400).json({ error: "Ya se reportó un avance para esta tarea." });
                }
                act.avanceReportado = true;
                await act.save();
            }
        }

        const pctTarea = parseInt(porcentajeTarea, 10) || 0;
        const pctProyecto = parseInt(porcentajeProyecto, 10) || 0;
        
        proj.avances.push({
            empleado,
            porcentaje: pctTarea,
            porcentajeProyecto: pctProyecto,
            comentario,
            fotos: fotosUrls
        });
        
        // Actualizar porcentaje del proyecto si se proporcionó
        if (pctProyecto > 0) {
            proj.porcentajeAvance = pctProyecto;
        }
        
        await proj.save();
        
        res.json({ success: true, avance: proj.avances[proj.avances.length - 1] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/proyectos/:id/porcentaje-global', async (req, res) => {
    try {
        const { id } = req.params;
        const { porcentaje } = req.body;
        
        const pct = parseInt(porcentaje, 10);
        if (isNaN(pct) || pct < 0 || pct > 100) {
            return res.status(400).json({ error: "Porcentaje inválido. Debe ser entre 0 y 100." });
        }

        const proj = await CRMProyecto.findById(id);
        if (!proj) return res.status(404).send("Proyecto no encontrado");

        proj.porcentajeAvance = pct;
        await proj.save();

        res.json({ success: true, porcentajeAvance: proj.porcentajeAvance });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// Rutas de Actividades
app.get('/api/actividades', async (req, res) => {
    try {
        const acts = await CRMActividad.find().sort({ fechaCreacion: -1 });
        res.json(acts);
    } catch(err) { res.status(500).json({error: err.message}); }
});

app.get('/api/actividades/:id', async (req, res, next) => {
    if (req.params.id === 'conflictos') return next();
    try {
        const act = await CRMActividad.findById(req.params.id);
        if (!act) return res.status(404).json({ error: 'Actividad no encontrada' });
        res.json(act);
    } catch(err) { res.status(500).json({error: err.message}); }
});

// Detección de conflictos de recursos
// Helper compartido de solapamiento de horarios
const toMins = h => {
    if (!h || h === '') return null;
    const [hh, mm] = h.split(':').map(Number);
    return hh * 60 + mm;
};
const solapan = (aIni, aFin, bIni, bFin) => {
    // Tratar null/vacío como rango completo del día (00:00 - 23:59)
    const aStart = toMins(aIni) ?? 0;
    const aEnd   = toMins(aFin) ?? 23 * 60 + 59;
    const bStart = toMins(bIni) ?? 0;
    const bEnd   = toMins(bFin) ?? 23 * 60 + 59;
    return aStart < bEnd && aEnd > bStart;
};

app.get('/api/actividades/conflictos', async (req, res) => {
    try {
        const { fecha, horaInicio, horaFin } = req.query;
        let empleados = req.query['empleados[]'] || req.query.empleados || [];
        let vehiculos = req.query['vehiculos[]'] || req.query.vehiculos || [];
        if (!Array.isArray(empleados)) empleados = [empleados];
        if (!Array.isArray(vehiculos)) vehiculos = [vehiculos];

        if (!fecha) return res.json({ vehiculosOcupados: [], empleadosOcupados: [], vehiculosBloqueados: [] });

        // Rango del día seleccionado (medianoche a medianoche UTC)
        const diaInicio = new Date(fecha + 'T00:00:00.000Z');
        const diaFin   = new Date(fecha + 'T23:59:59.999Z');

        // Todas las tareas y eventos de ese día
        const tareasDelDia = await CRMActividad.find({ 
            fechaVencimiento: { $gte: diaInicio, $lte: diaFin },
            estado: { $ne: 'Completada' }
        });
        const eventosDelDia = await CRMEvento.find({ fechaInicio: { $gte: diaInicio, $lte: diaFin } });

        const vehiculosOcupados = [];
        const empleadosOcupados = [];

        // Normalizamos la lista de empleados buscados
        const empBuscados = empleados.map(e => e.trim().toLowerCase());

        tareasDelDia.forEach(t => {
            const hayConflicto = solapan(horaInicio || null, horaFin || null, t.horaInicio || null, t.horaFin || null);
            if (!hayConflicto) return;

            // Revisar vehículos
            (t.vehiculosAsignados || []).forEach(vId => {
                if (vehiculos.includes(vId) && !vehiculosOcupados.find(x => x.id === vId)) {
                    vehiculosOcupados.push({ id: vId, tarea: t.descripcion, horaInicio: t.horaInicio, horaFin: t.horaFin });
                }
            });

            // Revisar encargado principal y cuadrilla
            let empExistArr = [t.asignadoANombre, ...(t.cuadrillaNombres || [])]
                .filter(Boolean).join(',').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

            empBuscados.forEach(b => {
                if (empExistArr.some(e => e === b || e.includes(b) || b.includes(e))) {
                    // Original name from query to let frontend match it
                    const origName = empleados.find(orig => orig.trim().toLowerCase() === b) || b;
                    if (!empleadosOcupados.find(x => x.nombre === origName)) {
                        empleadosOcupados.push({ nombre: origName, tarea: t.descripcion, horaInicio: t.horaInicio, horaFin: t.horaFin });
                    }
                }
            });
        });

        eventosDelDia.forEach(ev => {
            const hIni = ev.fechaInicio ? ev.fechaInicio.toLocaleTimeString('en-US', { timeZone: 'America/Mexico_City', hour12: false, hour: '2-digit', minute:'2-digit' }) : null;
            const hFin = ev.fechaFin ? ev.fechaFin.toLocaleTimeString('en-US', { timeZone: 'America/Mexico_City', hour12: false, hour: '2-digit', minute:'2-digit' }) : null;
            const hayConflicto = solapan(horaInicio || null, horaFin || null, hIni, hFin);
            if (!hayConflicto) return;

            (ev.vehiculosAsignados || []).forEach(vId => {
                if (vehiculos.includes(vId) && !vehiculosOcupados.find(x => x.id === vId)) {
                    vehiculosOcupados.push({ id: vId, tarea: ev.titulo, horaInicio: hIni, horaFin: hFin });
                }
            });

            let empExistArr = (ev.participantes || [])
                .filter(Boolean).join(',').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

            empBuscados.forEach(b => {
                if (empExistArr.some(e => e === b || e.includes(b) || b.includes(e))) {
                    const origName = empleados.find(orig => orig.trim().toLowerCase() === b) || b;
                    if (!empleadosOcupados.find(x => x.nombre === origName)) {
                        empleadosOcupados.push({ nombre: origName, tarea: ev.titulo, horaInicio: hIni, horaFin: hFin });
                    }
                }
            });
        });

        // Vehículos bloqueados de Tracking
        const bloqueadosTracking = await VehicleRef.find({
            estado: { $in: ['Prestado', 'Pendiente de Confirmación'] }
        }).select('_id estado');

        const vehiculosBloqueados = bloqueadosTracking
            .filter(v => vehiculos.includes(v._id.toString()))
            .map(v => ({ id: v._id.toString(), estado: v.estado }));

        res.json({ vehiculosOcupados, empleadosOcupados, vehiculosBloqueados });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Obtener alcance de proyecto sin precios (para encargados)
app.get('/api/alcance-proyecto/:proyectoId', async (req, res) => {
    try {
        const { proyectoId } = req.params;
        
        let orConditions = [];
        const mongooseQuery = require('mongoose');
        if (mongooseQuery.isValidObjectId(proyectoId)) {
            orConditions.push({ _id: proyectoId });
        }
        orConditions.push({ folio: proyectoId });
        
        const proj = await CRMProyecto.findOne({ $or: orConditions });
        if (!proj) return res.status(404).json({ error: 'Proyecto no encontrado' });
        
        if (!proj.cotizacionId) {
            return res.status(404).json({ error: 'El proyecto no tiene cotización asociada' });
        }
        
        const cot = await CRMCotizacion.findById(proj.cotizacionId);
        if (!cot) return res.status(404).json({ error: 'Cotización original no encontrada' });
        
        // Redactar datos (quitar todo lo relacionado a precios)
        const alcance = {
            clienteNombre: cot.clienteNombre,
            folio: cot.folio,
            lugarEjecucion: cot.lugarEjecucion,
            contacto: cot.contacto,
            descripcion: cot.descripcion,
            notas: cot.notas,
            fechaCreacion: cot.fechaCreacion,
            creadorNombre: cot.creadorNombre,
            creadorTelefono: cot.creadorTelefono,
            creadorCorreo: cot.creadorCorreo,
            productosSugeridos: (cot.productosSugeridos || []).map(ps => ({
                cantidad: ps.cantidad,
                descripcion: ps.descripcion,
                numeroParte: ps.numeroParte,
                marca: ps.marca,
                // Redactar costo
            })),
            partidas: (cot.partidas || []).map(p => ({
                descripcion: p.descripcion,
                cantidad: p.cantidad,
                unidad: p.unidad,
                // Redactar precioUnitario y total
            }))
        };
        
        res.json(alcance);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener tareas de hoy para un empleado (para portal de empleados)
app.get('/api/empleados/mis-tareas-hoy', async (req, res) => {
    try {
        const { nombre } = req.query;
        if (!nombre) return res.status(400).json({error: 'Falta nombre'});

        // Rango de hoy en zona horaria de México
        const fechaIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
        const diaInicio = new Date(fechaIso + 'T00:00:00.000Z');
        const diaFin   = new Date(fechaIso + 'T23:59:59.999Z');

        // Búsqueda insensible a mayúsculas
        const nombreRegex = new RegExp(`^\\s*${nombre.trim()}\\s*$`, 'i');

        // Buscar actividades donde sea asignado (encargado) o esté en cuadrilla
        const tareas = await CRMActividad.find({
            fechaVencimiento: { $gte: diaInicio, $lte: diaFin },
            estado: { $ne: 'Completada' },
            $or: [
                { asignadoANombre: nombreRegex },
                { cuadrillaNombres: nombreRegex }
            ]
        });

        // Enriquecer con info de vehículos y proyectos (archivos)
        const tareasEnriquecidas = await Promise.all(tareas.map(async (t) => {
            const tObj = t.toObject();
            
            // Separar posibles múltiples encargados y buscar coincidencia exacta para evitar falsos positivos
            const encargadosArr = (t.asignadoANombre || '').toLowerCase().split(',').map(s => s.trim());
            tObj.isEncargado = encargadosArr.includes((nombre || '').trim().toLowerCase());

            // Vehiculos
            if (t.vehiculosAsignados && t.vehiculosAsignados.length > 0) {
                tObj.vehiculosInfo = await VehicleRef.find({ _id: { $in: t.vehiculosAsignados } }).select('marca modelo placas');
            } else {
                tObj.vehiculosInfo = [];
            }

            // Proyecto / Archivos
            if (t.proyectoId) {
                const mongooseQuery = require('mongoose');
                let orConditions = [];
                if (mongooseQuery.isValidObjectId(t.proyectoId)) {
                    orConditions.push({ _id: t.proyectoId });
                }
                orConditions.push({ folio: t.proyectoId });
                // También buscar por nombre parcial (para cuando proyectoId es texto)
                orConditions.push({ nombre: { $regex: t.proyectoId.split(']').pop().split('-').pop().trim(), $options: 'i' } });

                const proj = await CRMProyecto.findOne({ $or: orConditions });
                if (proj) {
                    tObj.proyectoNombreReal = proj.nombre;
                    tObj.proyectoObjectId = proj._id.toString(); // ID real para avances
                    tObj.archivos = proj.archivos || [];
                } else {
                    tObj.archivos = [];
                    tObj.proyectoObjectId = null;
                }
            } else {
                tObj.archivos = [];
                tObj.proyectoObjectId = null;
            }
            return tObj;
        }));

        res.json(tareasEnriquecidas);
    } catch(err) {
        res.status(500).json({error: err.message});
    }
});

async function notificarFlotilla(actividad, nuevosVehiculosIds) {
    try {
        if (!nuevosVehiculosIds || nuevosVehiculosIds.length === 0) return;
        
        const allUsers = await UserRef.find();
        const allVehs = await VehicleRef.find();
        
        const vehiculosNombres = nuevosVehiculosIds.map(vId => {
            const v = allVehs.find(x => x._id.toString() === vId);
            return v ? `${v.marca} ${v.modelo} (${v.placas || 'S/P'})` : 'Desconocido';
        }).join(', ') || 'Ninguno';

        let encargado = '';
        if (Array.isArray(actividad.asignadoANombre)) {
            encargado = actividad.asignadoANombre.join(', ');
        } else if (typeof actividad.asignadoANombre === 'string') {
            encargado = actividad.asignadoANombre;
        } else {
            encargado = 'Alguien del equipo';
        }

        const msgFlotilla = `🚗 *SOLICITUD DE VEHÍCULO (CRM)* 🚗\nHola, se acaba de asignar un vehículo para una tarea operativa.\n\n👤 **Asignado a:** ${encargado}\n🚙 **Vehículo(s):** ${vehiculosNombres}\n📝 **Tarea:** ${actividad.descripcion || 'Tarea Interna'}\n\n🔧 _Favor de realizar el préstamo formal (entrega de llaves) en el módulo de Tracking._`;

        const administradoras = allUsers.filter(u => {
            const name = (u.nombre + ' ' + (u.apellido || '')).toLowerCase();
            return name.includes('jaqueline') || name.includes('isabel');
        });

        for (const admin of administradoras) {
            if (admin.telefono) {
                if (typeof waLog !== 'undefined' && waLog.add) {
                    waLog.add(`Enviando notificación de flotilla a: ${admin.nombre}`);
                }
                try {
                    await sendWhatsAppMessage(admin.telefono, msgFlotilla, { tipo: 'flotilla' });
                } catch(e) {
                    console.error('Error enviando WA a flotilla:', e);
                }
            }
        }
    } catch(e) {
        console.error('Error en notificarFlotilla:', e);
    }
}

app.post('/api/actividades', async (req, res) => {
    try {
        const data = req.body;

        // Ajuste de zona horaria para evitar desfase de 1 día (forzar mediodía UTC)
        if (data.fechaVencimiento && typeof data.fechaVencimiento === 'string' && data.fechaVencimiento.length === 10) {
            data.fechaVencimiento = data.fechaVencimiento + 'T12:00:00.000Z';
        }

        // --- Guard: verificar conflictos antes de guardar ---
        if (data.fechaVencimiento) {
            const fecha = new Date(data.fechaVencimiento).toISOString().split('T')[0];
            const diaInicio = new Date(fecha + 'T00:00:00.000Z');
            const diaFin   = new Date(fecha + 'T23:59:59.999Z');

            // Helper para convertir "HH:MM" a minutos totales
            const toMinsLocal = h => {
                if (!h || h === '') return null;
                const [hh, mm] = h.split(':').map(Number);
                return hh * 60 + mm;
            };

            // Hora actual en México (formato HH:MM)
            const ahoraEnMexico = new Date().toLocaleTimeString('en-US', {
                timeZone: 'America/Mexico_City',
                hour12: false, hour: '2-digit', minute: '2-digit'
            });
            const fechaHoyMexico = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
            const esFechaHoy = fecha === fechaHoyMexico;

            // Corrección 2: Si es HOY y no hay hora de inicio, usar la hora actual como referencia
            if (esFechaHoy && !data.horaInicio) {
                data.horaInicio = ahoraEnMexico;
            }

            // Corrección 3: Si es HOY y la hora de fin ya pasó, rechazar de inmediato
            if (esFechaHoy && data.horaFin) {
                const minutosFin = toMinsLocal(data.horaFin);
                const minutosAhora = toMinsLocal(ahoraEnMexico);
                if (minutosFin !== null && minutosAhora !== null && minutosFin <= minutosAhora) {
                    return res.status(409).json({
                        error: 'Conflicto de horario',
                        conflictos: [`La hora de fin (${data.horaFin}) ya pasó. Son las ${ahoraEnMexico} en México. Por favor elige un horario futuro.`]
                    });
                }
            }

            // Corrección 1: Excluir tareas Completadas o Canceladas del chequeo de conflictos
            const tareasDelDia = await CRMActividad.find({
                fechaVencimiento: { $gte: diaInicio, $lte: diaFin },
                estado: { $nin: ['Completada', 'Cancelada'] }
            });
            const eventosDelDia = await CRMEvento.find({ fechaInicio: { $gte: diaInicio, $lte: diaFin } });

            const conflictos = [];
            
            let empNuevosArr = [data.asignadoANombre, ...(data.cuadrillaNombres || [])]
                .filter(Boolean).join(',').split(',')
                .map(s => s.trim().toLowerCase()).filter(Boolean);

            tareasDelDia.forEach(t => {
                if (!solapan(data.horaInicio || null, data.horaFin || null, t.horaInicio || null, t.horaFin || null)) return;
                
                (t.vehiculosAsignados || []).forEach(vId => {
                    if ((data.vehiculosAsignados || []).includes(vId))
                        conflictos.push(`Vehículo ocupado en tarea: "${t.descripcion}"`);
                });
                
                let empExistArr = [t.asignadoANombre, ...(t.cuadrillaNombres || [])]
                    .filter(Boolean).join(',').split(',')
                    .map(s => s.trim().toLowerCase()).filter(Boolean);
                
                empNuevosArr.forEach(n => {
                    // Verificación parcial e insensible a mayúsculas
                    if (empExistArr.some(e => e === n || e.includes(n) || n.includes(e))) {
                        conflictos.push(`Empleado ocupado en otra tarea: "${t.descripcion}"`);
                    }
                });
            });

            eventosDelDia.forEach(ev => {
                const horaIni = ev.fechaInicio ? ev.fechaInicio.toLocaleTimeString('en-US', { timeZone: 'America/Mexico_City', hour12: false, hour: '2-digit', minute:'2-digit' }) : null;
                const horaFin = ev.fechaFin ? ev.fechaFin.toLocaleTimeString('en-US', { timeZone: 'America/Mexico_City', hour12: false, hour: '2-digit', minute:'2-digit' }) : null;
                if (!solapan(data.horaInicio || null, data.horaFin || null, horaIni, horaFin)) return;
                
                (ev.vehiculosAsignados || []).forEach(vId => {
                    if ((data.vehiculosAsignados || []).includes(vId))
                        conflictos.push(`Vehículo ocupado en evento: "${ev.titulo}"`);
                });
                
                let empExistArr = (ev.participantes || [])
                    .filter(Boolean).join(',').split(',')
                    .map(s => s.trim().toLowerCase()).filter(Boolean);
                
                empNuevosArr.forEach(n => {
                    if (empExistArr.some(e => e === n || e.includes(n) || n.includes(e))) {
                        conflictos.push(`Empleado ocupado en junta/levantamiento: "${ev.titulo}"`);
                    }
                });
            });

            // También verificar vehículos bloqueados en Tracking
            if (data.vehiculosAsignados && data.vehiculosAsignados.length > 0) {
                const bloqueados = await VehicleRef.find({
                    _id: { $in: data.vehiculosAsignados },
                    estado: { $in: ['Prestado', 'Pendiente de Confirmación'] }
                }).select('modelo estado');
                bloqueados.forEach(v => {
                    conflictos.push(`Vehículo "${v.modelo}" está ${v.estado} en Tracking`);
                });
            }

            if (conflictos.length > 0) {
                return res.status(409).json({ error: 'Conflicto de recursos', conflictos });
            }
        }
        // --- Fin Guard ---

        const newAct = new CRMActividad(data);
        await newAct.save();
        try { if (global.io) global.io.emit('actividad_creada', newAct); } catch(_) {}

        // Inyectar etiqueta sugerida a vehículos seleccionados
        if (data.vehiculosAsignados && data.vehiculosAsignados.length > 0) {
            let label = data.destinoSugeridoCRMText;
            if (!label || label === '') label = data.descripcion || 'Tarea de CRM';
            for (const vId of data.vehiculosAsignados) {
                await VehicleRef.findByIdAndUpdate(vId, { 
                    destinoSugeridoCRM: label,
                    crmActividadId: newAct._id.toString(),
                    crmProyectoId: newAct.proyectoId || null
                });
            }
        }

        // ✅ Responder al cliente INMEDIATAMENTE (sin esperar WhatsApp)
        res.json({ message: 'Actividad creada con éxito', data: newAct });

        // --- NOTIFICACIONES WHATSAPP (en segundo plano, NO bloquea la respuesta) ---
        setImmediate(async () => {
        try {
            const allUsers = await UserRef.find();
            const allVehs = await VehicleRef.find();
            
            const findPhone = (name) => {
                // Quitamos espacios dobles y lo pasamos a minúsculas
                const queryName = name.trim().toLowerCase().replace(/\s+/g, ' ');
                const u = allUsers.find(x => {
                    const soloNombre = (x.nombre || '').trim().toLowerCase();
                    const soloApellido = (x.apellido || '').trim().toLowerCase();
                    const fullName = `${soloNombre} ${soloApellido}`.trim().replace(/\s+/g, ' ');
                    
                    if (!fullName) return false;
                    
                    // Match exacto, o si uno contiene al otro (Ej. "Daniel" dentro de "Daniel Arevalos")
                    return fullName === queryName || fullName.includes(queryName) || queryName.includes(fullName);
                });
                return u && u.telefono ? u.telefono : null;
            };

            const vehiculosNombres = (data.vehiculosAsignados || []).map(vId => {
                const v = allVehs.find(x => x._id.toString() === vId);
                return v ? v.modelo : 'Desconocido';
            }).join(', ') || 'Ninguno';
            
            // Si el frontend envía los acompañantes como un solo string separado por comas, lo separamos
            let acompanantesArr = [];
            if (Array.isArray(data.cuadrillaNombres)) {
                acompanantesArr = data.cuadrillaNombres.filter(Boolean);
            } else if (typeof data.cuadrillaNombres === 'string') {
                acompanantesArr = data.cuadrillaNombres.split(',').map(s => s.trim()).filter(Boolean);
            }
            
            let encargadosArr = [];
            if (Array.isArray(data.asignadoANombre)) {
                encargadosArr = data.asignadoANombre.filter(Boolean);
            } else if (typeof data.asignadoANombre === 'string') {
                encargadosArr = data.asignadoANombre.split(',').map(s => s.trim()).filter(Boolean);
            }

            const acompanantesTxt = acompanantesArr.join(', ') || 'Nadie';
            const encargadosTxt = encargadosArr.join(', ') || 'Ninguno';

            let proyectoNombre = 'Ninguno';
            if (data.proyectoId) {
                // FIX: el frontend guarda el FOLIO ("C523") en proyectoId, no el _id de MongoDB.
                // findById("C523") siempre devuelve null → búsqueda dual: primero por _id, luego por folio.
                const mongoose = require('mongoose');
                let proj = null;
                if (mongoose.isValidObjectId(data.proyectoId)) {
                    proj = await CRMProyecto.findById(data.proyectoId);
                }
                if (!proj) {
                    proj = await CRMProyecto.findOne({
                        $or: [
                            { folio: data.proyectoId },
                            { folio: { $regex: `^${data.proyectoId.trim()}$`, $options: 'i' } }
                        ]
                    });
                }
                if (proj) {
                    proyectoNombre = `${proj.folio || 'S/F'} - ${proj.nombre}`;
                    if (typeof waLog !== 'undefined' && waLog.add) {
                        waLog.add(`📂 Proyecto encontrado: ${proyectoNombre}`);
                    }
                } else {
                    if (typeof waLog !== 'undefined' && waLog.add) {
                        waLog.add(`⚠️ Proyecto NO encontrado para proyectoId: "${data.proyectoId}".`);
                    }
                }
            }

            const _dFecha = data.fechaVencimiento ? new Date(data.fechaVencimiento) : null;
            const fechaTxt = _dFecha
                ? `${_dFecha.toLocaleDateString('es-MX', { weekday: 'long', timeZone: 'America/Mexico_City' })} - ${_dFecha.toLocaleDateString('es-MX', { day: '2-digit', timeZone: 'America/Mexico_City' })}`
                : 'No definida';

            // ── Determinar si la tarea es FUTURA (más de 1 día) o INMEDIATA (hoy/mañana) ──
            const hoyMx = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
            const hoyMxMs = new Date(hoyMx + 'T12:00:00.000Z').getTime();
            const tareaMs = _dFecha ? _dFecha.getTime() : hoyMxMs;
            const diasDiferencia = Math.round((tareaMs - hoyMxMs) / (1000 * 60 * 60 * 24));
            const esTareaFutura = diasDiferencia > 1; // más de 1 día de distancia

            let herramientasNombres = 'Ninguna';
            if (data.herramientasAsignadas && data.herramientasAsignadas.length > 0) {
                const mongoose = require('mongoose');
                try {
                    const tools = await mongoose.connection.db.collection('inventoryitems').find({ _id: { $in: data.herramientasAsignadas } }).toArray();
                    if (tools.length > 0) {
                        herramientasNombres = tools.map(t => t.nombre).join(', ');
                    }
                } catch(e) { console.error('Error fetching tools for wa message:', e); }
            }

            const mensajeBase = `📝 Tarea: ${data.descripcion}\n📅 Fecha: ${fechaTxt}\n🕒 Horario: ${data.horaInicio || 'No definido'} a ${data.horaFin || 'No definido'}\n🏗️ Proyecto: ${proyectoNombre}\n🚗 Vehículo(s): ${vehiculosNombres}\n🧰 Herramientas: ${herramientasNombres}\n\nResponde con:\n✅ *1* — para aceptar\n❌ *2* — para rechazar`;

            for (const enc of encargadosArr) {
                const telEncargado = findPhone(enc);
                if (typeof waLog !== 'undefined' && waLog.add) {
                    waLog.add(`🔍 Buscando tel para encargado: ${enc} -> Resultado: ${telEncargado || 'NO ENCONTRADO'}`);
                }
                if (telEncargado) {
                    if (esTareaFutura) {
                        // ✉️ AVISO CORTO: solo notificar que fue agendado, sin detalles
                        const msgAviso = `📌 *AVISO DE TAREA AGENDADA*\n\nHola *${enc}*, quedaste agendado para una tarea el *${fechaTxt}*.\n📝 ${data.descripcion || 'Tarea operativa'}\n\n_Te mando todos los detalles un día antes._ 👌`;
                        try { await sendWhatsAppMessage(telEncargado, msgAviso, { tipo: 'aviso_tarea', genero: inferirGenero(enc), nombre: enc }); } catch(e) { console.error('Error WA aviso encargado:', e); }
                    } else {
                        // 🚨 MENSAJE COMPLETO: tarea para hoy o mañana
                        const msgEncargado = `🚨 *NUEVA TAREA ASIGNADA (Tú eres el Encargado)* 🚨\n\n${mensajeBase}\n\n👥 Te acompañan: ${acompanantesTxt}`;
                        try { await sendWhatsAppMessage(telEncargado, msgEncargado, { tipo: 'tarea_encargado', genero: inferirGenero(enc), nombre: enc }); } catch(e) { console.error('Error WA encargado:', e); }
                        // Encolar sesión WAITING_TASK_CONFIRM solo para tareas inmediatas
                        try {
                            const chatIdEnc = phoneToWaChatId(telEncargado);
                            const altChatIdEnc = chatIdEnc.startsWith('521') ? chatIdEnc.replace('521','52') : chatIdEnc.replace(/^52/, '521');
                            const encSessionData = { state: 'WAITING_TASK_CONFIRM', ctx: { tareaDesc: data.descripcion, nombreTrabajador: enc, tareaId: newAct._id ? newAct._id.toString() : null, proyectoId: data.proyectoId || 'IND' } };
                            await enqueueSession(chatIdEnc, encSessionData);
                            await enqueueSession(altChatIdEnc, encSessionData);
                            waLog.add(`📋 [COLA-CRM] WAITING_TASK_CONFIRM encolado para encargado: ${chatIdEnc}`);
                        } catch(eQ) { console.error('Error encolando tarea encargado:', eQ); }
                    }
                }
            }

            for (const ac of acompanantesArr) {
                const telAc = findPhone(ac);
                if (typeof waLog !== 'undefined' && waLog.add) {
                    waLog.add(`🔍 Buscando tel para acompañante: ${ac} -> Resultado: ${telAc || 'NO ENCONTRADO'}`);
                }
                if (telAc) {
                    if (esTareaFutura) {
                        // ✉️ AVISO CORTO
                        const msgAvisoAc = `📌 *AVISO DE TAREA AGENDADA*\n\nHola *${ac}*, vas a participar en una tarea el *${fechaTxt}*.\n📝 ${data.descripcion || 'Tarea operativa'}\n👤 Encargado: ${encargadosTxt}\n\n_Te mando todos los detalles un día antes._ 👌`;
                        try { await sendWhatsAppMessage(telAc, msgAvisoAc, { tipo: 'aviso_tarea', genero: inferirGenero(ac), nombre: ac }); } catch(e) { console.error('Error WA aviso acompañante:', e); }
                    } else {
                        // 🚨 MENSAJE COMPLETO
                        const msgAc = `🔔 *NUEVA TAREA ASIGNADA (Vas como Acompañante)* 🔔\n\n👤 Encargado principal: ${encargadosTxt || 'Ninguno'}\n\n${mensajeBase}`;
                        try { await sendWhatsAppMessage(telAc, msgAc, { tipo: 'tarea_acompanante', genero: inferirGenero(ac), nombre: ac }); } catch(e) { console.error('Error WA acompañante:', e); }
                        try {
                            const chatIdAc = phoneToWaChatId(telAc);
                            const altChatIdAc = chatIdAc.startsWith('521') ? chatIdAc.replace('521','52') : chatIdAc.replace(/^52/, '521');
                            const acSessionData = { state: 'WAITING_TASK_CONFIRM', ctx: { tareaDesc: data.descripcion, nombreTrabajador: ac, tareaId: newAct._id ? newAct._id.toString() : null, proyectoId: data.proyectoId || 'IND' } };
                            await enqueueSession(chatIdAc, acSessionData);
                            await enqueueSession(altChatIdAc, acSessionData);
                            waLog.add(`📋 [COLA-CRM] WAITING_TASK_CONFIRM encolado para acompañante: ${chatIdAc}`);
                        } catch(eQ) { console.error('Error encolando tarea acompañante:', eQ); }
                    }
                }
            }

        } catch (e) {
            console.error("Error generando notificaciones WA desde CRM:", e);
            if (typeof waLog !== 'undefined' && waLog.add) {
                waLog.add(`❌ CRITICAL ERROR notificaciones: ${e.message}`);
            }
        }
        
        // Notificar a flotilla si se asignaron vehículos
        if (data.vehiculosAsignados && data.vehiculosAsignados.length > 0) {
            await notificarFlotilla(data, data.vehiculosAsignados);
        }

        }); // fin setImmediate
        // --- FIN NOTIFICACIONES ---
    } catch(err) { res.status(500).json({error: err.message}); }
});
app.put('/api/actividades/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        
        // Ajuste de zona horaria para evitar desfase de 1 día (forzar mediodía UTC)
        if (data.fechaVencimiento && typeof data.fechaVencimiento === 'string' && data.fechaVencimiento.length === 10) {
            data.fechaVencimiento = data.fechaVencimiento + 'T12:00:00.000Z';
        }
        
        // Respaldar la actividad original para ver qué cambió
        const oldAct = await CRMActividad.findById(id);
        const oldVehiculos = oldAct ? (oldAct.vehiculosAsignados || []) : [];

        const updatedAct = await CRMActividad.findByIdAndUpdate(id, data, { returnDocument: 'after' });
        if (!updatedAct) return res.status(404).json({ error: 'Actividad no encontrada' });
        try { if (global.io) global.io.emit('actividad_actualizada', updatedAct); } catch(_) {}
        
        const newVehiculos = updatedAct.vehiculosAsignados || [];

        // Soltar vehículos que ya no están asignados
        const vehiculosSoltados = oldVehiculos.filter(v => !newVehiculos.includes(v));
        for (const vId of vehiculosSoltados) {
            await VehicleRef.findByIdAndUpdate(vId, { 
                $unset: { destinoSugeridoCRM: 1, crmActividadId: 1, crmProyectoId: 1 } 
            });
            // Si tiene proyecto, quitar del proyecto
            if (updatedAct.proyectoId) {
                await CRMProyecto.findByIdAndUpdate(updatedAct.proyectoId, {
                    $pull: { vehiculosAsignados: vId }
                });
            }
        }

        // Asignar los nuevos vehículos
        if (newVehiculos.length > 0) {
            let label = data.destinoSugeridoCRMText || updatedAct.descripcion || 'Tarea de CRM';
            for (const vId of newVehiculos) {
                await VehicleRef.findByIdAndUpdate(vId, { 
                    destinoSugeridoCRM: label,
                    crmActividadId: updatedAct._id.toString(),
                    crmProyectoId: updatedAct.proyectoId || null
                });
                // Si tiene proyecto, agregar al proyecto
                if (updatedAct.proyectoId) {
                    await CRMProyecto.findByIdAndUpdate(updatedAct.proyectoId, {
                        $addToSet: { vehiculosAsignados: vId }
                    });
                }
            }
        }
        
        const nuevosAgregados = newVehiculos.filter(v => !oldVehiculos.includes(v));
        if (nuevosAgregados.length > 0) {
            setImmediate(() => {
                notificarFlotilla(data, nuevosAgregados);
            });
        }

        res.json({ message: 'Actividad actualizada con éxito', data: updatedAct });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/actividades/:id/estado', async (req, res) => {
    try {
        const { id } = req.params;
        const { estado, comentarioCierre } = req.body;
        let updateData = { estado };
        if (comentarioCierre) updateData.comentarioCierre = comentarioCierre;
        const updatedAct = await CRMActividad.findByIdAndUpdate(id, updateData, { returnDocument: 'after' });
        if (!updatedAct) return res.status(404).json({ error: 'Actividad no encontrada' });
        try { if (global.io) global.io.emit('actividad_actualizada', updatedAct); } catch(_) {}

        // Si se completó o canceló, liberar los vehículos en Tracking
        if (['Completada', 'Cancelada'].includes(estado)) {
            if (updatedAct.vehiculosAsignados && updatedAct.vehiculosAsignados.length > 0) {
                for (const vId of updatedAct.vehiculosAsignados) {
                    await VehicleRef.findByIdAndUpdate(vId, { 
                        $unset: { destinoSugeridoCRM: 1, crmActividadId: 1, crmProyectoId: 1 } 
                    });
                }
            }
        }
        res.json({ message: 'Estado actualizado', data: updatedAct });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/actividades/:id/avance', upload.array('fotos', 5), async (req, res) => {
    try {
        const { id } = req.params;
        const { empleado, porcentajeTarea, comentario } = req.body;
        
        const act = await CRMActividad.findById(id);
        if (!act) return res.status(404).json({ error: 'Actividad no encontrada' });
        if (act.avanceReportado) {
            return res.status(400).json({ error: "Ya se reportó un avance para esta tarea." });
        }

        const pctTarea = parseFloat(porcentajeTarea) || 0;

        let fotosUrls = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const archivo = new CRMArchivo({
                    nombre: file.originalname,
                    contentType: file.mimetype,
                    datos: file.buffer.toString('base64'),
                    tamanio: file.size
                });
                const saved = await archivo.save();
                fotosUrls.push(`/api/archivos/${saved._id}`);
            }
        }

        act.avances = act.avances || [];
        act.avances.push({
            empleado,
            porcentaje: pctTarea,
            comentario,
            fotos: fotosUrls
        });

        if (pctTarea > act.porcentajeAvance) {
            act.porcentajeAvance = pctTarea;
        }

        if (pctTarea >= 100) {
            act.estado = 'Completada';
        }
        act.avanceReportado = true;

        await act.save();

        // Si la actividad pertenece a un proyecto, sincronizar avance hacia el proyecto
        if (act.proyectoId && act.proyectoId !== 'IND' && act.proyectoId !== 'General') {
            const mongooseQuery = require('mongoose');
            let proj = null;
            if (mongooseQuery.isValidObjectId(act.proyectoId)) {
                proj = await CRMProyecto.findById(act.proyectoId);
            } else {
                const folioPuro = act.proyectoId.replace('Proyecto Activo -', '').split('-').pop().trim();
                proj = await CRMProyecto.findOne({ 
                    $or: [{ folio: folioPuro }, { nombre: { $regex: folioPuro, $options: 'i' } }] 
                });
            }
            if (proj) {
                const pctProyecto = req.body.porcentajeProyecto ? parseInt(req.body.porcentajeProyecto, 10) : 0;
                proj.avances.push({
                    empleado,
                    porcentaje: pctTarea,
                    porcentajeProyecto: pctProyecto,
                    comentario,
                    fotos: fotosUrls
                });
                if (pctProyecto > 0) proj.porcentajeAvance = pctProyecto;
                await proj.save();
            }
        }

        res.json({ success: true, avance: act.avances[act.avances.length - 1] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/actividades/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deletedAct = await CRMActividad.findByIdAndDelete(id);
        if (!deletedAct) return res.status(404).json({ error: 'Actividad no encontrada' });
        
        if (deletedAct.vehiculosAsignados && deletedAct.vehiculosAsignados.length > 0) {
            for (const vId of deletedAct.vehiculosAsignados) {
                await VehicleRef.findByIdAndUpdate(vId, { $unset: { destinoSugeridoCRM: 1 } });
            }
        }

        res.json({ message: 'Actividad eliminada' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Rutas de Eventos (Agenda)
app.get('/api/eventos', async (req, res) => {
    try {
        const evs = await CRMEvento.find().sort({ fechaInicio: 1 });
        res.json(evs);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/eventos', async (req, res) => {
    try {
        const data = req.body;
        const ev = new CRMEvento(data);
        await ev.save();
        res.json({ message: 'Evento creado', data: ev });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/eventos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await CRMEvento.findByIdAndDelete(id);
        res.json({ message: 'Evento eliminado' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// INTEGRACION WHATSAPP-WEB.JS - NAIS BOT
// ==========================================
const { Client, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// CustomMongoStore para arreglar el bug de rutas de wwebjs-mongo en Railway
class CustomMongoStore {
    constructor({ mongoose } = {}) {
        if(!mongoose) throw new Error('A valid Mongoose instance is required for MongoStore.');
        this.mongoose = mongoose;
    }

    async sessionExists(options) {
        let multiDeviceCollection = this.mongoose.connection.db.collection(`whatsapp-${options.session}.files`);
        let hasExistingSession = await multiDeviceCollection.countDocuments();
        return !!hasExistingSession;   
    }
    
    async save(options) {
        var bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${options.session}`
        });
        await new Promise((resolve, reject) => {
            // FIX: Usar WA_DATA_PATH (directorio temporal) en lugar de ./
            const zipPath = require('path').join(WA_DATA_PATH, `${options.session}.zip`);
            require('fs').createReadStream(zipPath)
                .pipe(bucket.openUploadStream(`${options.session}.zip`))
                .on('error', err => reject(err))
                .on('close', () => resolve());
        });
        options.bucket = bucket;
        await this.#deletePrevious(options);
    }

    async extract(options) {
        var bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${options.session}`
        });
        return new Promise((resolve, reject) => {
            bucket.openDownloadStreamByName(`${options.session}.zip`)
                .pipe(require('fs').createWriteStream(options.path))
                .on('error', err => reject(err))
                .on('close', () => resolve());
        });
    }

    async delete(options) {
        var bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${options.session}`
        });
        const documents = await bucket.find({
            filename: `${options.session}.zip`
        }).toArray();

        documents.map(async doc => {
            return bucket.delete(doc._id);
        });   
    }

    async #deletePrevious(options) {
        const documents = await options.bucket.find({
            filename: `${options.session}.zip`
        }).toArray();
        if (documents.length > 1) {
            const oldSession = documents.reduce((a, b) => a.uploadDate < b.uploadDate ? a : b);
            return options.bucket.delete(oldSession._id);   
        }
    }
}

// Schema para persistir sesiones del bot WA en MongoDB (sobrevive reinicios)
const WaSessionSchema = new mongoose.Schema({
    chatId: { type: String, unique: true },
    state: { type: String, default: 'IDLE' },
    ctx: { type: Object, default: {} },
    pendingQueue: { type: Array, default: [] }, // Cola de pendientes del sistema
    expiresAt: { type: Date, default: null },   // Expiración instantánea (sin depender del TTL de Mongo)
    updatedAt: { type: Date, default: Date.now, expires: 86400 } // TTL 24h físico
}, { collection: 'wa_bot_sessions' });
const WaSession = mongoose.model('WaSession', WaSessionSchema);

// Helpers async para sesiones persistentes
async function getSession(chatId) {
    try {
        const s = await WaSession.findOne({ chatId }).lean();
        if (!s) return { state: 'IDLE', ctx: {}, pendingQueue: [] };
        // Validación instantánea de expiración (no dependemos del TTL lento de Mongo)
        if (s.expiresAt && new Date() > new Date(s.expiresAt)) {
            await WaSession.findOneAndUpdate({ chatId }, { state: 'IDLE', ctx: {}, pendingQueue: [], expiresAt: null });
            return { state: 'IDLE', ctx: {}, pendingQueue: [] };
        }
        return { state: s.state || 'IDLE', ctx: s.ctx || {}, pendingQueue: s.pendingQueue || [] };
    } catch(e) { return { state: 'IDLE', ctx: {}, pendingQueue: [] }; }
}

async function setSession(chatId, data) {
    try {
        // Si no se pasa pendingQueue explícitamente, preservar la que ya existe en DB
        // Esto evita que los flujos (avance, tarea, etc.) borren la cola al hacer setSession({ state:'IDLE', ctx:{} })
        let queueToSave;
        if (data.pendingQueue !== undefined) {
            // Se pasó explícitamente (incluyendo [] vacío): respetar ese valor
            queueToSave = data.pendingQueue;
        } else {
            // No se pasó: leer la cola actual de la DB para preservarla
            const existing = await WaSession.findOne({ chatId }).select('pendingQueue').lean();
            queueToSave = existing?.pendingQueue || [];
        }

        await WaSession.findOneAndUpdate(
            { chatId },
            { state: data.state, ctx: data.ctx || {}, pendingQueue: queueToSave, expiresAt: data.expiresAt || null, updatedAt: new Date() },
            { upsert: true, returnDocument: 'after' }
        );
    } catch(e) { waLog.add(`⚠️ Error guardando sesión: ${e.message?.substring(0,60)}`); }
}

// Encola un pendiente del SISTEMA sin sobreescribir la sesión activa del usuario de forma atómica.
async function enqueueSession(chatId, newItem) {
    try {
        const current = await WaSession.findOne({ chatId }).lean();
        if (!current || current.state === 'IDLE' || (current.expiresAt && new Date() > new Date(current.expiresAt))) {
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
            await WaSession.findOneAndUpdate(
                { chatId },
                { $set: { state: newItem.state, ctx: newItem.ctx, pendingQueue: [], expiresAt, updatedAt: new Date() } },
                { upsert: true }
            );
            waLog.add(`📥 [COLA] Activado directo ${newItem.state} para ${chatId}`);
        } else {
            // Operación Atómica $push
            // Evitamos duplicados básicos comparando txId o tareaId si existen en el newItem
            const queryObj = { chatId };
            if (newItem.ctx && (newItem.ctx.txId || newItem.ctx.tareaId)) {
                queryObj.pendingQueue = { 
                    $not: { 
                        $elemMatch: { 
                            state: newItem.state, 
                            $or: [
                                { "ctx.txId": newItem.ctx.txId },
                                { "ctx.tareaId": newItem.ctx.tareaId }
                            ]
                        } 
                    } 
                };
            }

            const result = await WaSession.findOneAndUpdate(
                queryObj,
                { $push: { pendingQueue: newItem }, $set: { updatedAt: new Date() } }
            );
            if (result) {
                waLog.add(`📥 [COLA] Encolado ${newItem.state} para ${chatId} (Cola agregada atómicamente)`);
            } else {
                waLog.add(`📥 [COLA] Ya existía ${newItem.state} para ${chatId}, ignorado.`);
            }
        }
    } catch(e) { waLog.add(`⚠️ Error encolando sesión: ${e.message?.substring(0,60)}`); }
}

// Resuelve la sesión actual y activa el siguiente pendiente de la cola (si existe) de forma atómica.
async function resolveSession(chatId, altChatId, reply) {
    try {
        const resolveAtomic = async (cid) => {
            if (!cid) return null;
            // Usamos pipeline de agregación en la actualización (requiere Mongo 4.2+)
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            return await WaSession.findOneAndUpdate(
                { chatId: cid },
                [
                    {
                        $set: {
                            state: { $cond: { if: { $gt: [{ $size: { $ifNull: ["$pendingQueue", []] } }, 0] }, then: { $arrayElemAt: ["$pendingQueue.state", 0] }, else: 'IDLE' } },
                            ctx: { $cond: { if: { $gt: [{ $size: { $ifNull: ["$pendingQueue", []] } }, 0] }, then: { $arrayElemAt: ["$pendingQueue.ctx", 0] }, else: {} } },
                            expiresAt: { $cond: { if: { $gt: [{ $size: { $ifNull: ["$pendingQueue", []] } }, 0] }, then: expiresAt, else: null } },
                            pendingQueue: { $cond: { if: { $gt: [{ $size: { $ifNull: ["$pendingQueue", []] } }, 0] }, then: { $slice: ["$pendingQueue", 1, { $size: "$pendingQueue" }] }, else: [] } },
                            updatedAt: new Date()
                        }
                    }
                ],
                { returnDocument: 'after', updatePipeline: true }
            );
        };

        const nextS = await resolveAtomic(chatId);
        if (altChatId) await resolveAtomic(altChatId);

        if (nextS && nextS.state !== 'IDLE') {
            waLog.add(`📤 [COLA] Activando siguiente pendiente: ${nextS.state} para ${chatId}`);
            const tipoLabel = nextS.state === 'WAITING_VEHICLE_CONFIRM' ? 'asignación de vehículo' : 'asignación de tarea';
            const desc = nextS.ctx.tareaDesc || nextS.ctx.vehicleId || '';
            if (reply) await reply(`🔔 *Tienes otro pendiente:* ${tipoLabel}\n${desc ? `📋 "${desc}"` : ''}\n\nResponde con *1* para aceptar o *2* para rechazar.`);
        } else {
            waLog.add(`📤 [COLA] Sin pendientes. Sesión en IDLE para ${chatId}`);
        }
    } catch(e) { waLog.add(`⚠️ Error en resolveSession: ${e.message?.substring(0,60)}`); }
}

// ── Utilidades del Bot WhatsApp ─────────────────────────────────────────
// 1.1 Respuestas variables (anti-robot)
const waRnd = arr => arr[Math.floor(Math.random() * arr.length)];
const WA_FRASES = {
    confirmado: ['✅ ¡Listo! Quedó registrado.','👍 Perfecto, guardado sin problema.','✅ Anotado. Todo en orden.','💪 Listo, queda en el sistema.'],
    avance: ['✅ ¡Avance reportado! El panel ya muestra la actualización.','💪 ¡Buen trabajo! Avance guardado correctamente.','✅ Listo. Tu reporte quedó en el historial del proyecto.','👍 Perfecto, avance registrado.'],
    error: ['No entendí ese mensaje 🤔\nEscribe *"ayuda"* para ver las opciones.','Hmm, no caché eso. 🤔\nEscribe *"menu"* para ver qué puedo hacer.','No estoy seguro de qué necesitas.\nEscribe *"hola"* para ver las opciones.'],
    tarea: ['🛠️ Claro, vamos a crear la tarea.','Perfecto, asignemos la tarea. 🛠️','Con gusto. Creemos la actividad.'],
    evento: ['📅 Claro, agendemos.','Perfecto, vamos con eso. 📋','Con gusto lo agendo.']
};

// Barra de progreso visual
const waFormatBarra = pct => {
    const p = Math.max(0, Math.min(100, pct||0));
    return '█'.repeat(Math.round(p/10)) + '░'.repeat(10-Math.round(p/10)) + ` ${p}%`;
};

// 3.1 Detección de perfil de usuario por teléfono
const WA_ADMIN_KEYWORDS = ['jacqueline','jaqueline','isabel','jacky'];
async function getUserProfile(resolvedId) {
    try {
        const phone = resolvedId.replace('@c.us','').replace(/\D/g,'').slice(-10);
        const users = await UserRef.find();
        const u = users.find(x => x.telefono && x.telefono.replace(/\D/g,'').slice(-10) === phone);
        if (!u) return { nombre: null, esAdmin: false };
        const esAdmin = WA_ADMIN_KEYWORDS.some(k => (u.nombre||'').toLowerCase().includes(k));
        return { nombre: u.nombre, apellido: u.apellido||'', esAdmin };
    } catch(e) { return { nombre: null, esAdmin: false }; }
}
// ────────────────────────────────────────────────────────────────────────

// ==========================================
// REGISTRO INTERNO: LID → chatId real
// Proceso aislado que SOLO resuelve el identificador LID de WhatsApp
// al número de teléfono real (ej. 52133...@c.us).
// No interfiere con ninguna otra lógica del bot.
// ==========================================
const lidToChatId = new Map(); // lid@lid  →  521XXXXXXXXXX@c.us

let waCurrentQR = null;
let waStatus = 'DESCONECTADO';

// Usamos una variable (let) para poder cambiar la ruta si es necesario limpiar bloqueos
let WA_DATA_PATH = require('path').join(require('os').tmpdir(), 'wa_auth');
try { fs.mkdirSync(WA_DATA_PATH, { recursive: true }); } catch(e) { 
    console.error('Error creando directorio temporal:', e); 
}

// Bandera para evitar múltiples instancias de Puppeteer simultáneas
let waInitializing = false;


// Helper GLOBAL para convertir teléfono a formato chatId de WhatsApp
// Definida FUERA de initWhatsApp para que sea accesible desde endpoints de API
function phoneToWaChatId(phone) {
    let cleanPhone = (phone || '').replace(/\D/g, '');
    if (cleanPhone.length === 10) cleanPhone = `521${cleanPhone}`;
    if (cleanPhone.length === 12 && cleanPhone.startsWith('52')) cleanPhone = `521${cleanPhone.substring(2)}`;
    return cleanPhone.includes('@c.us') ? cleanPhone : `${cleanPhone}@c.us`;
}

const initWhatsApp = () => { console.log('[DUMMY WA] initWhatsApp disabled'); };

if (mongoose.connection.readyState === 1) {
    initWhatsApp();
} else {
    mongoose.connection.once('open', initWhatsApp);
}

// --- WATCHDOG: Reiniciar bot si lleva mucho tiempo desconectado ---
// Si a los 3 minutos de arrancar el servidor el bot sigue DESCONECTADO
// (sin haber llegado a ESPERANDO_ESCANEO ni CONECTADO), lo reinicia solo.
// Watchdog disabled
// -------------------------------------------------------

// Favicon (evitar 404 en el log)
app.get('/favicon.ico', (req, res) => res.status(204).end());

// --- Recordatorios automáticos de eventos ---
setInterval(async () => {
    try {
        if (!waReady || waStatus !== 'CONECTADO') return;
        
        const ahora = new Date();
        const enHoraYMedia = new Date(ahora.getTime() + 90 * 60 * 1000);
        
        // Buscar eventos (SOLO Juntas y Levantamientos) que comiencen en los próximos 90 minutos
        const eventos = await CRMEvento.find({
            tipo: { $in: ['Junta', 'Levantamiento'] },
            fechaInicio: { $gt: ahora, $lte: enHoraYMedia },
            recordatorioEnviado: { $ne: true }
        });
        
        if (eventos.length === 0) return;
        
        const allUsers = await UserRef.find();
        const findPhone = (name) => {
            const queryName = name.trim().toLowerCase().replace(/\s+/g, ' ');
            const u = allUsers.find(x => {
                const soloNombre = (x.nombre || '').trim().toLowerCase();
                const soloApellido = (x.apellido || '').trim().toLowerCase();
                const fullName = `${soloNombre} ${soloApellido}`.trim().replace(/\s+/g, ' ');
                if (!fullName) return false;
                return fullName === queryName || fullName.includes(queryName) || queryName.includes(fullName);
            });
            return u && u.telefono ? u.telefono : null;
        };

        for (const ev of eventos) {
            const timeStr = ev.fechaInicio.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute:'2-digit' });
            
            for (const participante of (ev.participantes || [])) {
                const tel = findPhone(participante);
                if (tel) {
                    const msg = `⏰ *RECORDATORIO DE ${ev.tipo.toUpperCase()}*\n\nHola ${participante}, te recordamos que tienes programado: *${ev.titulo}*.\n\n🕒 Inicia a las: ${timeStr}\n📝 Detalles: ${ev.descripcion}\n\nPor favor, prepárate con anticipación.`;
                    await sendWhatsAppMessage(tel, msg, { tipo: 'recordatorio' }).catch(e => console.error("Error enviando recordatorio WA:", e));
                }
            }
            
            ev.recordatorioEnviado = true;
            await ev.save();
        }
    } catch(err) {
        console.error('Error en loop de recordatorios:', err);
    }
}, 60000); // Revisar cada minuto

// --- RECORDATORIOS AUTOMÁTICOS DE TAREAS (8:00 PM México, día anterior) ---
let _ultimoRecordatorioTareasFecha = '';
setInterval(async () => {
    try {
        if (!waReady || waStatus !== 'CONECTADO') return;

        // Calcular hora actual en México
        const ahoraISO = new Date().toLocaleString('en-CA', { timeZone: 'America/Mexico_City', hour12: false });
        // ahoraISO tiene formato: "2026-06-04, 20:00:05"
        const [fechaHoyMx, tiempoMx] = ahoraISO.split(', ');
        const [horaActual, minActual] = tiempoMx.split(':').map(Number);

        // Ejecutar solo entre 20:00 y 20:01 (ventana de 1 minuto) y solo 1 vez por día
        if (horaActual !== 20 || minActual > 1) return;
        if (_ultimoRecordatorioTareasFecha === fechaHoyMx) return;
        _ultimoRecordatorioTareasFecha = fechaHoyMx;

        waLog.add('⏰ [CRON] Iniciando envío de recordatorios de tareas para mañana...');

        // Calcular rango de mañana
        const mañana = new Date(fechaHoyMx + 'T12:00:00.000Z');
        mañana.setDate(mañana.getDate() + 1);
        const mañanaStr = mañana.toISOString().split('T')[0];
        const mañanaInicio = new Date(mañanaStr + 'T00:00:00.000Z');
        const mañanaFin    = new Date(mañanaStr + 'T23:59:59.999Z');

        // Buscar tareas de mañana no completadas
        const tareasManana = await CRMActividad.find({
            fechaVencimiento: { $gte: mañanaInicio, $lte: mañanaFin },
            estado: { $nin: ['Completada', 'Cancelada'] }
        });

        if (tareasManana.length === 0) {
            waLog.add('⏰ [CRON] Sin tareas para mañana. Nada que recordar.');
            return;
        }

        const allUsers = await UserRef.find();
        const allVehs  = await VehicleRef.find();

        const findPhoneCron = (name) => {
            const q = name.trim().toLowerCase().replace(/\s+/g, ' ');
            const u = allUsers.find(x => {
                const full = `${(x.nombre||'').trim()} ${(x.apellido||'').trim()}`.trim().toLowerCase().replace(/\s+/g,' ');
                return full === q || full.includes(q) || q.includes(full);
            });
            return u && u.telefono ? u.telefono : null;
        };

        // Calcular nombre del día de mañana en español
        const diaMañana = mañana.toLocaleDateString('es-MX', { weekday: 'long', timeZone: 'America/Mexico_City' });
        const numMañana = mañana.toLocaleDateString('es-MX', { day: '2-digit', timeZone: 'America/Mexico_City' });
        const fechaTxtMañana = `${diaMañana} - ${numMañana}`;

        const yaNotificados = new Set();

        for (const t of tareasManana) {
            const vehiculosNombres = (t.vehiculosAsignados || []).map(vId => {
                const v = allVehs.find(x => x._id.toString() === vId);
                return v ? v.modelo : 'Desconocido';
            }).join(', ') || 'Ninguno';

            let encargadosArr = [];
            if (Array.isArray(t.asignadoANombre)) encargadosArr = t.asignadoANombre.filter(Boolean);
            else if (typeof t.asignadoANombre === 'string') encargadosArr = t.asignadoANombre.split(',').map(s => s.trim()).filter(Boolean);

            let acompanantesArr = [];
            if (Array.isArray(t.cuadrillaNombres)) acompanantesArr = t.cuadrillaNombres.filter(Boolean);
            else if (typeof t.cuadrillaNombres === 'string') acompanantesArr = t.cuadrillaNombres.split(',').map(s => s.trim()).filter(Boolean);

            let herramientasNombres = 'Ninguna';
            if (t.herramientasAsignadas && t.herramientasAsignadas.length > 0) {
                const mongoose = require('mongoose');
                try {
                    const tools = await mongoose.connection.db.collection('inventoryitems').find({ _id: { $in: t.herramientasAsignadas } }).toArray();
                    if (tools.length > 0) {
                        herramientasNombres = tools.map(x => x.nombre).join(', ');
                    }
                } catch(e) { console.error('Error fetching tools for cron message:', e); }
            }

            const todosAsignados = [...new Set([...encargadosArr, ...acompanantesArr])];

            for (const persona of todosAsignados) {
                const tel = findPhoneCron(persona);
                if (!tel) continue;
                const clave = `${t._id}-${tel}`;
                if (yaNotificados.has(clave)) continue;
                yaNotificados.add(clave);

                const esEncargado = encargadosArr.includes(persona);
                const rolTxt = esEncargado ? '👷 *Eres el Encargado*' : '👥 *Vas como Acompañante*';
                const encargadosTxt = encargadosArr.join(', ') || 'Sin encargado';
                const acompanantesTxtCron = acompanantesArr.join(', ') || 'Nadie';

                // Mensaje COMPLETO de asignación con ACEPTAR/RECHAZAR (igual que si fuera hoy)
                let msgCron;
                if (esEncargado) {
                    msgCron = `🚨 *TAREA PARA MAÑANA (Tú eres el Encargado)* 🚨\n\n📝 Tarea: ${t.descripcion || 'Sin descripción'}\n📅 Fecha: ${fechaTxtMañana}\n🕒 Horario: ${t.horaInicio || 'No definido'} a ${t.horaFin || 'No definido'}\n🏗️ Proyecto: ${t.proyectoId || 'Sin proyecto'}\n🚗 Vehículo(s): ${vehiculosNombres}\n🧰 Herramientas: ${herramientasNombres}\n👥 Te acompañan: ${acompanantesTxtCron}\n\nResponde con:\n✅ *1* — para aceptar\n❌ *2* — para rechazar`;
                } else {
                    msgCron = `🔔 *TAREA PARA MAÑANA (Vas como Acompañante)* 🔔\n\n📝 Tarea: ${t.descripcion || 'Sin descripción'}\n📅 Fecha: ${fechaTxtMañana}\n🕒 Horario: ${t.horaInicio || 'No definido'} a ${t.horaFin || 'No definido'}\n👤 Encargado: ${encargadosTxt}\n🚗 Vehículo(s): ${vehiculosNombres}\n🧰 Herramientas: ${herramientasNombres}\n\nResponde con:\n✅ *1* — para aceptar\n❌ *2* — para rechazar`;
                }

                try {
                    await sendWhatsAppMessage(tel, msgCron, { tipo: esEncargado ? 'tarea_encargado' : 'tarea_acompanante', genero: inferirGenero(persona), nombre: persona });
                    waLog.add(`✅ [CRON] Asignación completa enviada a ${persona} (${tel})`);
                    // Encolar sesión WAITING_TASK_CONFIRM ahora que sí se manda la petición de confirmación
                    try {
                        const chatIdCron = phoneToWaChatId(tel);
                        const altChatIdCron = chatIdCron.startsWith('521') ? chatIdCron.replace('521','52') : chatIdCron.replace(/^52/, '521');
                        const sessionDataCron = { state: 'WAITING_TASK_CONFIRM', ctx: { tareaDesc: t.descripcion, nombreTrabajador: persona, tareaId: t._id ? t._id.toString() : null, proyectoId: t.proyectoId || 'IND' } };
                        await enqueueSession(chatIdCron, sessionDataCron);
                        await enqueueSession(altChatIdCron, sessionDataCron);
                        waLog.add(`📋 [CRON] WAITING_TASK_CONFIRM encolado para ${persona}`);
                    } catch(eQ) { console.error('Error encolando sesión cron:', eQ); }
                } catch(e) {
                    waLog.add(`❌ [CRON] Error enviando asignación a ${persona}: ${e.message}`);
                }
            }
        }

        waLog.add(`⏰ [CRON] Recordatorios finalizados. ${yaNotificados.size} mensaje(s) enviado(s).`);
    } catch(err) {
        console.error('Error en cron de recordatorios de tareas:', err);
        if (typeof waLog !== 'undefined' && waLog.add) waLog.add(`❌ [CRON] Error crítico: ${err.message}`);
    }
}, 60000); // Revisar cada minuto
// --- FIN RECORDATORIOS DE TAREAS ---

// ==========================================
// RUTAS DEL PORTAL DE CLIENTES
// ==========================================
const crypto = require('crypto');

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Registro
app.post('/api/clientes/registro', async (req, res) => {
    try {
        const { nombre, telefono, empresa, correo, password } = req.body;
        if (!nombre || !correo || !password || typeof nombre !== 'string' || typeof correo !== 'string' || typeof password !== 'string' || password.length < 6) {
            return res.status(400).json({ error: 'Datos incompletos, inválidos o contraseña muy corta.' });
        }
        
        const existe = await CRMClientePortal.findOne({ correo: correo.trim().toLowerCase() });
        if (existe) {
            return res.status(409).json({ error: 'El correo ya está registrado.' });
        }

        const nuevoCliente = new CRMClientePortal({
            nombre: nombre.trim(),
            telefono: telefono ? telefono.trim() : '',
            empresa: empresa ? empresa.trim() : '',
            correo: correo.trim().toLowerCase(),
            passwordHash: hashPassword(password),
            aprobado: false // Requiere aprobación del admin
        });

        await nuevoCliente.save();
        res.status(201).json({ message: 'Cuenta creada. Espera la aprobación de un administrador.' });
    } catch (err) {
        res.status(500).json({ error: 'Error al registrar cliente: ' + err.message });
    }
});

// Login nativo para el CRM (Empleados)
app.post('/api/login', async (req, res) => {
    try {
        const { correo, password } = req.body;
        if (!correo || !password) {
            return res.status(400).json({ error: 'Faltan credenciales.' });
        }

        const searchCorreo = String(correo).trim().toLowerCase();
        const empleado = await UserRef.findOne({ correo: searchCorreo });

        if (!empleado) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        if (empleado.password !== password) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        if (empleado.estadoCuenta === 'pendiente') {
            return res.status(403).json({ error: 'Tu cuenta está pendiente de aprobación.' });
        }
        if (empleado.estadoCuenta === 'rechazada') {
            return res.status(403).json({ error: 'Tu cuenta ha sido rechazada.' });
        }

        // Devolvemos el empleado completo en el objeto "user" como espera el frontend
        return res.json({ 
            message: 'Login exitoso', 
            user: empleado 
        });

    } catch (error) {
        console.error('Error en /api/login:', error);
        return res.status(500).json({ error: 'Error en el servidor al intentar iniciar sesión.' });
    }
});

// Login
app.post('/api/clientes/login', async (req, res) => {
    try {
        const { correo, password } = req.body;
        if (!correo || !password || typeof correo !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Correo y contraseña son requeridos y deben ser válidos.' });

        const searchCorreo = correo.trim().toLowerCase();

        // 1. Buscar si es un empleado/admin en la base de datos principal
        const empleado = await UserRef.findOne({ correo: searchCorreo });
        if (empleado) {
            const isMaster = (searchCorreo === 'jonathan@naisata.com');
            
            if (empleado.password !== password) {
                return res.status(401).json({ error: 'Credenciales inválidas.' });
            }

            if (!isMaster) {
                if (empleado.estadoCuenta === 'pendiente') return res.status(403).json({ error: 'Tu cuenta está pendiente de aprobación.', pendiente: true });
                if (empleado.estadoCuenta === 'rechazada') return res.status(403).json({ error: 'Tu cuenta ha sido rechazada.' });
                
                // Solo admin puede entrar al portal desde la colección de usuarios (o si quieres permitir todos, quita este if)
                if (empleado.rol !== 'admin' && empleado.rol !== 'socio') {
                    return res.status(403).json({ error: 'Tu rol no tiene permiso para ingresar como administrador al portal.' });
                }
            }

            const token = generateToken();
            empleado.tokenPortal = token;
            await empleado.save();

            return res.json({ 
                token, 
                cliente: { 
                    id: empleado._id, 
                    nombre: `${empleado.nombre} ${empleado.apellido || ''}`.trim(), 
                    empresa: 'Administración Naisata', 
                    correo: empleado.correo,
                    isAdmin: true
                } 
            });
        }

        // 2. Si no es empleado, buscar en la tabla de clientes del portal
        const cliente = await CRMClientePortal.findOne({ correo: searchCorreo });
        if (!cliente) return res.status(401).json({ error: 'Credenciales inválidas.' });

        if (cliente.passwordHash !== hashPassword(password)) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        if (!cliente.aprobado) {
            return res.status(403).json({ error: 'Cuenta en revisión.', pendiente: true });
        }

        const token = generateToken();
        cliente.token = token;
        await cliente.save();

        res.json({ token, cliente: { id: cliente._id, nombre: cliente.nombre, empresa: cliente.empresa, correo: cliente.correo } });
    } catch (err) {
        res.status(500).json({ error: 'Error al iniciar sesión: ' + err.message });
    }
});

// Middleware de Auth para Clientes
async function authCliente(req, res, next) {
    const token = req.headers['x-cliente-token'];
    if (!token || typeof token !== 'string') return res.status(401).json({ error: 'No autorizado o token inválido' });

    // Buscar primero en clientes
    let cliente = await CRMClientePortal.findOne({ token, aprobado: true });
    
    // Si no está, buscar en administradores/empleados
    if (!cliente) {
        const empleado = await UserRef.findOne({ tokenPortal: token });
        if (empleado) {
            cliente = {
                _id: empleado._id,
                nombre: `${empleado.nombre} ${empleado.apellido || ''}`.trim(),
                empresa: 'Administración Naisata',
                correo: empleado.correo,
                isAdmin: true,
                save: async () => { empleado.tokenPortal = null; await empleado.save(); } // para el logout
            };
        }
    }

    if (!cliente) return res.status(401).json({ error: 'Token inválido o expirado' });

    req.cliente = cliente;
    next();
}

// Obtener datos del cliente actual
app.get('/api/clientes/me', authCliente, (req, res) => {
    res.json({ 
        id: req.cliente._id, 
        nombre: req.cliente.nombre, 
        empresa: req.cliente.empresa, 
        correo: req.cliente.correo,
        isAdmin: req.cliente.isAdmin
    });
});

// Logout
// --- FUNCIÓN DE NOTIFICACIÓN SILENCIOSA (De fondo) ---
const notificarAdminsSilencioso = async (cliente, folioAviso, accionStr) => {
    try {
        const admins = await UserRef.find({ 
            telefono: { $exists: true, $ne: null, $ne: '' },
            $or: [
                { rol: { $regex: /admin|administrador|master/i } },
                { correo: { $regex: /jonathan|daniel/i } }
            ]
        });
        
        console.log(`[Notificaciones] Admins encontrados para enviar alerta: ${admins.length}`);
        if (!admins || admins.length === 0) return;
        
        const clienteAviso = cliente.nombre + (cliente.empresa ? ` (${cliente.empresa})` : '');
        const mensaje = `🔔 *ALERTA CRM - PORTAL CLIENTES*\nEl cliente *${clienteAviso}* ha ingresado a su portal y está ${accionStr} la cotización *${folioAviso}*.\n\n💡 _Revisa la plataforma para ver los detalles._`;
        
        for (const admin of admins) {
            if (admin.telefono) {
                const cleanPhone = admin.telefono.replace(/\D/g, '');
                if (cleanPhone.length >= 10) {
                    await sendWhatsAppMessage(admin.telefono, mensaje).catch(()=>{});
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
    } catch (err) {
        console.error('Error enviando alerta silenciosa:', err.message);
    }
};
// ---------------------------------------------------

// Endpoint para notificar que el cliente está editando
app.post('/api/clientes/cotizaciones/:id/notificar-edicion', authCliente, async (req, res) => {
    try {
        const original = await CRMCotizacion.findById(req.params.id);
        if (!original) return res.status(404).json({ error: 'Cotización no encontrada' });
        
        // Ejecutar de fondo
        notificarAdminsSilencioso(req.cliente, original.folio || 'Sin Folio', 'editando (trabajando en)');
        
        res.json({ message: 'Notificación enviada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clientes/logout', authCliente, async (req, res) => {
    try {
        req.cliente.token = null;
        await req.cliente.save();
        res.json({ message: 'Sesión cerrada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Consultar mis cotizaciones compartidas
app.get('/api/clientes/mis-cotizaciones', authCliente, async (req, res) => {
    try {
        let query = {};
        
        if (req.cliente.isAdmin) {
            // Un administrador puede ver todas las cotizaciones en proceso o terminadas
            query = { estado: { $nin: ['Neutral'] } };
        } else {
            // Un cliente solo ve las suyas
            query = {
                $or: [
                    { 'contacto': req.cliente.nombre },
                    { 'clienteNombre': req.cliente.empresa },
                    { 'creadorCorreo': req.cliente.correo },
                    { 'accesosPortal': req.cliente._id.toString() }
                ],
                estado: { $nin: ['Neutral'] }
            };
        }

        const cotizaciones = await CRMCotizacion.find(query)
            .select('folio clienteNombre descripcion total estado fechaCreacion')
            .sort({ fechaCreacion: -1 });

        res.json(cotizaciones);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ver detalles de una cotización específica (Vista Previa)
app.get('/api/clientes/cotizaciones/:id/preview', authCliente, async (req, res) => {
    try {
        const { id } = req.params;
        const cot = await CRMCotizacion.findById(id);
        if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

        // Verificamos si tiene acceso
        const esSuya = cot.contacto === req.cliente.nombre || 
                       cot.clienteNombre === req.cliente.empresa || 
                       cot.creadorCorreo === req.cliente.correo ||
                       (cot.accesosPortal && cot.accesosPortal.includes(req.cliente._id.toString()));

        if (!esSuya && !req.cliente.isAdmin) {
            return res.status(403).json({ error: 'No tienes permiso para ver esta cotización' });
        }

        const puedeModificar = cot.permisosPortalModificacion && cot.permisosPortalModificacion.includes(req.cliente._id.toString());
        res.json({ ...cot.toObject(), puedeModificar });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Consultar proyectos operativos autorizados para el cliente (solo lectura)
app.get('/api/clientes/mis-proyectos', authCliente, async (req, res) => {
    try {
        const query = req.cliente.isAdmin
            ? {}
            : { accesosPortal: req.cliente._id.toString() };
        const proyectos = await CRMProyecto.find(query)
            .select('folio nombre clienteNombre estado porcentajeAvance fechaInicio')
            .sort({ fechaInicio: -1 });
        res.json(proyectos);
    } catch (err) {
        res.status(500).json({ error: 'Error obteniendo proyectos operativos' });
    }
});

// Ver el panel operativo autorizado. No expone campos administrativos ni permite cambios.
app.get('/api/clientes/proyectos/:id', authCliente, async (req, res) => {
    try {
        const proyecto = await CRMProyecto.findById(req.params.id);
        if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

        const tieneAcceso = req.cliente.isAdmin ||
            (proyecto.accesosPortal || []).includes(req.cliente._id.toString());
        if (!tieneAcceso) {
            return res.status(403).json({ error: 'No tienes permiso para ver este panel operativo' });
        }

        res.json({
            _id: proyecto._id,
            folio: proyecto.folio,
            nombre: proyecto.nombre,
            clienteNombre: proyecto.clienteNombre,
            estado: proyecto.estado,
            fechaInicio: proyecto.fechaInicio,
            fechaFin: proyecto.fechaFin,
            porcentajeAvance: proyecto.porcentajeAvance || 0,
            facturas: (proyecto.facturas || []).map(f => ({
                folio: f.folio,
                monto: f.monto,
                archivoUrl: f.archivoUrl,
                fecha: f.fecha
            })),
            avances: (proyecto.avances || []).map(a => ({
                fecha: a.fecha,
                porcentaje: a.porcentaje,
                porcentajeProyecto: a.porcentajeProyecto,
                comentario: a.comentario,
                fotos: a.fotos || []
            })),
            archivos: proyecto.archivos || []
        });
    } catch (err) {
        res.status(500).json({ error: 'Error obteniendo el panel operativo' });
    }
});

// Crear una copia modificada de una cotización (por el cliente)
app.post('/api/clientes/cotizaciones/:id/modificar', authCliente, async (req, res) => {
    try {
        const { id } = req.params;
        const { partidas, notas, clienteNombre, contacto } = req.body;
        
        const original = await CRMCotizacion.findById(id);
        if (!original) return res.status(404).json({ error: 'Cotización original no encontrada' });
        
        // Verificar permiso de modificación
        const puedeModificar = original.permisosPortalModificacion && original.permisosPortalModificacion.includes(req.cliente._id.toString());
        if (!puedeModificar) {
            return res.status(403).json({ error: 'No tienes permiso para modificar esta cotización' });
        }
        
        if (!Array.isArray(partidas)) {
            return res.status(400).json({ error: 'Formato de partidas inválido' });
        }

        // El cliente puede ajustar los datos mostrados en el encabezado de su propuesta.
        const validarTextoEncabezado = (valor, campo) => {
            if (valor !== undefined && (typeof valor !== 'string' || valor.trim().length > 200)) {
                return `El campo ${campo} no es válido`;
            }
            return null;
        };
        const errorCliente = validarTextoEncabezado(clienteNombre, 'razón social');
        const errorContacto = validarTextoEncabezado(contacto, 'contacto');
        if (errorCliente || errorContacto) {
            return res.status(400).json({ error: errorCliente || errorContacto });
        }
        const clienteNombreActualizado = typeof clienteNombre === 'string' ? clienteNombre.trim() : original.clienteNombre;
        const contactoActualizado = typeof contacto === 'string' ? contacto.trim() : original.contacto;

        // Calcular totales
        let subtotal = 0;
        const partidasNuevas = partidas.map(p => {
            const qty = parseFloat(p.cantidad) || 0;
            const price = parseFloat(p.precioUnitario) || 0;
            const tot = qty * price;
            subtotal += tot;
            return {
                descripcion: String(p.descripcion || ''),
                cantidad: qty,
                um: String(p.um || 'mts'),
                precioUnitario: price,
                total: tot
            };
        });
        
        const iva = subtotal * 0.16;
        const total = subtotal; // Mantenemos consistencia con el CRM: 'total' es el subtotal, el IVA se suma en la vista
        
        if (original.cotizacionOriginalId) {
            // Ya es una copia, actualizamos la copia
            original.partidas = partidasNuevas;
            original.subtotal = subtotal;
            original.iva = iva;
            original.total = total;
            original.fechaCreacion = new Date(); // Actualizamos la fecha de la copia
            // Actualizar notas si se enviaron
            if (typeof notas === 'string') original.notas = notas;
            original.clienteNombre = clienteNombreActualizado;
            original.contacto = contactoActualizado;
            await original.save();
            res.json({ message: 'Cotización modificada y actualizada', id: original._id });
        } else {
            // Es la original, creamos una copia
            const nuevaFolio = original.folio ? `${original.folio}-MOD` : `MOD-${Date.now().toString().slice(-6)}`;
            
            const copia = new CRMCotizacion({
                ...original.toObject(),
                _id: new mongoose.Types.ObjectId().toString(),
                folio: nuevaFolio,
                partidas: partidasNuevas,
                subtotal,
                iva,
                total,
                // Guardar notas editadas por el cliente si se enviaron
                notas: typeof notas === 'string' ? notas : original.notas,
                clienteNombre: clienteNombreActualizado,
                contacto: contactoActualizado,
                fechaCreacion: new Date(),
                estado: 'En Proceso', // estado para la copia
                cotizacionOriginalId: original._id.toString(),
                esModificadaPorCliente: true,
                accesosPortal: [req.cliente._id.toString()],
                permisosPortalModificacion: [req.cliente._id.toString()]
            });
            
            await copia.save();
            res.json({ message: 'Cotización modificada y guardada como nueva versión', id: copia._id });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// RUTAS DE ADMINISTRACIÓN - PORTAL CLIENTES
// ==========================================

// Obtener todos los clientes del portal
app.get('/api/admin/clientes-portal', async (req, res) => {
    try {
        const clientesRaw = await CRMClientePortal.find().sort({ fechaRegistro: -1 });
        const clientes = clientesRaw.map(c => {
            const obj = c.toObject();
            obj.estado = obj.aprobado ? 'aprobado' : 'pendiente';
            return obj;
        });
        res.json(clientes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cambiar estado de aprobación de un cliente
app.put('/api/admin/clientes-portal/:id/estado', async (req, res) => {
    try {
        const { id } = req.params;
        const { estado, aprobado } = req.body;
        const esAprobado = estado === 'aprobado' || aprobado === true;
        
        const cliente = await CRMClientePortal.findByIdAndUpdate(id, { aprobado: esAprobado }, { new: true });
        if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
        res.json(cliente);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener clientes que tienen acceso a una cotización específica
app.get('/api/admin/cotizaciones/:id/clientes-con-acceso', async (req, res) => {
    try {
        const { id } = req.params;
        const cot = await CRMCotizacion.findById(id);
        if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
        
        const accesos = cot.accesosPortal || [];
        const mods = cot.permisosPortalModificacion || [];
        const proyecto = await CRMProyecto.findOne({ cotizacionId: id }).select('accesosPortal');
        const accesosOperativos = proyecto ? (proyecto.accesosPortal || []) : [];
        const clientesRaw = await CRMClientePortal.find({ _id: { $in: accesos } }).select('-passwordHash -token').lean();
        
        const clientes = clientesRaw.map(c => ({
            ...c,
            nivel: mods.includes(c._id.toString()) ? 'modificacion' : 'lectura',
            panelOperativo: accesosOperativos.includes(c._id.toString())
        }));
        
        res.json(clientes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Otorgar acceso a una cotización para un cliente
app.post('/api/admin/clientes-portal/:clienteId/acceso', async (req, res) => {
    try {
        const { clienteId } = req.params;
        const { cotizacionId, nivel, incluirPanelOperativo } = req.body;
        
        const cot = await CRMCotizacion.findById(cotizacionId);
        if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
        
        if (!cot.accesosPortal) cot.accesosPortal = [];
        if (!cot.permisosPortalModificacion) cot.permisosPortalModificacion = [];
        
        // Siempre otorgamos lectura si no la tiene
        if (!cot.accesosPortal.includes(clienteId)) {
            cot.accesosPortal.push(clienteId);
        }
        
        // Gestionar el nivel de modificación
        if (nivel === 'modificacion') {
            if (!cot.permisosPortalModificacion.includes(clienteId)) {
                cot.permisosPortalModificacion.push(clienteId);
            }
        } else {
            // Nivel es lectura, quitamos permiso de modificación si lo tenía
            cot.permisosPortalModificacion = cot.permisosPortalModificacion.filter(id => id !== clienteId);
        }
        
        await cot.save();

        // El acceso al panel operativo se concede de forma explícita y siempre es de solo lectura.
        // Si aún no existe un proyecto para la cotización, el acceso de cotización se conserva.
        let panelOperativoDisponible = false;
        if (incluirPanelOperativo) {
            const proyecto = await CRMProyecto.findOne({ cotizacionId });
            if (proyecto) {
                if (!proyecto.accesosPortal) proyecto.accesosPortal = [];
                if (!proyecto.accesosPortal.includes(clienteId)) {
                    proyecto.accesosPortal.push(clienteId);
                    await proyecto.save();
                }
                panelOperativoDisponible = true;
            }
        }

        // Aplicar los mismos permisos a todas las copias (MOD) generadas a partir de esta original
        const copias = await CRMCotizacion.find({ cotizacionOriginalId: cotizacionId });
        for (const copia of copias) {
            let copiaMod = false;
            if (!copia.accesosPortal) copia.accesosPortal = [];
            if (!copia.permisosPortalModificacion) copia.permisosPortalModificacion = [];
            
            if (!copia.accesosPortal.includes(clienteId)) {
                copia.accesosPortal.push(clienteId);
                copiaMod = true;
            }
            
            if (nivel === 'modificacion') {
                if (!copia.permisosPortalModificacion.includes(clienteId)) {
                    copia.permisosPortalModificacion.push(clienteId);
                    copiaMod = true;
                }
            } else {
                if (copia.permisosPortalModificacion.includes(clienteId)) {
                    copia.permisosPortalModificacion = copia.permisosPortalModificacion.filter(id => id !== clienteId);
                    copiaMod = true;
                }
            }
            if (copiaMod) await copia.save();
        }

        // --- NOTIFICACIÓN AL CLIENTE (OPCIONAL) ---
        if (req.body.notificarWhatsapp) {
            const clienteNotificar = await CRMClientePortal.findById(clienteId);
            if (clienteNotificar && clienteNotificar.telefono) {
                const numLimpio = clienteNotificar.telefono.replace(/\D/g, '');
                if (numLimpio.length >= 10) {
                    const mensaje = `🔔 *NUEVA COTIZACIÓN DISPONIBLE*\n¡Hola *${clienteNotificar.nombre}*!\n\nSe te ha otorgado acceso a la cotización *${cot.folio || 'Sin Folio'}* en tu Portal de Clientes de Naisata.\n\n💡 _Ingresa con tu correo y contraseña para revisarla._`;
                    // Enviar de fondo sin await
                    sendWhatsAppMessage(clienteNotificar.telefono, mensaje).catch(() => {});
                }
            }
        }
        // ------------------------------------------

        res.json({
            message: panelOperativoDisponible
                ? 'Acceso a cotización y panel operativo otorgado exitosamente'
                : 'Acceso a cotización otorgado exitosamente',
            panelOperativoDisponible
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Revocar únicamente el acceso de solo lectura al panel operativo.
app.delete('/api/admin/clientes-portal/:clienteId/acceso-operativo/:cotizacionId', async (req, res) => {
    try {
        const { clienteId, cotizacionId } = req.params;
        const proyecto = await CRMProyecto.findOne({ cotizacionId });
        if (!proyecto) return res.status(404).json({ error: 'Proyecto operativo no encontrado' });
        proyecto.accesosPortal = (proyecto.accesosPortal || []).filter(id => id !== clienteId);
        await proyecto.save();
        res.json({ message: 'Acceso al panel operativo revocado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Revocar acceso a una cotización para un cliente
app.delete('/api/admin/clientes-portal/:clienteId/acceso/:cotizacionId', async (req, res) => {
    try {
        const { clienteId, cotizacionId } = req.params;
        
        const cot = await CRMCotizacion.findById(cotizacionId);
        if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
        
        let modified = false;
        if (cot.accesosPortal) {
            cot.accesosPortal = cot.accesosPortal.filter(id => id !== clienteId);
            modified = true;
        }
        if (cot.permisosPortalModificacion) {
            cot.permisosPortalModificacion = cot.permisosPortalModificacion.filter(id => id !== clienteId);
            modified = true;
        }
        
        if (modified) await cot.save();

        // Revocar acceso también de cualquier copia de esta cotización
        const copias = await CRMCotizacion.find({ cotizacionOriginalId: cotizacionId });
        for (const copia of copias) {
            let copiaMod = false;
            if (copia.accesosPortal && copia.accesosPortal.includes(clienteId)) {
                copia.accesosPortal = copia.accesosPortal.filter(id => id !== clienteId);
                copiaMod = true;
            }
            if (copia.permisosPortalModificacion && copia.permisosPortalModificacion.includes(clienteId)) {
                copia.permisosPortalModificacion = copia.permisosPortalModificacion.filter(id => id !== clienteId);
                copiaMod = true;
            }
            if (copiaMod) await copia.save();
        }
        // Revocar también el panel operativo asociado para que no quede acceso residual.
        const proyecto = await CRMProyecto.findOne({ cotizacionId });
        if (proyecto && (proyecto.accesosPortal || []).includes(clienteId)) {
            proyecto.accesosPortal = proyecto.accesosPortal.filter(id => id !== clienteId);
            await proyecto.save();
        }
        res.json({ message: 'Acceso revocado exitosamente' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor CRM corriendo en http://localhost:${PORT} con WebSocket`);
});
