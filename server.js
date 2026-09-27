import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import WebTorrent from 'webtorrent'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const TORRENT_PORT = Number(process.env.TORRENT_PORT || 6881)
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'))

// Cambia estos tres valores antes de publicar la aplicación.
const APP_USER = 'admin'
const APP_PASSWORD = 'cambia-esta-clave'
const SESSION_SECRET = 'cambia-tambien-esta-frase-larga-y-privada'

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const SEEDER_TIMEOUT_MS = 35_000
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.ogv'])
const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg'
}

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

const app = express()
// TCP funciona en EC2 sin depender del módulo uTP nativo ni de permisos locales extra.
const client = new WebTorrent({ utp: false, torrentPort: TORRENT_PORT, dhtPort: TORRENT_PORT })
const jobs = new Map()

client.on('error', (error) => console.error('WebTorrent:', error.message))

app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '32kb' }))

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url')
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

function readCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((item) => item.trim().split('=').map(decodeURIComponent))
      .filter(([key, value]) => key && value)
  )
}

function validSession(req) {
  try {
    const token = readCookies(req).session
    if (!token) return false
    const [payload, signature] = token.split('.')
    if (!payload || !signature || !safeEqual(sign(payload), signature)) return false
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now()
  } catch {
    return false
  }
}

function requireAuth(req, res, next) {
  if (!validSession(req)) return res.status(401).json({ error: 'Inicia sesión para continuar.' })
  next()
}

function isMagnet(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'magnet:' && (url.searchParams.getAll('xt').some((xt) => /^urn:btih:[a-z0-9]+$/i.test(xt)))
  } catch {
    return false
  }
}

function isVideo(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())
}

function formatTorrent(torrent, job) {
  const canStream = ['descargando', 'completo'].includes(job.status)
  return {
    id: torrent.infoHash,
    name: torrent.name || 'Obteniendo información…',
    status: job.status,
    message: job.message,
    progress: Number.isFinite(torrent.progress) ? torrent.progress : 0,
    downloaded: torrent.downloaded || 0,
    length: torrent.length || 0,
    speed: torrent.downloadSpeed || 0,
    peers: torrent.numPeers || 0,
    files: (torrent.files || []).map((file, index) => ({
      index,
      name: file.name,
      length: file.length,
      video: canStream && isVideo(file.name),
      streamUrl: `/api/torrents/${torrent.infoHash}/files/${index}/stream`
    }))
  }
}

function wireHasEveryPiece(wire, pieceCount) {
  if (!wire?.peerPieces || !pieceCount) return false
  for (let index = 0; index < pieceCount; index += 1) {
    if (!wire.peerPieces.get(index)) return false
  }
  return true
}

function waitForSeeder(torrent, job) {
  let started = false
  const beginDownload = () => {
    if (started || job.status === 'sin-seeders') return
    const hasSeeder = torrent.wires.some((wire) => wireHasEveryPiece(wire, torrent.pieces.length))
    if (!hasSeeder) return
    started = true
    clearTimeout(job.timer)
    job.status = 'descargando'
    job.message = 'Seeder encontrado. Descargando.'
    torrent.files.forEach((file) => file.select())
    torrent.resume()
  }

  const watchWire = (wire) => {
    beginDownload()
    wire.on('bitfield', beginDownload)
    wire.on('have', beginDownload)
  }

  torrent.wires.forEach(watchWire)
  torrent.on('wire', watchWire)
  beginDownload()

  job.timer = setTimeout(() => {
    if (started) return
    job.status = 'sin-seeders'
    job.message = 'No se encontró ningún seeder completo. No se descargó.'
    torrent.destroy()
  }, SEEDER_TIMEOUT_MS)
}

function addMagnet(magnet) {
  // Descubre pares y metadatos, pero no solicita piezas todavía.
  const torrent = client.add(magnet, { path: DOWNLOAD_DIR, deselect: true })
  const job = {
    torrent,
    status: 'buscando',
    message: 'Buscando metadatos y seeders…',
    timer: null
  }
  const registerJob = () => jobs.set(torrent.infoHash, job)
  if (torrent.infoHash) registerJob()
  else torrent.once('_infoHash', registerJob)

  job.timer = setTimeout(() => {
    job.status = 'sin-seeders'
    job.message = 'No se pudieron obtener metadatos ni confirmar un seeder. No se descargó.'
    torrent.destroy()
  }, SEEDER_TIMEOUT_MS)

  torrent.on('metadata', () => {
    clearTimeout(job.timer)
    job.status = 'verificando'
    job.message = 'Verificando que exista al menos un seeder completo…'
    waitForSeeder(torrent, job)
  })

  torrent.on('done', () => {
    clearTimeout(job.timer)
    job.status = 'completo'
    job.message = 'Descarga completa.'
  })

  torrent.on('error', (error) => {
    clearTimeout(job.timer)
    job.status = 'error'
    job.message = error.message || 'La descarga falló.'
  })

  return torrent
}

