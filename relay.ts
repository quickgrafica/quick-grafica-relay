import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { serve } from '@hono/node-server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'

// Load .env — real env wins.
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// --- Env validation ---

const required = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'RELAY_SECRET',
  'ANTHROPIC_API_KEY',
] as const

for (const key of required) {
  if (!process.env[key]) {
    console.error(`missing required env var: ${key}`)
    process.exit(1)
  }
}

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!
const APP_SECRET = process.env.WHATSAPP_APP_SECRET!
const RELAY_SECRET = process.env.RELAY_SECRET!
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || RELAY_SECRET
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!
const PORT = Number(process.env.PORT ?? 3000)
const WA_API = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}`
const START = Date.now()

// --- AI assistant setup ---

const AI_MODEL = 'claude-haiku-4-5-20251001'
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

const AI_INSTRUCTIONS = readFileSync(new URL('./instrucoes.md', import.meta.url), 'utf8')
const AI_CATALOG = readFileSync(new URL('./catalogo.md', import.meta.url), 'utf8')

// --- Catalog parsing & search ---
//
// Sending the full ~275KB catalog as context on every single message is what
// was driving the API cost up — even with caching, sporadic WhatsApp traffic
// means the cache keeps expiring between customer messages, so most messages
// were re-paying to reprocess all 703 products. Instead we parse the catalog
// once at startup and give the AI a search tool: it only pays for the few
// products actually relevant to each question.

interface CatalogEntry {
  category: string
  subcategory: string
  heading: string
  body: string
}

function parseCatalog(text: string): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  let category = ''
  let subcategory = ''
  let current: CatalogEntry | null = null

  for (const line of text.split('\n')) {
    if (line.startsWith('#### Subcategoria:')) {
      subcategory = line.replace('#### Subcategoria:', '').trim()
      current = null
    } else if (line.startsWith('### ')) {
      current = { category, subcategory, heading: line.replace(/^###\s*/, '').trim(), body: '' }
      entries.push(current)
    } else if (line.startsWith('## ')) {
      category = line.replace(/^##\s*/, '').trim()
      current = null
    } else if (line.startsWith('#')) {
      current = null
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    }
  }

  return entries
}

const CATALOG_ENTRIES = parseCatalog(AI_CATALOG)

// Compact overview (categories + subcategories only) so the AI knows what
// exists without paying for the full product list.
const CATALOG_OVERVIEW = (() => {
  const byCategory = new Map<string, Set<string>>()
  for (const e of CATALOG_ENTRIES) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, new Set())
    if (e.subcategory) byCategory.get(e.category)!.add(e.subcategory)
  }
  const lines: string[] = []
  for (const [cat, subs] of byCategory) {
    lines.push(`- ${cat}: ${[...subs].join(', ')}`)
  }
  return lines.join('\n')
})()

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

const MAX_SEARCH_RESULTS = 8
const MAX_SEARCH_CHARS = 6000

function searchCatalog(query: string): string {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'Termo de busca vazio.'

  const scored = CATALOG_ENTRIES.map((e) => {
    // Weight matches in the product name / category much higher than a
    // stray mention buried in some other product's options list — otherwise
    // e.g. searching "botton" surfaces unrelated products that happen to
    // list "+2 bottons" as an accessory add-on, burying the actual Botton
    // products under ties.
    const heading = normalize(`${e.category} ${e.subcategory} ${e.heading}`)
    const body = normalize(e.body)
    let score = 0
    for (const w of words) {
      if (heading.includes(w)) score += 5
      // Count repeated body mentions too (relevant products tend to repeat
      // the term across variations/tiers), but cap so one huge options list
      // can't out-rank a real heading match.
      const bodyHits = body.split(w).length - 1
      score += Math.min(bodyHits, 3)
    }
    return { e, score }
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SEARCH_RESULTS)

  if (scored.length === 0) {
    return `Nenhum produto encontrado para "${query}". Tente outra palavra-chave (nome do produto, categoria ou material).`
  }

  let out = ''
  for (const { e } of scored) {
    const block = `### ${e.heading} [${e.category} / ${e.subcategory}]\n${e.body.trim()}\n\n`
    if (out.length + block.length > MAX_SEARCH_CHARS) break
    out += block
  }
  return out.trim()
}

