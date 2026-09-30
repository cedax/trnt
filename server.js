import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import WebTorrent from 'webtorrent'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3250)
const TORRENT_PORT = Number(process.env.TORRENT_PORT || 6881)
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'))
const STATE_FILE = path.join(DOWNLOAD_DIR, '.magnet-box-state.json')

// Cambia estos tres valores antes de publicar la aplicación.
const APP_USER = 'admin'
const APP_PASSWORD = 'cambia-esta-clave'
const SESSION_SECRET = 'cambia-tambien-esta-frase-larga-y-privada'

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const SEEDER_TIMEOUT_MS = 90_000
const STREAM_CHUNK_BYTES = 8 * 1024 * 1024
const SEARCH_IMPORT_LIMIT = Math.min(100, Math.max(1, Number(process.env.SEARCH_IMPORT_LIMIT) || 50))
const SEARCH_API_URL = 'https://apibay.org/q.php'
const MAGNET_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce'
]
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
let stateSaveTimer = null
let stateWriteQueue = Promise.resolve()

client.on('error', (error) => console.error('WebTorrent:', error.message))

function encodeBytes(value) {
  return value ? Buffer.from(value).toString('base64') : null
}

function scheduleStateSave(delay = 500) {
  clearTimeout(stateSaveTimer)
  stateSaveTimer = setTimeout(() => saveStateNow(), delay)
  stateSaveTimer.unref?.()
}

async function captureFileModtimes(job) {
  if (!job.torrent?.ready || job.torrent.destroyed) return
  if (job.addUID) {
    job.fileModtimes = await Promise.all(job.torrent.files.map(async (file) => {
      const absolute = path.join(DOWNLOAD_DIR, torrentStorageRelativePath(job, file))
      const stat = await fs.promises.stat(absolute).catch(() => null)
      return stat?.mtimeMs
    }))
    return
  }
  job.fileModtimes = await new Promise((resolve) => {
    job.torrent.getFileModtimes((error, values) => resolve(error ? null : values))
  })
}

async function saveStateNow() {
  const records = [...jobs.values()].map((job) => {
    const torrent = job.torrent
    return {
      magnet: job.magnet,
      paused: job.status === 'pausado',
      complete: job.status === 'completo',
      bitfield: torrent?.bitfield ? encodeBytes(torrent.bitfield.buffer) : job.cachedBitfield,
      torrentFile: torrent?.torrentFile ? encodeBytes(torrent.torrentFile) : job.cachedTorrentFile,
      announce: torrent?.announce || job.cachedAnnounce || [],
      addUID: job.addUID,
      createdAt: job.createdAt,
      fileModtimes: job.fileModtimes || null,
      updatedAt: Date.now()
    }
  })
  const contents = JSON.stringify({ version: 1, torrents: records }, null, 2)
  stateWriteQueue = stateWriteQueue
    .catch(() => {})
    .then(() => fs.promises.writeFile(STATE_FILE, contents, { encoding: 'utf8', mode: 0o600 }))
    .catch((error) => console.error('No se pudo guardar el estado:', error.message))
  return stateWriteQueue
}

const stateCheckpoint = setInterval(() => scheduleStateSave(0), 10_000)
stateCheckpoint.unref?.()

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

function parseSearchLink(value) {
  try {
    const url = new URL(value)
    if (!['http:','https:'].includes(url.protocol)) return null
    const host = url.hostname.toLowerCase()
    if (!host.includes('pirate') && !host.includes('tpb') && host !== 'apibay.org') return null
    const parts = url.pathname.split('/').filter(Boolean)
    const searchIndex = parts.findIndex((part) => part.toLowerCase() === 'search')
    const parameterQuery = url.searchParams.get('q') || url.searchParams.get('query') || url.searchParams.get('search')
    const query = parameterQuery || (searchIndex >= 0 ? decodeURIComponent(parts[searchIndex + 1] || '') : '')
    const legacyCategory = searchIndex >= 0 ? parts[searchIndex + 4] : ''
    const category = url.searchParams.get('cat') || legacyCategory || '0'
    if (!query?.trim()) return null
    return {
      query: query.replace(/\+/g, ' ').trim(),
      category: /^\d+$/.test(category) ? category : '0'
    }
  } catch {
    return null
  }
}

