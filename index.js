const { Client } = require('whatsapp-web.js')
const fs = require('fs')
const path = require('path')
const fse = require('fs-extra')
const mime = require('mime-types')

const outRoot = path.join(__dirname, 'output')

function sanitize(s) {
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100)
}

function startProgress(totalMs, label) {
  const start = Date.now()
  const width = 40
  const interval = setInterval(() => {
    let elapsed = Date.now() - start
    if (elapsed > totalMs) elapsed = totalMs
    const percent = Math.floor((elapsed * 100) / totalMs)
    const filled = Math.floor((width * percent) / 100)
    const bar = '#'.repeat(filled) + '-'.repeat(width - filled)
    const remain = Math.ceil((totalMs - elapsed) / 1000)
    process.stdout.write(`\r${label} [${bar}] ${percent}% ${remain}s`)
  }, 1000)
  return () => { clearInterval(interval); process.stdout.write('\r') }
}

async function saveMediaIfImageOrVideo(message, chatId) {
  const media = await message.downloadMedia()
  if (!media) return null
  const mt = media.mimetype || ''
  if (!(mt.startsWith('image/') || mt.startsWith('video/'))) return null
  const ext = mime.extension(mt) || 'bin'
  const dir = path.join(outRoot, 'media', chatId)
  await fse.ensureDir(dir)
  const filename = sanitize(message.id._serialized) + '.' + ext
  const filePath = path.join(dir, filename)
  await fse.writeFile(filePath, Buffer.from(media.data, 'base64'))
  return filePath
}

async function exportChat(chat, deadline) {
  if (chat.isGroup) return
  const chatDir = path.join(outRoot, 'chats', chat.id._serialized)
  await fse.ensureDir(chatDir)
  const meta = {
    id: chat.id._serialized,
    name: chat.name || chat.formattedTitle || '',
    isGroup: chat.isGroup || false
  }
  await fse.writeJson(path.join(chatDir, 'chat.json'), meta, { spaces: 0 })
  const stream = fs.createWriteStream(path.join(chatDir, 'messages.jsonl'), { flags: 'w' })
  let before = null
  const seen = new Set()
  while (true) {
    if (deadline && Date.now() > deadline) break
    const opts = before ? { limit: 500, before } : { limit: 500 }
    const msgs = await chat.fetchMessages(opts)
    if (!msgs || msgs.length === 0) break
    for (const m of msgs) {
      const mid = m.id && (m.id._serialized || m.id.id) || null
      if (!mid || seen.has(mid)) continue
      seen.add(mid)
      let mediaPath = null
      if (m.hasMedia) {
        try { mediaPath = await saveMediaIfImageOrVideo(m, chat.id._serialized) } catch {}
      }
      const row = {
        id: mid,
        type: m.type,
        timestamp: m.timestamp,
        from: m.from,
        to: m.to,
        author: m.author || null,
        body: m.body || '',
        hasMedia: !!mediaPath,
        mediaPath
      }
      stream.write(JSON.stringify(row) + '\n')
    }
    before = msgs[msgs.length - 1].id._serialized
  }
  stream.end()
}

async function exportAll(client, deadline) {
  await fse.ensureDir(outRoot)
  await waitForChatSync(client)
  const chats = await client.getChats()
  console.log(`Chats cargados: ${chats.length}`)
  const directChats = chats.filter(c => {
    const id = c.id && c.id._serialized || ''
    return !c.isGroup && id !== '0@c.us' && !id.endsWith('@g.us') && !id.endsWith('@broadcast') && !id.endsWith('@newsletter')
  })
  await fse.writeJson(path.join(outRoot, 'index.json'), directChats.map(c => ({
    id: c.id._serialized,
    name: c.name || c.formattedTitle || '',
    isGroup: c.isGroup || false
  })), { spaces: 0 })
  console.log(`Exportando ${directChats.length} chats directos en paralelo`)
  await Promise.allSettled(directChats.map(chat => exportChat(chat, deadline)))
}

async function forceLoadAllChatsViaScroll(client) {
  try {
    await client.pupPage.waitForSelector('div[role="grid"]', { timeout: 60000 })
    await client.pupPage.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      let grid = document.querySelector('div[role="grid"]')
      if (!grid) grid = document.querySelector('div[data-testid="chat-list"]')
      if (!grid) return
      let prev = 0, stable = 0
      for (let i = 0; i < 120; i++) {
        grid.scrollTop = grid.scrollHeight
        grid.dispatchEvent(new WheelEvent('wheel', { deltaY: 800 }))
        await sleep(250)
        const rows = grid.querySelectorAll('[role="row"]').length
        if (rows === prev) stable++
        else stable = 0
        prev = rows
        if (stable >= 4) break
      }
    })
  } catch {}
}

async function waitForChatSync(client, maxMs = 300000) {
  const stop = startProgress(maxMs, 'Sincronización (5m)')
  await forceLoadAllChatsViaScroll(client)
  const start = Date.now()
  let prev = 0, stableCount = 0
  let lastLogTime = 0
  while (Date.now() - start < maxMs) {
    const { chatsCount } = await client.pupPage.evaluate(() => {
      try {
        const count = window.Store && window.Store.Chat && (window.Store.Chat._models?.length || window.Store.Chat.models?.length) || 0
        return { chatsCount: count }
      } catch (e) { return { chatsCount: 0 } }
    })
    if (chatsCount === prev) stableCount++
    else stableCount = 0
    prev = chatsCount
    if (chatsCount > 0 && (Date.now() - lastLogTime > 10000)) {
      console.log(`Sincronizando chats... ${chatsCount} cargados`)
      lastLogTime = Date.now()
    }
    if (stableCount >= 3) break
    await new Promise(r => setTimeout(r, 1000))
  }
  stop()
}

const client = new Client({
  puppeteer: {
    headless: false,
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
})

let ready = false

function shutdown() {
  Promise.resolve()
    .then(() => client.logout().catch(() => {}))
    .then(() => client.destroy().catch(() => {}))
    .finally(() => process.exit(0))
}

client.on('qr', qr => {
  console.log('QR disponible en Chromium')
})

client.on('ready', async () => {
  let extractTimer = null
  let stopExtractProgress = null
  try {
    ready = true
    try { client.pupPage && client.pupPage.once('close', () => { console.log('Finalización: ventana cerrada'); shutdown() }) } catch {}
    const extractMs = 300000
    stopExtractProgress = startProgress(extractMs, 'Extracción (5m)')
    const deadline = Date.now() + extractMs
    extractTimer = setTimeout(() => {
      console.log('Finalización: tiempo agotado de extracción (5m)')
      shutdown()
    }, extractMs)
    await exportAll(client, deadline)
  } finally {
    if (extractTimer) clearTimeout(extractTimer)
    if (stopExtractProgress) stopExtractProgress()
    console.log('Finalización: exportación completada')
    shutdown()
  }
})

client.on('disconnected', (reason) => {
  console.log(`Finalización: cliente desconectado (${reason || 'sin motivo'})`)
  shutdown()
})

client.on('auth_failure', (msg) => {
  console.log(`Finalización: fallo de autenticación (${msg || 'sin detalle'})`)
  shutdown()
})

client.initialize()