import WebTorrent from 'webtorrent'
import { Server } from 'bittorrent-tracker'

const tracker = new Server({ udp: false, ws: false, stats: false })
const seeder = new WebTorrent({ utp: false, torrentPort: 6883, dht: false })
seeder.throttleUpload(64 * 1024)

tracker.listen(6884, '127.0.0.1', () => {
  const content = Buffer.alloc(8 * 1024 * 1024, 65)
  content.name = 'control-test.bin'
  seeder.seed(content, {
    name: 'control-test',
    announce: ['http://127.0.0.1:6884/announce']
  }, (torrent) => console.log(`MAGNET=${torrent.magnetURI}`))
})

async function shutdown() {
  await new Promise((resolve) => seeder.destroy(resolve))
  tracker.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