function searchResultMagnet(result) {
  const hash = String(result.info_hash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(hash)) return null
  const params = new URLSearchParams({ xt: `urn:btih:${hash}`, dn: String(result.name || hash) })
  MAGNET_TRACKERS.forEach((tracker) => params.append('tr', tracker))
  return `magnet:?${params}`
}

async function fetchSearchResults(search) {
  const url = new URL(SEARCH_API_URL)
  url.searchParams.set('q', search.query)
  url.searchParams.set('cat', search.category)
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Magnet-Box/1.0' },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`El índice respondió con estado ${response.status}.`)
  const results = await response.json()
  if (!Array.isArray(results)) throw new Error('El índice devolvió una respuesta inválida.')
  return results
}

function isVideo(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())
}

function torrentStorageRelativePath(job, file) {
  const relative = job.addUID
    ? path.join(`${job.torrent.name} - ${job.torrent.infoHash.slice(0, 8)}`, file.path)
    : file.path
  return relative.split(path.sep).join('/')
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
    createdAt: job.createdAt,
    files: (torrent.files || []).map((file, index) => ({
      index,
      name: file.name,
      length: file.length,
      video: canStream && isVideo(file.name),
      complete: file.done,
      progress: Number.isFinite(file.progress) ? file.progress : 0,
      streamUrl: `/api/torrents/${torrent.infoHash}/files/${index}/stream`
    }))
  }
}

function wireHasUsefulPiece(torrent, wire) {
  if (!wire?.peerPieces || !torrent.pieces?.length) return false
  for (let index = 0; index < torrent.pieces.length; index += 1) {
    if (!torrent.bitfield?.get(index) && wire.peerPieces.get(index)) return true
  }
  return false
}

function waitForSources(torrent, job) {
  let started = false
  let sourceFound = false

  const selectMissingFiles = () => {
    if (started || torrent.destroyed) return
    const missingFiles = torrent.files.filter((file) => !file.done)
    const completeCount = torrent.files.length - missingFiles.length

    if (!missingFiles.length) {
      started = true
      job.existingOnly = true
      job.status = 'completo'
      job.message = 'Todos los archivos ya existían completos. No se descargó nada.'
      captureFileModtimes(job).then(() => scheduleStateSave())
      return
    }

    if (job.restorePaused) {
      started = true
      job.status = 'pausado'
      job.message = 'Descarga restaurada en pausa. Los archivos verificados se conservaron.'
      torrent.pause()
      scheduleStateSave()
      return
    }

    started = true
    job.status = 'descargando'
    job.message = completeCount
      ? `Omitiendo ${completeCount} archivo${completeCount === 1 ? '' : 's'} ya completo${completeCount === 1 ? '' : 's'}. Descargando solo lo que falta.`
      : 'Pares con piezas disponibles. Descargando.'
    missingFiles.forEach((file) => file.select())
    torrent.resume()
    scheduleStateSave()
  }

  const beginDownload = () => {
    if (started || sourceFound || torrent.destroyed) return
    const hasUsefulSource = torrent.wires.some((wire) => wireHasUsefulPiece(torrent, wire))
    if (!hasUsefulSource) return
    sourceFound = true
    clearTimeout(job.timer)
    job.status = 'verificando'
    job.message = 'Hay piezas disponibles. Terminando la verificación local…'
    if (torrent.ready) selectMissingFiles()
  }

  torrent.on('ready', () => {
    if (started || !torrent.files.length) return
    if (torrent.files.every((file) => file.done)) {
      started = true
      clearTimeout(job.timer)
      job.existingOnly = true
      job.status = 'completo'
      job.message = 'Todos los archivos ya existían completos. No se descargó nada.'
      captureFileModtimes(job).then(() => scheduleStateSave())
      return
    }
    beginDownload()
    if (job.restorePaused || sourceFound) selectMissingFiles()
  })

  const watchWire = (wire) => {
    beginDownload()
    wire.on('bitfield', beginDownload)
    wire.on('have', beginDownload)
    wire.on('have-all', beginDownload)
  }

  torrent.wires.forEach(watchWire)
  torrent.on('wire', watchWire)
  beginDownload()

  job.timer = setTimeout(() => {
    if (started) return
    job.status = 'esperando'
    job.message = 'Aún no hay pares con piezas útiles. La búsqueda continúa sin descargar.'
    scheduleStateSave()
  }, SEEDER_TIMEOUT_MS)
}