function waitForInfoHash(torrent) {
  if (torrent.infoHash) return Promise.resolve(torrent.infoHash)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      torrent.off('_infoHash', onHash)
      torrent.off('error', onError)
    }
    const onHash = () => {
      cleanup()
      resolve(torrent.infoHash)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    torrent.once('_infoHash', onHash)
    torrent.once('error', onError)
  })
}

async function listVideos(directory = DOWNLOAD_DIR, base = DOWNLOAD_DIR) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return listVideos(absolute, base)
    if (!entry.isFile() || !isVideo(entry.name)) return []
    const stat = await fs.promises.stat(absolute)
    const relative = path.relative(base, absolute).split(path.sep).join('/')
    return [{ name: entry.name, path: relative, length: stat.size, streamUrl: `/media?file=${encodeURIComponent(relative)}` }]
  }))
  return nested.flat()
}

app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {}
  if (!safeEqual(username, APP_USER) || !safeEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' })
  }
  const secure = req.secure ? '; Secure' : ''
  res.setHeader('Set-Cookie', `session=${encodeURIComponent(createSession())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`)
  res.json({ ok: true })
})

app.post('/api/logout', requireAuth, (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  res.json({ ok: true })
})

app.get('/api/session', (req, res) => res.json({ authenticated: validSession(req) }))

app.get('/api/torrents', requireAuth, (req, res) => {
  res.json([...jobs.values()].map((job) => formatTorrent(job.torrent, job)))
})

app.post('/api/torrents', requireAuth, async (req, res) => {
  const magnet = String(req.body?.magnet || '').trim()
  if (!isMagnet(magnet)) return res.status(400).json({ error: 'Pega un enlace magnet válido.' })

  const existing = await client.get(magnet)
  if (existing) return res.status(409).json({ error: 'Ese torrent ya está en la lista.' })

  try {
    const torrent = addMagnet(magnet)
    const id = await waitForInfoHash(torrent)
    res.status(202).json({ id, message: 'Magnet agregado. Buscando seeders…' })
  } catch (error) {
    res.status(400).json({ error: error.message || 'No se pudo agregar el magnet.' })
  }
})

app.get('/api/library', requireAuth, async (req, res, next) => {
  try {
    res.json(await listVideos())
  } catch (error) {
    next(error)
  }
})

app.get('/api/torrents/:id/files/:index/stream', requireAuth, async (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job || !['descargando', 'completo'].includes(job.status)) {
    return res.status(409).json({ error: 'El video aún no está listo para streaming.' })
  }
  const torrent = await client.get(req.params.id)
  const file = torrent?.files?.[Number(req.params.index)]
  if (!file || !isVideo(file.name)) return res.status(404).json({ error: 'Video no encontrado.' })

  const range = req.headers.range
  const extension = path.extname(file.name).toLowerCase()
  res.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')

  if (!range) {
    res.setHeader('Content-Length', file.length)
    return file.createReadStream().on('error', () => res.destroy()).pipe(res)
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match) return res.status(416).end()
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Math.min(Number(match[2]), file.length - 1) : file.length - 1
  if (start > end || start >= file.length) return res.status(416).set('Content-Range', `bytes */${file.length}`).end()

  res.status(206)
  res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`)
  res.setHeader('Content-Length', end - start + 1)
  file.createReadStream({ start, end }).on('error', () => res.destroy()).pipe(res)
})

app.get('/media', requireAuth, async (req, res) => {
  const relative = String(req.query.file || '')
  const absolute = path.resolve(DOWNLOAD_DIR, relative)
  const insideDownloadDir = absolute === DOWNLOAD_DIR || absolute.startsWith(`${DOWNLOAD_DIR}${path.sep}`)
  if (!insideDownloadDir || !isVideo(absolute)) return res.status(404).end()
  res.sendFile(absolute, (error) => {
    if (error && !res.headersSent) res.status(error.statusCode || 404).end()
  })
})

app.use(express.static(path.join(__dirname, 'public')))

app.use((error, req, res, next) => {
  console.error(error)
  if (res.headersSent) return next(error)
  res.status(500).json({ error: 'Ocurrió un error inesperado.' })
})

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Magnet Box disponible en http://0.0.0.0:${PORT}`)
  console.log(`Descargas: ${DOWNLOAD_DIR}`)
})

async function shutdown() {
  server.close()
  await new Promise((resolve) => client.destroy(resolve))
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