const AI_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'buscar_catalogo',
    description:
      'Busca produtos no catálogo da Quick Gráfica por palavra-chave (nome do produto, categoria, material, acabamento). Retorna os produtos mais relevantes com preço, formato, material e opções. Use sempre que precisar do preço ou detalhes de um produto — você não tem o catálogo completo na memória.',
    input_schema: {
      type: 'object',
      properties: {
        termo: {
          type: 'string',
          description: 'Palavra-chave de busca, ex: "cartao de visita", "adesivo redondo", "banner lona"',
        },
      },
      required: ['termo'],
    },
  },
]

const AI_SYSTEM: Anthropic.Messages.TextBlockParam[] = [
  { type: 'text', text: AI_INSTRUCTIONS },
  {
    type: 'text',
    text: `Categorias e subcategorias disponíveis no catálogo:\n${CATALOG_OVERVIEW}`,
    cache_control: { type: 'ephemeral', ttl: '1h' },
  },
]

// --- Queue ---

interface InboundMessage {
  id: number
  timestamp: number
  wamid: string
  from: string
  pushName: string
  type: string
  text?: string
  mediaId?: string
  mimeType?: string
  filename?: string
  latitude?: number
  longitude?: number
  reactionEmoji?: string
  reactionTargetWamid?: string
}

let queue: InboundMessage[] = []
let nextId = 1
const MAX_QUEUE = 1000

function enqueue(msg: Omit<InboundMessage, 'id' | 'timestamp'>): void {
  queue.push({ ...msg, id: nextId++, timestamp: Date.now() })
  if (queue.length > MAX_QUEUE) {
    queue = queue.slice(queue.length - MAX_QUEUE)
  }
}

// --- Conversation log (persisted to disk, for the /dashboard viewer) ---

interface LogEntry {
  direction: 'in' | 'out'
  chatId: string
  pushName?: string
  text: string
  timestamp: number
  wamid?: string
}

const LOG_FILE = `${process.env.DATA_DIR ?? '.'}/conversas.json`
const MAX_LOG = 2000

let log: LogEntry[] = []
try {
  log = JSON.parse(readFileSync(LOG_FILE, 'utf8'))
} catch {}

function logMessage(entry: LogEntry): void {
  log.push(entry)
  if (log.length > MAX_LOG) {
    log = log.slice(log.length - MAX_LOG)
  }
  try {
    writeFileSync(LOG_FILE, JSON.stringify(log))
  } catch (err) {
    console.error('log: failed to persist conversas.json:', err)
  }
}

// --- Signature validation ---