function addMagnet(magnet, resumeState = null) {
  const saved = resumeState || {}
  const addUID = resumeState ? Boolean(saved.addUID) : true
  // Descubre pares y metadatos, pero no solicita piezas todavía.
  const options = { path: DOWNLOAD_DIR, deselect: true, addUID }
  if (saved.bitfield) options.bitfield = Buffer.from(saved.bitfield, 'base64')
  if (!addUID && saved.complete && Array.isArray(saved.fileModtimes)) options.fileModtimes = saved.fileModtimes
  if (Array.isArray(saved.announce)) options.announce = saved.announce
  const torrentSource = saved.torrentFile
    ? Buffer.from(saved.torrentFile, 'base64')
    : magnet
  const torrent = client.add(torrentSource, options)
  const job = {
    torrent,
    magnet,
    status: 'buscando',
    message: saved.torrentFile ? 'Restaurando torrent desde la caché…' : 'Buscando metadatos y pares…',
    timer: null,
    streams: new Set(),
    preexistingComplete: new Set(),
    existingOnly: false,
    restorePaused: Boolean(saved.paused),
    cachedBitfield: saved.bitfield || null,
    cachedTorrentFile: saved.torrentFile || null,
    cachedAnnounce: saved.announce || [],
    fileModtimes: saved.fileModtimes || null,
    addUID,
    createdAt: saved.createdAt || Date.now()
  }
  const registerJob = () => {
    jobs.set(torrent.infoHash, job)
    scheduleStateSave()
  }
  if (torrent.infoHash) registerJob()
  else torrent.once('_infoHash', registerJob)

  job.timer = setTimeout(() => {
    job.status = 'esperando'
    job.message = 'Aún no se obtienen metadatos. La búsqueda de pares continúa.'
    scheduleStateSave()
  }, SEEDER_TIMEOUT_MS)

  torrent.on('metadata', () => {
    clearTimeout(job.timer)
    job.cachedTorrentFile = encodeBytes(torrent.torrentFile)
    job.cachedAnnounce = torrent.announce || []
    job.status = 'verificando'
    job.message = saved.bitfield
      ? 'Usando la caché para comprobar rápidamente los archivos…'
      : 'Verificando archivos existentes y buscando piezas disponibles…'
    waitForSources(torrent, job)
    scheduleStateSave()
  })

  torrent.on('ready', () => {
    job.preexistingComplete = new Set(
      torrent.files.filter((file) => file.done).map((file) => file.path)
    )
    scheduleStateSave()
  })

  torrent.on('done', async () => {
    clearTimeout(job.timer)
    job.status = 'completo'
    job.message = job.existingOnly
      ? 'Todos los archivos ya existían completos. No se descargó nada.'
      : 'Descarga completa.'
    await captureFileModtimes(job)
    scheduleStateSave()
  })

  torrent.on('error', (error) => {
    clearTimeout(job.timer)
    job.status = 'error'
    job.message = error.message || 'La descarga falló.'
    scheduleStateSave()
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

function incompleteTorrentPaths() {
  const paths = new Set()
  for (const job of jobs.values()) {
    for (const file of job.torrent.files || []) {
      if (!file.done) paths.add(torrentStorageRelativePath(job, file))
    }
  }
  return paths
}

async function listVideos(directory = DOWNLOAD_DIR, base = DOWNLOAD_DIR, incomplete = incompleteTorrentPaths()) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return listVideos(absolute, base, incomplete)
    if (!entry.isFile() || !isVideo(entry.name)) return []
    const stat = await fs.promises.stat(absolute)
    const relative = path.relative(base, absolute).split(path.sep).join('/')
    if (incomplete.has(relative)) return []
    return [{ name: entry.name, path: relative, length: stat.size, modifiedAt: stat.mtimeMs, complete: true, progress: 1, streamUrl: `/media?file=${encodeURIComponent(relative)}` }]
  }))
  return nested.flat()
}