function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!header) return false
  const sig = header.replace('sha256=', '')
  if (!sig) return false
  const expected = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')
  if (sig.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

// --- WhatsApp API helper ---

async function waApi(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${WA_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

// --- Outbound send helper (shared by /send and the AI auto-reply) ---

async function sendText(
  to: string,
  text: string,
  replyTo?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  }
  if (replyTo) body.context = { message_id: replyTo }

  const result = await waApi('/messages', body)
  if (result.ok) {
    const wamid = (result.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
    logMessage({ direction: 'out', chatId: to, text, timestamp: Date.now(), wamid })
  }
  return result
}

// --- AI auto-reply ---
//
// Runs in-process, right when a message arrives — no separate always-on
// worker needed, so it wakes together with the relay on Railway's free plan
// (an idle worker with nothing hitting its own HTTP port would never wake up).

const HISTORY_LIMIT = 20

// Serializes handling per chat so two messages arriving close together don't
// race each other's conversation history / replies. Returns the promise so
// the webhook handler can await it — on Railway's free plan the container
// can go back to sleep as soon as the HTTP response is sent, so any work
// left running in the background after that point may never finish.
const chatQueues = new Map<string, Promise<void>>()

function enqueueForChat(chatId: string, task: () => Promise<void>): Promise<void> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve()
  const next = prev.then(task).catch((err) => console.error('ai: task failed:', err))
  chatQueues.set(chatId, next)
  return next
}

// Avoids double-replying if Meta retries a webhook delivery (e.g. because our
// response took a while while the AI was thinking).
const processedForAI = new Set<string>()
const MAX_PROCESSED_FOR_AI = 5000

function buildHistory(chatId: string, beforeTs: number): Anthropic.Messages.MessageParam[] {
  const entries = log.filter((e) => e.chatId === chatId && e.timestamp < beforeTs).slice(-HISTORY_LIMIT)
  const collapsed: Anthropic.Messages.MessageParam[] = []
  for (const e of entries) {
    const role: 'user' | 'assistant' = e.direction === 'in' ? 'user' : 'assistant'
    const last = collapsed[collapsed.length - 1]
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n${e.text}`
    } else {
      collapsed.push({ role, content: e.text })
    }
  }
  while (collapsed.length && collapsed[0].role !== 'user') collapsed.shift()
  return collapsed
}

// Caps how many search-then-answer round trips a single reply can take —
// just a safety net against the model looping, not a normal-case limit.
const MAX_TOOL_ROUNDS = 4

async function handleWithAI(chatId: string, wamid: string, userText: string, ts: number): Promise<void> {
  try {
    const messages: Anthropic.Messages.MessageParam[] = [
      ...buildHistory(chatId, ts),
      { role: 'user', content: userText || '(mensagem vazia)' },
    ]

    let replyText = ''

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 2048,
        system: AI_SYSTEM,
        tools: AI_TOOLS,
        messages,
      })

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
        replyText = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
        break
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({
        role: 'user',
        content: toolUses.map((tu) => {
          const termo = typeof tu.input === 'object' && tu.input && 'termo' in tu.input ? String((tu.input as { termo: unknown }).termo) : ''
          return {
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: searchCatalog(termo),
          }
        }),
      })
    }

    if (!replyText) return

    const result = await sendText(chatId, replyText, wamid)
    if (!result.ok) console.error('ai: send failed:', result.data)
  } catch (err) {
    console.error('ai: handling failed:', err)
  }
}

// --- Webhook payload parsing ---

interface WaMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  video?: { id: string; mime_type: string; caption?: string }
  voice?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  reaction?: { message_id: string; emoji: string }
  location?: { latitude: number; longitude: number }
}

interface WaWebhookPayload {
  object: string
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id: string }
        contacts?: Array<{ profile: { name: string }; wa_id: string }>
        messages?: WaMessage[]
      }
    }>
  }>
}

function parseMessages(payload: WaWebhookPayload): Promise<void>[] {
  const pending: Promise<void>[] = []

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value?.messages) continue
      if (value.metadata?.phone_number_id !== PHONE_NUMBER_ID) continue

      const pushName = value.contacts?.[0]?.profile?.name ?? ''

      for (const msg of value.messages) {
        const base = { wamid: msg.id, from: msg.from, pushName, type: msg.type }
        let logText = `(${msg.type})`

        switch (msg.type) {
          case 'text':
            enqueue({ ...base, text: msg.text?.body })
            logText = msg.text?.body ?? logText
            break
          case 'image':
            enqueue({ ...base, text: msg.image?.caption, mediaId: msg.image?.id, mimeType: msg.image?.mime_type })
            logText = msg.image?.caption ? `[imagem] ${msg.image.caption}` : '[imagem]'
            break
          case 'document':
            enqueue({ ...base, text: msg.document?.caption, mediaId: msg.document?.id, mimeType: msg.document?.mime_type, filename: msg.document?.filename })
            logText = `[documento] ${msg.document?.filename ?? ''}`.trim()
            break
          case 'audio':
            enqueue({ ...base, mediaId: msg.audio?.id, mimeType: msg.audio?.mime_type })
            logText = '[áudio]'
            break
          case 'video':
            enqueue({ ...base, text: msg.video?.caption, mediaId: msg.video?.id, mimeType: msg.video?.mime_type })
            logText = msg.video?.caption ? `[vídeo] ${msg.video.caption}` : '[vídeo]'
            break
          case 'voice':
            enqueue({ ...base, mediaId: msg.voice?.id, mimeType: msg.voice?.mime_type })
            logText = '[mensagem de voz]'
            break
          case 'sticker':
            enqueue({ ...base, mediaId: msg.sticker?.id, mimeType: msg.sticker?.mime_type })
            logText = '[figurinha]'
            break
          case 'reaction':
            enqueue({ ...base, reactionEmoji: msg.reaction?.emoji, reactionTargetWamid: msg.reaction?.message_id })
            logText = `[reação] ${msg.reaction?.emoji ?? ''}`.trim()
            break
          case 'location':
            enqueue({ ...base, latitude: msg.location?.latitude, longitude: msg.location?.longitude })
            logText = '[localização]'
            break
          default:
            enqueue({ ...base, text: `(unsupported type: ${msg.type})` })
        }

        const ts = Date.now()
        logMessage({ direction: 'in', chatId: msg.from, pushName, text: logText, timestamp: ts, wamid: msg.id })

        // Skip auto-replying to plain reactions (a 👍 on an old message doesn't need a reply),
        // and skip messages we've already handled (Meta retried the webhook delivery).
        if (msg.type !== 'reaction' && !processedForAI.has(msg.id)) {
          processedForAI.add(msg.id)
          if (processedForAI.size > MAX_PROCESSED_FOR_AI) {
            const oldest = processedForAI.values().next().value
            if (oldest) processedForAI.delete(oldest)
          }
          pending.push(enqueueForChat(msg.from, () => handleWithAI(msg.from, msg.id, logText, ts)))
        }
      }
    }
  }

  return pending
}

// --- Hono app ---

const app = new Hono()

// Global error handler
app.onError((err, c) => {
  console.error('unhandled error:', err)
  return c.json({ error: 'internal' }, 500)
})

// --- Meta-facing routes (no relay auth) ---

// Webhook verification handshake
app.get('/webhook', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return c.text(challenge ?? '', 200)
  }
  return c.text('Forbidden', 403)
})

// Receive inbound messages
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text()

  if (!verifySignature(rawBody, c.req.header('x-hub-signature-256'))) {
    // Still return 200 — logging the rejection is enough.
    // Returning 4xx would cause Meta to retry with the same bad signature.
    console.error('webhook: invalid signature')
    return c.text('ok', 200)
  }

  try {
    const payload = JSON.parse(rawBody) as WaWebhookPayload
    // Await the AI replies before responding — on Railway's free plan the
    // container can sleep again right after this handler returns, which
    // would cut off any reply work still running in the background.
    await Promise.all(parseMessages(payload))
  } catch (err) {
    console.error('webhook: parse error:', err)
  }

  return c.text('ok', 200)
})

// Health check
app.get('/health', (c) => {
  return c.json({ ok: true, queue_size: queue.length, uptime: Math.floor((Date.now() - START) / 1000) })
})

// --- Auth middleware for local-facing routes ---

app.use('/poll', async (c, next) => {
  if (c.req.header('x-relay-secret') !== RELAY_SECRET) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.use('/send', async (c, next) => {
  if (c.req.header('x-relay-secret') !== RELAY_SECRET) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.use('/send-media', async (c, next) => {
  if (c.req.header('x-relay-secret') !== RELAY_SECRET) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.use('/react', async (c, next) => {
  if (c.req.header('x-relay-secret') !== RELAY_SECRET) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.use('/mark-read', async (c, next) => {
  if (c.req.header('x-relay-secret') !== RELAY_SECRET) return c.json({ error: 'unauthorized' }, 401)
  await next()
})

// --- Local MCP server-facing routes ---

// Poll for new messages
app.get('/poll', (c) => {
  const since = Number(c.req.query('since') ?? '0') || 0
  const messages = queue.filter((m) => m.id > since)
  const cursor = messages.length > 0 ? messages[messages.length - 1].id : since
  return c.json({ messages, cursor })
})

// Send text message
app.post('/send', async (c) => {
  const { to, text, reply_to } = await c.req.json<{ to: string; text: string; reply_to?: string }>()

  const result = await sendText(to, text, reply_to)
  if (!result.ok) return c.json({ error: result.data }, result.status as ContentfulStatusCode)

  const wamid = (result.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
  return c.json({ wamid })
})

// Send media message
app.post('/send-media', async (c) => {
  const { to, type, url, caption, filename, reply_to } = await c.req.json<{
    to: string
    type: 'image' | 'document' | 'audio' | 'video'
    url: string
    caption?: string
    filename?: string
    reply_to?: string
  }>()

  const mediaObj: Record<string, unknown> = { link: url }
  if (caption) mediaObj.caption = caption
  if (filename && type === 'document') mediaObj.filename = filename

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type,
    [type]: mediaObj,
  }
  if (reply_to) body.context = { message_id: reply_to }

  const result = await waApi('/messages', body)
  if (!result.ok) return c.json({ error: result.data }, result.status as ContentfulStatusCode)

  const wamid = (result.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
  logMessage({ direction: 'out', chatId: to, text: caption ? `[${type}] ${caption}` : `[${type}]`, timestamp: Date.now(), wamid })
  return c.json({ wamid })
})

// Send reaction
app.post('/react', async (c) => {
  const { to, wamid, emoji } = await c.req.json<{ to: string; wamid: string; emoji: string }>()

  const result = await waApi('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'reaction',
    reaction: { message_id: wamid, emoji },
  })
  if (!result.ok) return c.json({ error: result.data }, result.status as ContentfulStatusCode)

  const sentId = (result.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
  return c.json({ wamid: sentId })
})

// Send read receipt
app.post('/mark-read', async (c) => {
  const { wamid } = await c.req.json<{ wamid: string }>()

  const result = await waApi('/messages', {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: wamid,
  })
  if (!result.ok) return c.json({ error: result.data }, result.status as ContentfulStatusCode)
  return c.json({ ok: true })
})

// --- Conversation dashboard (read-only, token-protected) ---

// Returns the conversation log as JSON, newest last.
app.get('/log', (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ log })
})

// Simple mobile-friendly page that polls /log and renders it as chat bubbles per contact.
app.get('/dashboard', (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.text('Forbidden — adicione ?token=SEU_TOKEN na URL.', 401)
  const token = c.req.query('token')
  return c.html(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conversas — Quick Gráfica</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #eae6df; color: #111; }
  header { position: sticky; top: 0; background: #075e54; color: #fff; padding: 12px 16px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; z-index: 10; }
  header .status { font-weight: 400; font-size: 12px; opacity: 0.85; }
  #layout { display: flex; height: calc(100vh - 48px); }
  #contacts { width: 260px; min-width: 200px; background: #fff; overflow-y: auto; border-right: 1px solid #ddd; }
  .contact { padding: 12px 14px; border-bottom: 1px solid #eee; cursor: pointer; }
  .contact:hover, .contact.active { background: #f0f0f0; }
  .contact .name { font-weight: 600; font-size: 14px; }
  .contact .preview { font-size: 12px; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #chat { flex: 1; overflow-y: auto; padding: 16px; }
  .bubble { max-width: 70%; padding: 8px 12px; border-radius: 8px; margin-bottom: 8px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .bubble.in { background: #fff; margin-right: auto; }
  .bubble.out { background: #d9fdd3; margin-left: auto; }
  .bubble .meta { font-size: 10px; color: #888; margin-top: 4px; text-align: right; }
  #empty { padding: 40px; text-align: center; color: #888; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b141a; color: #eee; }
    #contacts { background: #111b21; border-color: #222; }
    .contact { border-color: #222; }
    .contact:hover, .contact.active { background: #1f2c33; }
    .contact .preview { color: #999; }
    .bubble.in { background: #1f2c33; }
    .bubble.out { background: #005c4b; }
  }
</style>
</head>
<body>
<header>
  <span>Conversas — Quick Gráfica</span>
  <span class="status" id="status">carregando…</span>
</header>
<div id="layout">
  <div id="contacts"></div>
  <div id="chat"><div id="empty">Selecione uma conversa</div></div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
let selected = null;
let lastLen = 0;

async function tick() {
  try {
    const res = await fetch('/log?token=' + encodeURIComponent(TOKEN));
    if (!res.ok) { document.getElementById('status').textContent = 'erro de autenticação'; return; }
    const { log } = await res.json();
    document.getElementById('status').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR');
    render(log);
  } catch (e) {
    document.getElementById('status').textContent = 'sem conexão';
  }
}

function render(log) {
  const byContact = {};
  for (const m of log) {
    if (!byContact[m.chatId]) byContact[m.chatId] = [];
    byContact[m.chatId].push(m);
  }
  const contacts = Object.keys(byContact).sort((a, b) => {
    const la = byContact[a][byContact[a].length - 1].timestamp;
    const lb = byContact[b][byContact[b].length - 1].timestamp;
    return lb - la;
  });

  if (!selected && contacts.length) selected = contacts[0];

  const contactsEl = document.getElementById('contacts');
  contactsEl.innerHTML = '';
  for (const id of contacts) {
    const msgs = byContact[id];
    const last = msgs[msgs.length - 1];
    const name = msgs.find(m => m.pushName)?.pushName || id;
    const div = document.createElement('div');
    div.className = 'contact' + (id === selected ? ' active' : '');
    div.innerHTML = '<div class="name">' + escapeHtml(name) + '</div><div class="preview">' + escapeHtml(last.text || '') + '</div>';
    div.onclick = () => { selected = id; lastLen = 0; render(log); };
    contactsEl.appendChild(div);
  }

  const chatEl = document.getElementById('chat');
  if (!selected) { chatEl.innerHTML = '<div id="empty">Nenhuma conversa ainda</div>'; return; }
  const msgs = byContact[selected] || [];
  if (msgs.length === lastLen) return; // avoid re-render/flicker when nothing changed for this contact
  lastLen = msgs.length;
  chatEl.innerHTML = '';
  for (const m of msgs) {
    const div = document.createElement('div');
    div.className = 'bubble ' + m.direction;
    const time = new Date(m.timestamp).toLocaleString('pt-BR');
    div.innerHTML = escapeHtml(m.text || '') + '<div class="meta">' + time + '</div>';
    chatEl.appendChild(div);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

tick();
setInterval(tick, 4000);
</script>
</body>
</html>`)
})

// --- Start ---

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`whatsapp relay listening on :${info.port}`)
})