function parseRange(range, length, chunkOpenEnded = false) {
  if (!range) return { start: 0, end: length - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!match || (!match[1] && !match[2])) return null

  let start
  let end
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(length - suffixLength, 0)
    end = length - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : length - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    if (!match[2] && chunkOpenEnded) end = Math.min(start + STREAM_CHUNK_BYTES - 1, length - 1)
    else end = Math.min(end, length - 1)
  }
  if (start < 0 || start > end || start >= length) return null
  return { start, end, partial: true }
}

function pipeTorrentStream(req, res, file, job, range) {
  const stream = file.createReadStream({ start: range.start, end: range.end })
  job.streams.add(stream)

  const stop = () => {
    if (!stream.destroyed) stream.destroy()
  }
  const cleanup = () => {
    job.streams.delete(stream)
    req.off('aborted', stop)
    res.off('close', stop)
  }
  req.once('aborted', stop)
  res.once('close', stop)
  stream.once('close', cleanup)
  stream.once('end', cleanup)
  stream.on('error', () => {
    cleanup()
    if (!res.destroyed) res.destroy()
  })
  stream.pipe(res)
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
  if (existing) return res.status(409).json({ error: 'Ese torrent ya está activo o fue restaurado desde la caché.' })

  try {
    const torrent = addMagnet(magnet)
    const id = await waitForInfoHash(torrent)
    res.status(202).json({ id, message: 'Magnet agregado. Buscando pares con piezas disponibles…' })
  } catch (error) {
    res.status(400).json({ error: error.message || 'No se pudo agregar el magnet.' })
  }
})

app.post('/api/import-search', requireAuth, async (req, res) => {
  const search = parseSearchLink(String(req.body?.url || '').trim())
  if (!search) return res.status(400).json({ error: 'Pega una URL válida de resultados de búsqueda.' })

  try {
    const results = await fetchSearchResults(search)
    const seen = new Set()
    const eligible = results
      .map((result) => ({ ...result, seedCount: Number.parseInt(result.seeders, 10) || 0, magnet: searchResultMagnet(result) }))
      .filter((result) => result.seedCount > 0 && result.magnet)
      .sort((left, right) => right.seedCount - left.seedCount)
      .filter((result) => {
        const hash = result.info_hash.toLowerCase()
        if (seen.has(hash)) return false
        seen.add(hash)
        return true
      })

    let added = 0
    let duplicates = 0
    let failed = 0
    for (const result of eligible.slice(0, SEARCH_IMPORT_LIMIT)) {
      try {
        if (await client.get(result.magnet)) {
          duplicates += 1
          continue
        }
        const torrent = addMagnet(result.magnet)
        await waitForInfoHash(torrent)
        added += 1
      } catch {
        failed += 1
      }
    }

    const withoutSeeders = results.filter((result) => (Number.parseInt(result.seeders, 10) || 0) <= 0).length
    const limited = Math.max(0, eligible.length - SEARCH_IMPORT_LIMIT)
    const details = [
      `${added} agregados`,
      `${withoutSeeders} ignorados sin seeders`,
      duplicates ? `${duplicates} duplicados` : '',
      failed ? `${failed} con error` : '',
      limited ? `${limited} omitidos por el límite de ${SEARCH_IMPORT_LIMIT}` : ''
    ].filter(Boolean).join(' · ')
    res.status(202).json({ added, withoutSeeders, duplicates, failed, limited, message: `Importación terminada: ${details}.` })
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError'
    res.status(502).json({ error: timeout ? 'El índice tardó demasiado en responder.' : (error.message || 'No se pudo consultar el índice.') })
  }
})

app.post('/api/torrents/:id/pause', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Descarga no encontrada.' })
  if (job.status !== 'descargando') return res.status(409).json({ error: 'Esta descarga no se puede pausar ahora.' })

  job.streams.forEach((stream) => stream.destroy())
  job.streams.clear()
  job.torrent.files.forEach((file) => file.deselect())
  job.torrent.pause()
  job.restorePaused = true
  job.status = 'pausado'
  job.message = 'Descarga pausada.'
  scheduleStateSave()
  res.json({ ok: true })
})

app.post('/api/torrents/:id/resume', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Descarga no encontrada.' })
  if (job.status !== 'pausado') return res.status(409).json({ error: 'Esta descarga no está pausada.' })

  job.torrent.files.filter((file) => !file.done).forEach((file) => file.select())
  job.torrent.resume()
  job.restorePaused = false
  job.status = 'descargando'
  job.message = 'Descarga reanudada.'
  scheduleStateSave()
  res.json({ ok: true })
})

app.delete('/api/torrents/:id', requireAuth, async (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Descarga no encontrada.' })
  if (job.status === 'completo') return res.status(409).json({ error: 'La descarga ya está completa.' })

  clearTimeout(job.timer)
  job.streams.forEach((stream) => stream.destroy())
  job.streams.clear()
  jobs.delete(req.params.id)

  const removableFiles = job.torrent.destroyed ? [] : job.torrent.files
    .filter((file) => !job.preexistingComplete.has(file.path))
    .map((file) => path.resolve(DOWNLOAD_DIR, torrentStorageRelativePath(job, file)))
    .filter((absolute) => absolute.startsWith(`${DOWNLOAD_DIR}${path.sep}`))

  if (!job.torrent.destroyed) {
    await new Promise((resolve) => job.torrent.destroy({ destroyStore: false }, resolve))
  }
  await Promise.all(removableFiles.map((file) => fs.promises.unlink(file).catch(() => {})))
  scheduleStateSave(0)
  res.status(204).end()
})

app.delete('/api/torrents/:id/forget', requireAuth, async (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Descarga no encontrada.' })
  if (job.status !== 'completo') return res.status(409).json({ error: 'Solo puedes quitar descargas completas.' })

  job.streams.forEach((stream) => stream.destroy())
  job.streams.clear()
  jobs.delete(req.params.id)
  if (!job.torrent.destroyed) {
    await new Promise((resolve) => job.torrent.destroy({ destroyStore: false }, resolve))
  }
  scheduleStateSave(0)
  res.status(204).end()
})

app.get('/api/library', requireAuth, async (req, res, next) => {
  try {
    const videos = await listVideos()
    videos.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name))
    res.json(videos)
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
  res.setHeader('Cache-Control', job.status === 'completo' ? 'private, max-age=3600' : 'private, no-store')

  if (file.done) {
    const absolute = path.resolve(DOWNLOAD_DIR, torrentStorageRelativePath(job, file))
    if (!absolute.startsWith(`${DOWNLOAD_DIR}${path.sep}`)) return res.status(404).end()
    return res.sendFile(absolute, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).end()
    })
  }

  const parsedRange = parseRange(range, file.length, !file.done)
  if (!parsedRange) {
    return res.status(416).set('Content-Range', `bytes */${file.length}`).end()
  }
  if (parsedRange.partial) {
    res.status(206)
    res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${file.length}`)
  }
  res.setHeader('Content-Length', parsedRange.end - parsedRange.start + 1)
  if (req.method === 'HEAD') return res.end()
  pipeTorrentStream(req, res, file, job, parsedRange)
})

app.get('/media', requireAuth, async (req, res) => {
  const relative = String(req.query.file || '')
  const absolute = path.resolve(DOWNLOAD_DIR, relative)
  const insideDownloadDir = absolute === DOWNLOAD_DIR || absolute.startsWith(`${DOWNLOAD_DIR}${path.sep}`)
  if (!insideDownloadDir || !isVideo(absolute)) return res.status(404).end()
  res.setHeader('Cache-Control', 'private, max-age=3600')
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

async function restorePersistedJobs() {
  let saved
  try {
    saved = JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('No se pudo leer el estado guardado:', error.message)
    return
  }

  for (const record of saved.torrents || []) {
    if (!record?.magnet || !isMagnet(record.magnet)) continue
    try {
      const torrent = addMagnet(record.magnet, record)
      await waitForInfoHash(torrent)
    } catch (error) {
      console.error('No se pudo restaurar un torrent:', error.message)
    }
  }
}

await restorePersistedJobs()

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Magnet Box disponible en http://0.0.0.0:${PORT}`)
  console.log(`Descargas: ${DOWNLOAD_DIR}`)
})

async function shutdown() {
  server.close()
  clearInterval(stateCheckpoint)
  clearTimeout(stateSaveTimer)
  await saveStateNow()
  await new Promise((resolve) => client.destroy(resolve))
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
