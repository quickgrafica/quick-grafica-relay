import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { serve } from '@hono/node-server'
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
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
  if (!process.env[key]?.trim()) {
    console.error(`missing required env var: ${key}`)
    process.exit(1)
  }
}

// Trimmed on the way in. A value pasted into Railway with a trailing space or
// newline is invisible in the UI but breaks an exact comparison — and the one
// that matters, WHATSAPP_PHONE_NUMBER_ID, makes the bot ignore every incoming
// message while /health still reports ok.
const env = (key: string): string => (process.env[key] ?? '').trim()

const ACCESS_TOKEN = env('WHATSAPP_ACCESS_TOKEN')
const PHONE_NUMBER_ID = env('WHATSAPP_PHONE_NUMBER_ID')
const VERIFY_TOKEN = env('WHATSAPP_VERIFY_TOKEN')
const APP_SECRET = env('WHATSAPP_APP_SECRET')
const RELAY_SECRET = env('RELAY_SECRET')
const DASHBOARD_TOKEN = env('DASHBOARD_TOKEN') || RELAY_SECRET
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY')
// Number("") is 0 and Number("abc") is NaN; either binds a random port and
// Railway's health check then fails with nothing in the logs to explain it.
const parsedPort = Number(env('PORT'))
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3000
if (process.env.PORT && PORT !== parsedPort) {
  console.error(`PORT inválido ("${process.env.PORT}"), usando 3000`)
}
const WA_API = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}`
const START = Date.now()

// --- Meta Conversions API (CAPI) ---
// Optional: when configured, server-side events (LeadSubmitted, Purchase) are
// sent to Meta so ad campaigns can optimise for real WhatsApp conversions.
const META_CAPI_TOKEN = env('META_CAPI_TOKEN')
const META_DATASET_ID = env('META_DATASET_ID')
const CAPI_ENABLED = !!(META_CAPI_TOKEN && META_DATASET_ID)
if (CAPI_ENABLED) console.log('capi: Meta Conversions API habilitada')
else console.log('capi: Meta Conversions API desabilitada (META_CAPI_TOKEN ou META_DATASET_ID não configurados)')

// SHA256 hash normalised and lowercased, as the Conversions API requires.
function sha256(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

// Fires an event to the Meta Conversions API. Never throws — a failed CAPI call
// must never break the customer's conversation.
async function sendCapiEvent(
  eventName: string,
  opts: {
    phone?: string       // E.164 phone number (e.g. "5531999999999")
    ctwaClid?: string    // Click-to-WhatsApp click ID for ad attribution
    value?: number       // Purchase value in BRL (only for Purchase events)
    contentName?: string // Product name (only for Purchase events)
  },
): Promise<void> {
  if (!CAPI_ENABLED) return
  try {
    const userData: Record<string, unknown> = {}
    if (opts.phone) {
      // Hash the phone for user matching. The Conversions API expects the phone
      // WITHOUT the leading + and hashed with SHA256.
      userData.ph = [sha256(opts.phone)]
    }
    // The ctwa_clid is sent UN-hashed — Meta uses it to match the ad click.
    if (opts.ctwaClid) userData.ctwa_clid = opts.ctwaClid

    const eventData: Record<string, unknown> = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
    }
    if (opts.value != null && Number.isFinite(opts.value)) {
      eventData.custom_data = {
        currency: 'BRL',
        value: opts.value.toFixed(2),
        ...(opts.contentName ? { content_name: opts.contentName } : {}),
      }
    }

    const url = `https://graph.facebook.com/v21.0/${META_DATASET_ID}/events?access_token=${META_CAPI_TOKEN}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [eventData] }),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`capi: ${eventName} falhou (${res.status}):`, text.slice(0, 300))
    } else {
      console.log(`capi: ${eventName} enviado com sucesso para ${opts.phone ?? '?'}`)
    }
  } catch (err) {
    console.error(`capi: ${eventName} erro:`, err)
  }
}

// --- AI assistant setup ---

const AI_MODEL = 'claude-sonnet-5'
// The webhook handler awaits the whole reply before responding (see the comment
// there), so the SDK's 10-minute default would hold Meta's webhook open far
// past its own timeout and block the chat queue behind it. Two minutes is well
// beyond a normal reply and still fails fast enough to apologise properly.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 })

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

// The API prices products in two different shapes, and they mean different
// things — reading one as the other is the difference between R$ 10,90 and
// R$ 109,00 on a five-unit order:
//
//   { qtde: 500, preco_atual: 89.90 }        -> 500 units cost R$ 89,90 IN TOTAL
//   { de: 1, ate: 5, preco_unit: 10.90 }     -> from 1 to 5 units, R$ 10,90 EACH
//
// Only the first was understood. Every product priced the second way came
// through with no price at all — and, if it also had no options, was dropped
// from the catalog entirely by the "usable" filter.
interface ApiPrice {
  qtde?: number
  preco_atual?: number
  de?: number
  ate?: number
  preco_unit?: number
}

interface PriceTier {
  min: number
  max: number
  price: number
  // true  -> `price` is charged per unit across the min..max range
  // false -> `price` is the total for exactly `min` units
  perUnit: boolean
}

interface ApiVariation {
  opcao: string
  nome: string
  valor: number
  // How `valor` is charged. Observed: 0 = per unit (R$ 0,06 each for rounded
  // corners), 2 = one flat charge on the order (R$ 180,00 for a custom cutting
  // die). Reading 180 as per-unit would turn a R$ 99,70 order of 1000 cards
  // into R$ 180.000, so an unrecognised code is never assumed to be per unit.
  cobranca?: number
}

// Accepts the number the API normally sends, but also "0,06" / "1.234,50" if it
// ever sends the value pre-formatted — Number("0,06") is NaN, which used to
// reach the model as a surcharge of "R$ NaN,undefined".
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return NaN
  const clean = v
    .trim()
    .replace(/[R$\s]/g, '')
    .replace(/\.(?=\d{3}\b)/g, '')
    .replace(',', '.')
  return clean ? Number(clean) : NaN
}

function surchargeLabel(v: ApiVariation): string {
  const valor = toNumber(v.valor)
  if (!Number.isFinite(valor) || valor === 0) return ''
  const money = brl(valor)
  if (v.cobranca === 0 || v.cobranca === undefined) return ` (+${money}/un)`
  if (v.cobranca === 2) return ` (+${money} FIXO)`
  return ` (+${money} A CONFIRMAR)`
}

// The fields of the live product API that matter here. It returns ~75 per
// product (tax codes, SEO, stock, shipping dimensions); these are the ones an
// assistant quoting a price actually needs.
interface ApiProduct {
  id: number
  // The parent product this variant belongs to. Variants of one product (the
  // same sticker in ten sizes) share it, and it is usually where a price table
  // is edited in the shop's admin — so /precos-suspeitos reports both.
  pai?: number
  titulo: string
  material?: string
  revestimento?: string
  acabamento?: string
  extras?: string
  formato?: string
  prazo?: string
  cores?: string
  categoria?: string
  subcategoria?: string
  secao?: string
  descricao_curta?: string
  preco?: ApiPrice[]
  variacoes?: ApiVariation[]
}

interface CatalogEntry {
  category: string
  subcategory: string
  heading: string
  body: string
  // Present when this entry came from the live API. Then the spec fields and
  // the option groups are stated by the source, so nothing has to be inferred
  // by comparing sibling entries.
  api?: ApiProduct
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
      // Reset: a category with no subcategory headers of its own (cartões de
      // visita, impressão foto) was inheriting the last one seen, which filed
      // every business card under "wind-banner" and broke the grouping of a
      // product with its own variations.
      subcategory = ''
      current = null
    } else if (line.startsWith('#')) {
      current = null
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    }
  }

  return entries
}

// The static snapshot. Kept as the fallback: if the live API is unreachable at
// boot, the assistant still answers from this instead of going blind.
const STATIC_ENTRIES = parseCatalog(AI_CATALOG)

// Mutable because the live catalog replaces it once the API responds, and again
// on each refresh. Everything downstream (search, siblings, facts) reads this.
let CATALOG_ENTRIES = STATIC_ENTRIES

// Compact overview (categories + subcategories only) so the AI knows what
// exists without paying for the full product list.
function buildOverview(entries: CatalogEntry[]): string {
  const byCategory = new Map<string, Set<string>>()
  for (const e of entries) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, new Set())
    if (e.subcategory) byCategory.get(e.category)!.add(e.subcategory)
  }
  const lines: string[] = []
  for (const [cat, subs] of byCategory) {
    lines.push(`- ${cat}: ${[...subs].join(', ')}`)
  }
  return lines.join('\n')
}

let CATALOG_OVERVIEW = buildOverview(CATALOG_ENTRIES)

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Hyphens split words for search purposes ("roll-up" vs the catalog's
    // "Roll Up") without this \u2014 a real gap found in testing: instrucoes.md
    // tells the assistant to search exactly the term "roll-up", which matched
    // nothing because the catalog spells it with a space. Folding hyphens into
    // spaces makes both spellings equivalent everywhere normalize() is used.
    .replace(/-/g, ' ')
}

// --- What is a real choice, and what already comes fixed ---
//
// The recurring bug in production was always the same shape: the assistant
// offering as a choice something that is simply how the product is made. It
// asked "4x0 ou 4x4?" for a Backdrop that only exists in 4x0; "frente ou frente
// e verso?" for a sticker printed on one side; "quer bast\u00e3o e cordinha?" for a
// Banner that always ships with it. Prompt rules only reduced how often it
// guessed wrong, because the raw catalog text gives it nothing to tell the two
// apart. So the search result now states it outright, per product: these fields
// are FIXED, and these are the only real choices \u2014 the ones on the "Op\u00e7\u00f5es:"
// line, plus whatever genuinely differs between sibling entries of the same
// product (Banner's eight sizes, for instance).

const SPEC_KEYS = ['Formato', 'Material', 'Acabamento', 'Cores/Impress\u00e3o', 'Prazo']

interface EntryFacts {
  specs: Map<string, string>
  options: string
  priceLines: string[]
  simplePrice: string
}

function parseFacts(e: CatalogEntry): EntryFacts {
  const specs = new Map<string, string>()
  const priceLines: string[] = []
  let options = ''
  let simplePrice = ''

  for (const rawLine of e.body.split('\n')) {
    const line = rawLine.replace(/^\s*-\s*/, '').trim()
    if (!line) continue
    if (line.startsWith('Op\u00e7\u00f5es:')) {
      options = line.replace('Op\u00e7\u00f5es:', '').trim()
    } else if (/^(Pre\u00e7o|Desconto|Limites)/i.test(line)) {
      priceLines.push(line)
      const m = line.match(/^Pre\u00e7o:\s*(R\$\s*[\d.,]+)/i)
      if (m) simplePrice = m[1]
    } else if (line.includes(':')) {
      for (const part of line.split('|')) {
        const idx = part.indexOf(':')
        if (idx === -1) continue
        const key = part.slice(0, idx).trim()
        const value = part.slice(idx + 1).trim()
        if (SPEC_KEYS.includes(key) && value) specs.set(key, value)
      }
    }
  }
  return { specs, options, priceLines, simplePrice }
}

let FACTS = new Map<CatalogEntry, EntryFacts>()

// Sibling entries = the same product under different codes/sizes. A spec that
// changes across them is a genuine choice the customer gets to make; one that
// holds steady across all of them is just how the product is.
const productBaseName = (h: string) =>
  h
    .replace(/\s*\([0-9A-Za-z]+\)\s*$/, '')
    .replace(/\s*[-\u2013]?\s*\d+([.,]\d+)?\s*x\s*\d+([.,]\d+)?\s*(mm|cm|m)?\s*$/i, '')
    .replace(/\s*[-\u2013]?\s*\d+([.,]\d+)?\s*(mm|cm|m)\s*$/i, '')
    .trim()

let SIBLINGS = new Map<string, CatalogEntry[]>()

function siblingsOf(e: CatalogEntry): CatalogEntry[] {
  return SIBLINGS.get(`${e.category}/${e.subcategory}/${normalize(productBaseName(e.heading))}`) ?? [e]
}

// Rebuilds the derived indexes whenever the catalog is replaced.
//
// Everything is built into locals first and only then published, all four at
// once. The previous version assigned CATALOG_ENTRIES before building the
// indexes, so a throw partway through (a product whose `titulo` is not a
// string, say) left the new products live against an empty SIBLINGS map and a
// stale overview — and every later search threw until the next refresh, six
// hours away. Now a throw leaves the previous catalog completely untouched.
function indexCatalog(entries: CatalogEntry[]): void {
  const facts = new Map<CatalogEntry, EntryFacts>()
  for (const e of entries) facts.set(e, parseFacts(e))

  const siblings = new Map<string, CatalogEntry[]>()
  for (const e of entries) {
    const key = `${e.category}/${e.subcategory}/${normalize(productBaseName(e.heading))}`
    if (!siblings.has(key)) siblings.set(key, [])
    siblings.get(key)!.push(e)
  }

  const overview = buildOverview(entries)

  CATALOG_ENTRIES = entries
  FACTS = facts
  SIBLINGS = siblings
  CATALOG_OVERVIEW = overview
}

indexCatalog(STATIC_ENTRIES)

// Only collapses values that are literally the same thing typed differently
// ("8 x8 cm" vs "8 x 8 cm"). Deliberately NOT fuzzy: an earlier version scored
// word overlap and merged 4x0, 4x1 and 4x4 into one value, because all three
// phrasings share "colorido frente verso" — erasing a real choice. The
// different-wording case (Banner's two ways of saying bastão e cordinha) is
// handled below by checking whether the field is decided by another one.
function sameValue(a: string, b: string): boolean {
  const clean = (s: string) =>
    normalize(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/ /g, '')
  return clean(a) === clean(b)
}

// Which spec keys actually vary between siblings, and the values on offer.
function realVariations(e: CatalogEntry): Array<{ key: string; values: string[] }> {
  const group = siblingsOf(e)
  if (group.length < 2) return []
  const out: Array<{ key: string; values: string[] }> = []
  for (const key of SPEC_KEYS) {
    if (key === 'Prazo') continue // production time isn't something the customer picks
    const distinct: Array<{ value: string; price: string }> = []
    for (const sib of group) {
      const v = FACTS.get(sib)?.specs.get(key)
      if (!v) continue
      if (distinct.some((d) => sameValue(d.value, v))) continue
      distinct.push({ value: v, price: FACTS.get(sib)?.simplePrice ?? '' })
    }
    if (distinct.length > 1) {
      out.push({ key, values: distinct.map((d) => (d.price ? `${d.value} (${d.price})` : d.value)) })
    }
  }

  // Drop keys the customer doesn't actually get to pick. Every Banner size
  // carries its own wording of the same finish, so "Acabamento" looks like it
  // varies — but pick the size and the finish is already decided. When one key
  // is fully determined by another, it is a description of that version, not a
  // separate question to ask.
  const determined = (key: string, by: string): boolean => {
    const map = new Map<string, string>()
    for (const sib of group) {
      const k = FACTS.get(sib)?.specs.get(key)
      const b = FACTS.get(sib)?.specs.get(by)
      if (!k || !b) continue
      const prev = map.get(b)
      if (prev && !sameValue(prev, k)) return false
      if (!prev) map.set(b, k)
    }
    return map.size > 1
  }
  return out.filter((v) => !out.some((other) => other.key !== v.key && determined(v.key, other.key)))
}

// The snapshot holds entries with an identical spec sheet but different price
// tables — "Cartão de visita Promocional 9x5cm Couchê 300g 4x1" exists at both
// R$ 104,90 and R$ 114,90 for 1000un. The export dropped whatever column told
// them apart (the site also asks for revestimento and acabamento), so from here
// they are indistinguishable and picking one would be a coin flip on the
// customer's money. Say so instead.
function conflictingPrices(e: CatalogEntry): string[] {
  const f = FACTS.get(e)
  if (!f) return []
  const sig = (x: CatalogEntry) =>
    SPEC_KEYS.map((k) => normalize(FACTS.get(x)?.specs.get(k) ?? '')).join('|')
  const mine = sig(e)
  const others = siblingsOf(e).filter((s) => s !== e && sig(s) === mine)
  const priceOf = (x: CatalogEntry) => (FACTS.get(x)?.priceLines ?? []).join(' ')
  const distinct = new Set<string>()
  for (const o of others) {
    const p = priceOf(o)
    if (p && p !== priceOf(e)) distinct.add(p)
  }
  return [...distinct]
}

// --- Live catalog from the Quick Gráfica API ---
//
// The static snapshot was the root of the worst bugs: prices months out of date
// (1000 business cards quoted at R$ 104,90–149,90 when the real price is
// R$ 99,70), six indistinguishable copies of the same product with conflicting
// price tables, and no revestimento/acabamento columns at all — the very fields
// that told those copies apart. The API has all of it, first-hand: spec fields
// separate, quantity tiers as data, and option groups stated explicitly instead
// of inferred. 730 products over 8 pages of 100.

const API_PAGE_LIMIT = 20 // generous stop; the API reports 8
const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000

// `preco` and `variacoes` are arrays for most products but not all — some come
// back as an object keyed by id, and some as an empty string. Blindly calling
// .filter on those crashed the whole import, so every read goes through here.
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[]
  if (v && typeof v === 'object') return Object.values(v as Record<string, T>)
  return []
}

// Records the odd shapes seen during an import, so the next look at
// /catalogo-status says what they actually were instead of guessing again.
let shapeNotes: string[] = []

function noteShape(field: string, value: unknown): void {
  if (Array.isArray(value) || value == null || value === '') return
  const desc = `${field}: ${typeof value}${typeof value === 'object' ? ` com chaves ${Object.keys(value as object).slice(0, 5).join(',')}` : ` = ${String(value).slice(0, 40)}`}`
  if (shapeNotes.length < 10 && !shapeNotes.includes(desc)) shapeNotes.push(desc)
}

// The quantity tiers, cleaned and ordered, whatever container they arrived in.
// When the API migrated a product to m²-based pricing the `preco` object gains
// a `regras` key with the live rule, but the old fixed tiers stay behind under
// numbered keys.  Those stale tiers are wrong — the site no longer sells at
// those values — so we skip them entirely when `regras` is present.
function priceTiers(p: ApiProduct): PriceTier[] {
  const raw = p.preco as unknown
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).regras) {
    return [] // m²-based pricing — old tiers are stale
  }
  const out: PriceTier[] = []
  for (const t of asArray<ApiPrice>(p.preco)) {
    if (!t || typeof t !== 'object') continue

    // Range shape: de / ate / preco_unit — a per-unit price across a band.
    const de = toNumber(t.de)
    const unit = toNumber(t.preco_unit)
    if (Number.isFinite(de) && Number.isFinite(unit)) {
      const ate = toNumber(t.ate)
      out.push({
        min: de,
        max: Number.isFinite(ate) && ate >= de ? ate : Number.MAX_SAFE_INTEGER,
        price: unit,
        perUnit: true,
      })
      continue
    }

    // Quantity shape: qtde / preco_atual — a total for exactly that quantity.
    const qtde = toNumber(t.qtde)
    const total = toNumber(t.preco_atual)
    if (Number.isFinite(qtde) && Number.isFinite(total)) {
      out.push({ min: qtde, max: qtde, price: total, perUnit: false })
    }
  }
  return out.sort((a, b) => a.min - b.min)
}

// Looks for tier tables that cannot be right, and says which entry is wrong.
//
// Two real cases found in the live data: a panfleto whose 5000-unit price is
// R$ 119.090,00, sitting between R$ 829,90 at 2500 and R$ 2.290,00 at 10000
// (a misplaced separator — it should be about R$ 1.190,90); and a sticker whose
// 2450-unit price is R$ 1,39 between R$ 79,90 and R$ 258,00. Quoted as-is, the
// first overcharges by fifty times and the second sells at a loss. A third case
// is overlapping bands — "30-75un: R$ 3,50/un" next to "30-50un: R$ 6,00/un" —
// where two different prices both claim the same quantity.
//
// None of this can be fixed here; the fix is in the shop's own registration.
// What this does is stop the assistant repeating a wrong number confidently.
// Reads the snapshot's price text back into tiers, so the same anomaly check
// runs on both catalog sources. Handles both of its formats:
//   "1-5un: R$ 10,90/un"  (per-unit band)   and   "500un: R$ 89,90"  (total)
function tiersFromText(text: string): PriceTier[] {
  const out: PriceTier[] = []
  for (const m of text.matchAll(/(\d+)\s*-\s*(\d+)un:\s*R\$\s*([\d.,]+)\s*\/un/g)) {
    out.push({ min: Number(m[1]), max: Number(m[2]), price: parseBRL(m[3]), perUnit: true })
  }
  for (const m of text.matchAll(/(?<![\d-])(\d+)un:\s*R\$\s*([\d.,]+)(?!\s*\/un)/g)) {
    out.push({ min: Number(m[1]), max: Number(m[1]), price: parseBRL(m[2]), perUnit: false })
  }
  return out.sort((a, b) => a.min - b.min)
}

function tierWarning(tiers: PriceTier[]): string {
  if (tiers.length < 2) return ''
  const problems: string[] = []

  for (let i = 0; i < tiers.length; i++) {
    for (let j = i + 1; j < tiers.length; j++) {
      const a = tiers[i]
      const b = tiers[j]
      if (a.perUnit && b.perUnit && a.min <= b.max && b.min <= a.max && a.price !== b.price) {
        problems.push(
          `as faixas ${a.min}-${a.max}un (${brl(a.price)}/un) e ${b.min}-${b.max}un (${brl(b.price)}/un) se sobrepõem — para uma quantidade nessa sobreposição há dois preços diferentes`,
        )
      }
    }
  }

  // Hard invariant on quantity rows: ordering MORE can never cost LESS in
  // total. This is a separate check from the per-unit one below, and it catches
  // a different half of the problem — the per-unit rule only fires when a price
  // is too HIGH, so a tier typed absurdly LOW slipped through it entirely
  // (2450 stickers for R$ 1,39 between R$ 79,90 and R$ 258,00). Seventeen
  // products in the catalog fail this one.
  const totals = tiers.filter((t) => !t.perUnit)
  for (let i = 1; i < totals.length; i++) {
    if (totals[i].price < totals[i - 1].price) {
      problems.push(
        `${totals[i].min}un (${brl(totals[i].price)}) custa MENOS que ${totals[i - 1].min}un (${brl(totals[i - 1].price)}) — pedir mais sairia mais barato no total, o que é impossível e indica erro de cadastro numa dessas duas faixas`,
      )
    }
  }

  // Per-unit cost should fall as quantity rises. A jump means a typo — but it
  // does not say WHICH of the two entries is the wrong one: a 5000-unit price
  // typed too high and a 2500-unit price typed too low look identical from
  // here. So both are named, and both are held back.
  const unitCost = (t: PriceTier) => (t.perUnit ? t.price : t.price / Math.max(t.min, 1))
  // Sub-centavo unit prices are normal on large runs, and brl() would render
  // them all as "R$ 0,00" — which reads as free and hides the anomaly.
  const perUnit = (v: number) => (v >= 0.01 ? brl(v) : `R$ ${v.toFixed(4).replace('.', ',')}`)
  for (let i = 1; i < tiers.length; i++) {
    const prev = unitCost(tiers[i - 1])
    const cur = unitCost(tiers[i])
    if (prev > 0 && cur > prev * 1.6) {
      problems.push(
        `comparando as faixas de ${tiers[i - 1].min}un (${brl(tiers[i - 1].price)}, ou ${perUnit(prev)} por unidade) e ${tiers[i].min}un (${brl(tiers[i].price)}, ou ${perUnit(cur)} por unidade), o preço por unidade SOBE quando a quantidade aumenta — uma dessas duas está cadastrada errada, e não dá pra saber qual`,
      )
    }
  }

  if (problems.length === 0) return ''
  return (
    `⚠️ PREÇO SUSPEITO: ${problems.slice(0, 2).join('; ')}. ` +
    'NÃO dê valor fechado nas faixas citadas aqui — nem a mais cara nem a mais barata. As demais faixas dessa tabela continuam válidas e podem ser usadas normalmente. Se o cliente quiser justamente uma das quantidades problemáticas, monte o pedido e diga que a equipe confirma o valor exato antes de fechar.'
  )
}

// One tier as the assistant reads it. Deliberately identical to how the static
// snapshot writes them, because instrucoes.md documents that vocabulary: a
// bare "500un: R$ 89,90" is a total, and a "/un" suffix means multiply.
function tierLabel(t: PriceTier): string {
  if (!t.perUnit) return `${t.min}un: ${brl(t.price)}`
  const ate = t.max === Number.MAX_SAFE_INTEGER ? '+' : `-${t.max}`
  return `${t.min}${ate}un: ${brl(t.price)}/un`
}

// Some products price by rule rather than by tier — the per-m² lines with a
// minimum charge and volume discounts arrive as a `regras` key sitting next to
// the tiers. Whatever it holds changes the price, so it is never dropped in
// silence: it is surfaced verbatim and the final value goes to the team.
function priceRules(p: ApiProduct): string {
  const raw = p.preco as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ''
  const regras = (raw as Record<string, unknown>).regras
  if (!regras) return ''
  const txt = typeof regras === 'string' ? regras : JSON.stringify(regras)
  return txt && txt !== '{}' && txt !== '[]' && txt !== 'null' ? txt.slice(0, 300) : ''
}

// Turns one API product into the entry shape search and rendering expect. The
// body carries the searchable text; `api` carries the structured truth.
function entryFromApi(p: ApiProduct): CatalogEntry {
  const specs = [
    p.formato && `Formato: ${p.formato}`,
    p.material && `Material: ${p.material}`,
    p.revestimento && `Revestimento: ${p.revestimento}`,
    p.acabamento && `Acabamento: ${p.acabamento}`,
    p.cores && `Cores/Impressão: ${p.cores}`,
    p.prazo && `Prazo: ${p.prazo}`,
  ]
    .filter(Boolean)
    .join(' | ')

  noteShape('preco', p.preco)
  noteShape('variacoes', p.variacoes)

  const precos = priceTiers(p).map(tierLabel).join('; ')
  const regras = priceRules(p)

  const vars = asArray<ApiVariation>(p.variacoes)
    .filter((v) => v?.nome)
    .map((v) => `[${v.opcao}] ${v.nome}${surchargeLabel(v)}`)
    .join('; ')

  const body = [
    specs && `- ${specs}`,
    precos && `- Preço por quantidade: ${precos}`,
    !precos && regras && `- Preço por m²: ${regras}`,
    vars && `- Opções: ${vars}`,
    p.descricao_curta && `- ${String(p.descricao_curta).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    category: p.categoria ?? 'sem-categoria',
    // The API splits the tree three ways; `secao` is the product-level one
    // ("cartoes-de-visita"), which is what customers and search actually use.
    subcategory: p.secao || p.subcategoria || '',
    heading: p.titulo,
    body,
    api: p,
  }
}

const API_TIMEOUT_MS = 30_000

async function fetchApiPage(
  pagina: number,
): Promise<{ produtos: ApiProduct[]; totalPaginas: number; totalConhecido: boolean }> {
  const base = process.env.QUICK_API_URL!
  const url = `${base}${base.includes('?') ? '&' : '?'}pagina=${pagina}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.QUICK_API_TOKEN}` },
    // Without this, a stalled connection hangs the whole refresh for minutes.
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} na página ${pagina}`)
  const data = (await res.json()) as {
    registros?: unknown
    paginacao?: { total_paginas?: unknown }
  }
  // A 200 whose shape drifted is the dangerous case. This used to fall back to
  // an empty array, which read as "this page has no products" and quietly
  // shrank the catalog while the load still reported success.
  if (!Array.isArray(data.registros)) {
    throw new Error(`página ${pagina} veio sem a lista "registros" (recebido: ${typeof data.registros})`)
  }
  const total = Number(data.paginacao?.total_paginas)
  const totalConhecido = Number.isFinite(total) && total >= 1
  return {
    produtos: data.registros as ApiProduct[],
    totalPaginas: totalConhecido ? Math.floor(total) : 1,
    totalConhecido,
  }
}

let catalogSource = 'estático (catalogo.md)'
let catalogLoadedAt = 0
let catalogLastError = ''
// Size of the last successful load, used to reject a suspiciously small one.
let lastGoodCount = 0
// How many times in a row a load was rejected for shrinking too much.
let shrinkRejections = 0
const SHRINK_GRACE = 3
// In-flight refresh, so two callers never load concurrently.
let refreshInFlight: Promise<{ ok: boolean; produtos: number; erro?: string }> | null = null

async function loadCatalogFromApi(forcar = false): Promise<{ ok: boolean; produtos: number; erro?: string }> {
  try {
    shapeNotes = []
    const first = await fetchApiPage(1)
    // Without a page count there is no way to know whether page 1 is the whole
    // catalog or the first 100 of 730. Loading it anyway used to look like a
    // clean success while 86% of the products silently vanished.
    if (!first.totalConhecido) {
      throw new Error('a API não informou total_paginas — recusando carregar um catálogo possivelmente parcial')
    }

    const all = [...first.produtos]
    const pages = Math.min(first.totalPaginas, API_PAGE_LIMIT)
    for (let p = 2; p <= pages; p++) {
      const next = await fetchApiPage(p)
      all.push(...next.produtos)
    }

    const usable = all.filter(
      (p) =>
        p &&
        typeof p.titulo === 'string' &&
        p.titulo.trim() &&
        (priceTiers(p).length > 0 || asArray<ApiVariation>(p.variacoes).length > 0),
    )
    if (usable.length === 0) throw new Error('a API respondeu, mas sem produtos utilizáveis')

    // A load that comes back drastically smaller than the last good one is
    // almost certainly a truncated response, not hundreds of products being
    // deleted overnight. Serving it would make the bot tell customers that real
    // products don't exist, so the previous catalog is kept instead.
    // Rejected at most SHRINK_GRACE times in a row. Without that ceiling this is
    // a one-way ratchet: if the shop genuinely retires a third of its catalog,
    // every refresh from then on fails the same check, prices freeze at the old
    // snapshot, and nothing short of a redeploy recovers it.
    if (!forcar && lastGoodCount > 0 && usable.length < lastGoodCount * 0.7) {
      shrinkRejections++
      if (shrinkRejections <= SHRINK_GRACE) {
        throw new Error(
          `a API devolveu ${usable.length} produtos, muito abaixo dos ${lastGoodCount} da última carga boa ` +
            `(rejeição ${shrinkRejections}/${SHRINK_GRACE}) — mantendo o catálogo anterior`,
        )
      }
      console.error(
        `catálogo: ${usable.length} produtos rejeitados ${SHRINK_GRACE}x seguidas; aceitando como o novo tamanho real`,
      )
    }
    shrinkRejections = 0

    indexCatalog(usable.map(entryFromApi))
    lastGoodCount = usable.length
    catalogSource = `API ao vivo (${usable.length} produtos, ${pages} páginas)`
    catalogLoadedAt = Date.now()
    catalogLastError = ''
    console.log(`catálogo: carregado da API — ${usable.length} produtos de ${all.length} registros`)
    return { ok: true, produtos: usable.length }
  } catch (err) {
    // Keep whatever catalog is already loaded rather than leaving the assistant
    // with nothing to answer from.
    catalogLastError = String(err)
    console.error('catálogo: falha ao carregar da API, mantendo o anterior:', err)
    return { ok: false, produtos: 0, erro: String(err) }
  }
}

async function refreshCatalogFromApi(forcar = false): Promise<{ ok: boolean; produtos: number; erro?: string }> {
  if (!process.env.QUICK_API_URL || !process.env.QUICK_API_TOKEN) {
    return { ok: false, produtos: 0, erro: 'QUICK_API_URL ou QUICK_API_TOKEN não configurados' }
  }
  // Two refreshes at once (the 6h timer firing while someone hits
  // /catalogo-status?recarregar=1) would interleave and wipe each other's
  // shape diagnostics, so the second caller just waits for the first.
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = loadCatalogFromApi(forcar)
  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

// Renders an API product. Nothing is inferred here: the source states which
// fields are the product's own spec and which are selectable options, so the
// fixed-versus-choice line the assistant relies on is simply reported.
function describeApiEntry(e: CatalogEntry, p: ApiProduct): string {
  const fixed = [
    p.formato && `Formato: ${p.formato}`,
    p.material && `Material: ${p.material}`,
    p.revestimento && `Revestimento: ${p.revestimento}`,
    p.acabamento && `Acabamento: ${p.acabamento}`,
    p.cores && `Cores/Impressão: ${p.cores}`,
  ]
    .filter(Boolean)
    .join(' | ')

  const lines = [`### ${p.titulo} [${e.category} / ${e.subcategory}]`]
  if (fixed) lines.push(`FIXO: ${fixed}`)
  if (p.prazo) lines.push(`Prazo: ${p.prazo}`)

  const tiers = priceTiers(p)
  const regras = priceRules(p)
  if (tiers.length) {
    lines.push(`PREÇO: ${tiers.map(tierLabel).join('; ')}`)
    const aviso = tierWarning(tiers)
    if (aviso) lines.push(aviso)
    if (regras) {
      lines.push(`⚠️ REGRA DE PREÇO (mínimo/m²/desconto): ${regras}`)
    }
  } else if (regras) {
    // Product migrated to m²-based pricing — regras IS the price source.
    lines.push(`PREÇO POR m²: ${regras}`)
    lines.push('⚠️ Use SOMENTE a regra acima para calcular o preço. Não há tabela fixa de preços.')
  } else {
    lines.push('PREÇO: não veio — confirme com a equipe, não estime.')
  }

  // Group the options by what they're choosing, so each group becomes one
  // question instead of a mixed list.
  const groups = new Map<string, string[]>()
  for (const v of asArray<ApiVariation>(p.variacoes)) {
    if (!v?.nome) continue
    const g = v.opcao || 'opção'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(`${v.nome}${surchargeLabel(v)}`)
  }
  lines.push(
    groups.size
      ? `ESCOLHAS: ${[...groups].map(([g, vals]) => `[${g}] ${vals.join('; ')}`).join(' || ')}`
      : 'ESCOLHAS: NENHUMA',
  )

  // The short description is often just the production time restated, which the
  // Prazo line already carries — repeating it costs tokens on every search and
  // tells the assistant nothing new. Only genuinely new text is worth carrying.
  if (p.descricao_curta) {
    const txt = String(p.descricao_curta).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    const redundant = !txt || /^tempo de produ|^prazo/i.test(txt) || (p.prazo && txt.includes(p.prazo))
    if (!redundant) lines.push(`Sobre: ${txt.slice(0, 200)}`)
  }
  return lines.join('\n') + '\n\n'
}

// Renders one product the way the assistant should reason about it.
function describeEntry(e: CatalogEntry): string {
  if (e.api) return describeApiEntry(e, e.api)
  const f = FACTS.get(e) ?? parseFacts(e)
  const variations = realVariations(e)
  const varyingKeys = new Set(variations.map((v) => v.key))

  const fixed = SPEC_KEYS.filter((k) => f.specs.has(k) && !varyingKeys.has(k))
    .map((k) => `${k}: ${f.specs.get(k)}`)
    .join(' | ')
  const thisOne = SPEC_KEYS.filter((k) => varyingKeys.has(k) && f.specs.has(k))
    .map((k) => `${k}: ${f.specs.get(k)}`)
    .join(' | ')

  // Same marker vocabulary as the API path. They were different for a while \u2014
  // this path still said "J\u00c1 VEM ASSIM (fixo \u2014 nunca pergunte\u2026)" while the
  // instructions taught "FIXO:" \u2014 so whenever the API was down and this
  // fallback took over, the assistant met labels nothing had told it about.
  // (Two markers are still path-specific by nature: ESTA VERS\u00c3O / \u26a0\ufe0f PRE\u00c7O EM
  // CONFLITO can only be derived from the snapshot's sibling entries, and the
  // per-unit vs one-off surcharge split only exists in the API's data. Both are
  // documented as such in instrucoes.md.)
  const lines = [`### ${e.heading} [${e.category} / ${e.subcategory}]`]
  if (fixed) lines.push(`FIXO: ${fixed}`)
  if (thisOne) lines.push(`ESTA VERS\u00c3O: ${thisOne}`)
  const priceText: string[] = []
  for (const p of f.priceLines) {
    const line = p
      .replace(/^Pre\u00e7o por quantidade:/i, 'PRE\u00c7O:')
      .replace(/^Pre\u00e7o:/i, 'PRE\u00c7O:')
      // "(de R$ 0,00)" is an empty was-price field, not a discount. Left in,
      // it reads as a markdown and invites announcing a sale that isn't one.
      .replace(/\s*\(de R\$ 0,00\)/gi, '')
    priceText.push(line)
    lines.push(line)
  }

  // Same anomaly check as the API path, run over the snapshot's own text.
  const avisoFaixas = tierWarning(tiersFromText(priceText.join(' ')))
  if (avisoFaixas) lines.push(avisoFaixas)

  // The API path warns about products priced by rule (per m\u00b2, with a minimum
  // charge and quantity discounts) because the source hands it a `regras` blob.
  // This path had no equivalent, so in fallback mode the assistant saw a bare
  // "R$ 69,00/m\u00b2" and \u2014 per its own instructions, which only hold back when
  // this marker appears \u2014 worked out and quoted the total itself, from a
  // snapshot that may be months old. The rules are detectable in the text, so
  // the same brake is applied here.
  const joined = priceText.join(' ')
  if (/\/m\u00b2|\bm\u00ednimo\b|Desconto por quantidade|a partir de/i.test(joined)) {
    lines.push(
      '\u26a0\ufe0f REGRA DE PRE\u00c7O: esse produto \u00e9 cobrado por regra (pre\u00e7o por m\u00b2, valor m\u00ednimo e/ou desconto por faixa). ' +
        'D\u00ea o valor de refer\u00eancia por m\u00b2 e o m\u00ednimo, mas N\u00c3O feche o total sozinha: diga que a equipe confirma o valor final.',
    )
  }

  // The snapshot writes every option in one flat run, repeating the tag on each
  // item: "[modelo] FACA; [modelo] GOTA; [tamanho] 65x190cm; ...". Read as one
  // group — which is what the "||" convention implies — the assistant would ask
  // the customer to choose between a model and a size in the same list. Group
  // them here so both catalog sources present options the same way.
  const choices: string[] = []
  if (f.options) {
    const byTag = new Map<string, string[]>()
    for (const part of f.options.split(';')) {
      const m = part.trim().match(/^\[([^\]]+)\]\s*(.+)$/)
      if (!m) continue
      if (!byTag.has(m[1])) byTag.set(m[1], [])
      // Unlike the API, the snapshot never says whether an add-on is per unit
      // or a one-off charge. Saying so is the difference between R$ 180 and
      // R$ 180.000, so an unmarked value is flagged rather than assumed.
      byTag.get(m[1])!.push(m[2].replace(/\(\+(R\$\s*[\d.,]+)\)/, '(+$1 A CONFIRMAR)'))
    }
    for (const [tag, vals] of byTag) choices.push(`[${tag}] ${vals.join('; ')}`)
  }
  for (const v of variations) choices.push(`[${v.key}] ${v.values.join('; ')}`)
  lines.push(choices.length ? `ESCOLHAS: ${choices.join(' || ')}` : 'ESCOLHAS: NENHUMA')

  const conflicts = conflictingPrices(e)
  if (conflicts.length) {
    lines.push(
      `\u26a0\ufe0f PRE\u00c7O EM CONFLITO: o cat\u00e1logo tem outra(s) tabela(s) de pre\u00e7o para exatamente esta mesma ficha \u2014 ${conflicts.join(' | ')}. ` +
        'N\u00c3O escolha uma delas e N\u00c3O d\u00ea valor fechado. Diga ao cliente que confirma o pre\u00e7o exato desse item com a equipe antes de fechar.',
    )
  }
  return lines.join('\n') + '\n\n'
}

const MAX_SEARCH_RESULTS = 8
const MAX_SEARCH_CHARS = 6000
// Same product in several sizes/codes shouldn't eat every result slot.
const MAX_PER_HEADING = 2

// Words that sit in hundreds of product names ("personalizada") or in every
// sentence ("para", "quero"). Scoring them buries the real answer: before this
// list, "algo para colocar na camiseta" returned Bloco / Caderno Personalizado,
// because "personalizado" is in ~200 headings and "camiseta" is in none.
const SEARCH_STOPWORDS = new Set(
  ('a o as os e de da do das dos para pra por com em na no nas nos um uma uns umas que qual quais ' +
    'meu minha meus minhas seu sua eu voce voces vcs quero queria preciso precisava gostaria ' +
    'fazer faz tem tenho ter algo alguma alguns coisa sobre mais menos muito pouco bem ser vai vou ' +
    'esta este isso aqui ali la ai colocar usar comprar orcamento valor ' +
    'personalizado personalizada personalizados personalizadas impresso impressa impressos impressas ' +
    // Field labels that appear in every single entry ("Material:", "Formato:"),
    // so they rank nothing — they just add noise to whatever else was asked.
    'material formato acabamento prazo cores impressao preco precos opcoes opcao quantidade ' +
    'unidade unidades produto produtos').split(' '),
)

// Bridges what the customer says to what this catalog calls things. "Camiseta"
// appears nowhere in the catalog — the product is "Adesivo DTF TÊXTIL". Each
// rule that matches the customer's phrase adds its catalog terms to the query,
// so intent finds the product with no word in common. Every term here was
// checked against real headings in catalogo.md.
const SEARCH_INTENTS: Array<{ when: RegExp; add: string }> = [
  { when: /camiset|camisa|blusa|roupa|uniforme|tecido|estampa|moletom|bone/, add: 'dtf textil' },
  { when: /carro|veiculo|moto|frota|van|caminhao|adesivar o carro|envelopamento/, add: 'vinil metro quadrado plotter recorte' },
  { when: /feira|stand|estande|exposicao|congresso|palestra|convencao/, add: 'roll up wind banner totem backdrop' },
  // "credencias" (sic) is how the catalog spells it — the real product names are
  // "Credencias Papel Cartão" and "Credencias PVC". Searching the customer's
  // word, "credencial", scored zero against both, so the term used here is the
  // catalog's spelling, not the correct Portuguese one.
  { when: /identific|credencia|cracha|acesso|participante|convidado|inscrit/, add: 'pulseira cracha credencias cordao' },
  { when: /vitrine|porta de vidro|janela|vidro da loja/, add: 'adesivo vitrine' },
  { when: /fachada|frente da loja|muro|tapume/, add: 'lona perfurada adesivo vitrine faixa banner' },
  { when: /divulg|propagand|anunci|publicidade|chamar atencao|na rua|marketing/, add: 'banner faixa panfleto cartaz wind banner' },
  { when: /chao|piso|pisar/, add: 'adesivo de piso' },
  { when: /parede/, add: 'papel de parede adesivo vitrine' },
  { when: /quadro|decorar|decoracao|sala|quarto|ambiente/, add: 'quadro decorativo canvas' },
  { when: /cardapio|restaurante|lanchonete|bar |pizzaria|menu do/, add: 'cardapio' },
  { when: /brinde|lembranc|souvenir|mimo|presente|sorteio/, add: 'caneca caneta squeeze copo termico botton mouse pad' },
  { when: /caixa de luz|luminoso|iluminad|backlight/, add: 'lona backlight' },
  { when: /embalagem|rotulo|pote|frasco|garrafa|sache|produto meu/, add: 'adesivo rotulo etiqueta embalagens' },
  { when: /lacre|violac|seguranc|inviolavel/, add: 'lacre de seguranca' },
  { when: /panfleto|folheto|flyer|volante|encarte/, add: 'panfletos flyers folhetos' },
  { when: /cartaz|poster/, add: 'cartaz' },
  { when: /calendario/, add: 'calendario' },
  { when: /ima |imã|geladeira/, add: 'ima geladeira calendario com ima' },
  { when: /bloco|comanda|pedido de mesa|via |vias/, add: 'blocos comandas vias' },
  { when: /receituario|timbrado|medic|clinica|consultorio/, add: 'papel timbrado receituario' },
  { when: /apostila|revista|livro|encaderna|curso/, add: 'apostila revista' },
  { when: /certificado|diploma|formatura/, add: 'certificado' },
  { when: /pasta/, add: 'pasta bolsa orelha' },
  { when: /tatuagem/, add: 'tatuagem temporaria' },
  { when: /foto|fotografia|revelar/, add: 'impressao foto quadro canvas' },
  { when: /bandeira/, add: 'bandeira wind banner' },
  { when: /placa|sinaliza|imobiliaria|corretor|aluga|vende-se/, add: 'placa pvc placa imobiliaria totem' },
  { when: /viseira|ventarola|leque|abanador/, add: 'viseira ventarola' },
  { when: /marcador de pagina|marca pagina/, add: 'marcador de pagina' },
  { when: /festa|casamento|aniversario|batizado|noiv/, add: 'painel de festa tag cartao agradecimento adesivo rotulo' },
  { when: /rifa/, add: 'rifa' },
  { when: /wobbler|pdv|gondola|supermercado/, add: 'wobbler' },
  { when: /troca de oleo|oficina|mecanic/, add: 'adesivo troca de oleo' },
  { when: /escolar|volta as aulas|material escolar|caderno do/, add: 'etiqueta escolar' },
  { when: /plotagem|planta|projeto|arquitet|engenhar/, add: 'plotagem' },
  { when: /postal|post card/, add: 'postais' },
  { when: /almofada/, add: 'capa de almofada' },
  { when: /mouse ?pad/, add: 'mouse pad' },
  { when: /caderno|anotac|agenda/, add: 'caderno bloco' },
  { when: /palco|fundo de|backdrop|painel/, add: 'backdrop lona painel' },
  { when: /pendurar|parede externa|muro|tapume/, add: 'banner lona faixa' },
]

// ---------------------------------------------------------------------------
// Dimension normalizer — customers say "80x120cm", "0,80x1,20m",
// "80cm de largura por 120cm de altura", "80 por 120 cm", etc. This extracts
// every WxH pair and normalizes it to canonical "WxHcm" so all forms compare
// equal when matching against the catalog's formato field.
// ---------------------------------------------------------------------------
function dimToCm(v: number, unit: string): number {
  if (unit === 'm') return v * 100
  if (unit === 'mm') return v / 10
  return v
}
function fmtDimCm(n: number): string {
  n = Math.round(n * 10) / 10        // avoid float drift (0.80*100→80.0…01)
  return n % 1 === 0 ? String(n) : n.toFixed(1)
}
function extractDimsCm(text: string): string[] {
  const dims: string[] = []
  const s = text.toLowerCase().replace(/,/g, '.')   // comma decimals → dots

  // 1) "80x120cm", "0.80x1.20m", "80 x 120 cm"
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/g)) {
    const w = dimToCm(parseFloat(m[1]), m[3])
    const h = dimToCm(parseFloat(m[2]), m[3])
    dims.push(`${fmtDimCm(w)}x${fmtDimCm(h)}cm`)
  }

  // 2) "80cm de largura por 120cm de altura", "80cm por 120cm"
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(mm|cm|m)\b.{0,40}?por\s+(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/g)) {
    const w = dimToCm(parseFloat(m[1]), m[2])
    const h = dimToCm(parseFloat(m[3]), m[4])
    dims.push(`${fmtDimCm(w)}x${fmtDimCm(h)}cm`)
  }

  // 3) "80 por 120 cm" (unit only at the end)
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s+por\s+(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/g)) {
    const w = dimToCm(parseFloat(m[1]), m[3])
    const h = dimToCm(parseFloat(m[2]), m[3])
    dims.push(`${fmtDimCm(w)}x${fmtDimCm(h)}cm`)
  }

  return [...new Set(dims)]
}

function searchCatalog(query: string): string {
  const raw = normalize(query)
  if (!raw.trim()) return 'Termo de busca vazio.'

  // Customer's own words, minus the ones that match everything.
  const kept = raw.split(/\s+/).filter((w) => w && !SEARCH_STOPWORDS.has(w))
  // Plus whatever this catalog calls the thing they described.
  const intents = SEARCH_INTENTS.filter((r) => r.when.test(raw)).flatMap((r) => r.add.split(' '))
  // If the phrase was nothing but stopwords, fall back to the raw words so we
  // still search something instead of returning "nada encontrado".
  const own = kept.length ? kept : raw.split(/\s+/).filter(Boolean)
  // What the customer actually typed outranks what we inferred they meant, so a
  // literal search for "crachá" still leads with Crachá de PVC even though the
  // intent rule also pulls in cordão, pulseira and credencial.
  const words: Array<{ w: string; weight: number }> = [
    ...new Set(own),
  ].map((w) => ({ w, weight: 1 }))
  for (const w of new Set(intents)) {
    if (!words.some((x) => x.w === w)) words.push({ w, weight: 0.5 })
  }
  if (words.length === 0) return 'Termo de busca vazio.'

  // Canonical dimensions from the customer's query, so "0,80x1,20m" and
  // "80cm de largura por 120cm de altura" both resolve to "80x120cm".
  const queryDims = extractDimsCm(raw)

  const scored = CATALOG_ENTRIES.map((e) => {
    // Weight matches in the product name / category much higher than a
    // stray mention buried in some other product's options list — otherwise
    // e.g. searching "botton" surfaces unrelated products that happen to
    // list "+2 bottons" as an accessory add-on, burying the actual Botton
    // products under ties.
    const name = normalize(e.heading)
    const section = normalize(`${e.category} ${e.subcategory}`)
    const body = normalize(e.body)
    let score = 0
    for (const { w, weight } of words) {
      let hit = 0
      // The product's own name is the strongest signal. Its category is a much
      // weaker one: the category "banners-e-faixas" contains the words "banner"
      // and "faixa", so without this gap every product in it — a Placa
      // Imobiliária included — tied with the actual Banner.
      if (name.includes(w)) {
        hit += 8
        // A product whose name *starts* with the word usually IS the thing
        // asked for, rather than something that merely mentions it: "Crachá de
        // PVC" should beat "Cordão para crachá" on a search for "crachá".
        if (name.startsWith(w)) hit += 4
      } else if (section.includes(w)) hit += 3
      // Count repeated body mentions too (relevant products tend to repeat
      // the term across variations/tiers), but cap so one huge options list
      // can't out-rank a real name match.
      const bodyHits = body.split(w).length - 1
      hit += Math.min(bodyHits, 3)
      score += hit * weight
    }
    // Dimension bonus: when the customer asked for a specific size, the entry
    // whose formato matches that exact size should rank above its siblings.
    // Without this, "banner 80x120cm" scored the same as "banner 40x60cm"
    // because the size lives in the formato field (body), not the heading,
    // and "80x120cm" (no space) didn't match "80x120 cm" (with space).
    if (queryDims.length > 0 && e.api?.formato) {
      const entryDims = extractDimsCm(e.api.formato)
      if (queryDims.some((qd) => entryDims.includes(qd))) score += 10
    }
    return { e, score }
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    return `Nenhum produto encontrado para "${query}". Tente outra palavra-chave (nome do produto, categoria ou material).`
  }

  // The same product often has a dozen entries (one per size or code). Showing
  // all of them spends the whole budget on one product, so cap the repeats and
  // let other products through.
  // Group by the product name with its code stripped: the same product shows up
  // both as "Quadro ... - Envie sua Foto" and "Quadro ... - Envie sua Foto
  // (4FAB496E)", which would otherwise slip past the cap as different names.
  // ...and also with the trailing size stripped, so "Cordão para crachá - 9mm"
  // through "- 20mm" count as one product instead of filling every slot with
  // the same item in four widths.
  const baseName = (h: string) =>
    h
      .replace(/\s*\([0-9A-Za-z]+\)\s*$/, '')
      .replace(/\s*[-–]?\s*\d+([.,]\d+)?\s*x\s*\d+([.,]\d+)?\s*(mm|cm|m)?\s*$/i, '')
      .replace(/\s*[-–]?\s*\d+([.,]\d+)?\s*(mm|cm|m)\s*$/i, '')
      .trim()
  // A precise search shouldn't cost as much as a vague one. When the best match
  // stands well clear of the rest — "cartão de visita promocional" — the tail is
  // noise the assistant pays for and then ignores, so it's cut. A broad,
  // exploratory search ("algo pra divulgar") has a flat score curve and keeps
  // its full spread, which is exactly when seeing the range helps.
  const best = scored[0].score
  const relevant = scored.filter((r) => r.score >= best * 0.4)

  // A query word that's a bare measurement ("20mm", "15x20cm", "300g") names
  // one specific variant in a family, not the family in general. Real bug
  // found in testing: a family with 3+ size variants (e.g. Cordão para
  // crachá: 12mm/15mm/20mm) only lets MAX_PER_HEADING through per search, so
  // a customer asking generically ("cordão personalizado") got 12mm and
  // 15mm and the assistant told them 20mm "doesn't exist" — even though it's
  // a real, priced product, just excluded by the cap and, because
  // MAX_PER_HEADING's own baseName grouping had already claimed that
  // family's slots, also dropped from the "outros produtos" fallback list.
  // When the customer (or the assistant's own search term) is specific
  // enough to name a variant, that variant must never be the one the cap
  // silently drops.
  const measurementWords = own.filter((w) => /^\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)?(?:mm|cm|m|g|kg)$/i.test(w))
  // The API formats sizes with a space before the unit ("80x120 cm") while
  // customers type them without ("80x120cm"). Collapse the space so both forms
  // match — without this, the measurement bypass never fires for products whose
  // size lives in the formato field instead of the heading, and MAX_PER_HEADING
  // silently drops the exact size the customer asked for.
  const collapseMeasure = (s: string) => s.replace(/(\d)\s+(mm|cm|m|g|kg)/gi, '$1$2')

  const seen = new Map<string, number>()
  const top: CatalogEntry[] = []
  const rest: CatalogEntry[] = []
  for (const { e } of relevant) {
    const key = baseName(e.heading)
    const n = seen.get(key) ?? 0
    const normalizedHeading = normalize(e.heading)
    // Check heading AND the formato field (where sizes actually live for
    // API-sourced products like Banner Padrão whose titulo is size-less).
    const normalizedFormato = e.api?.formato ? collapseMeasure(normalize(e.api.formato)) : ''
    // Two-tier check: first try canonical dimension match (handles m↔cm
    // conversion, comma decimals, separated forms like "80cm por 120cm"),
    // then fall back to the simpler word-in-heading/formato check for
    // weight-only measurements like "300g".
    const entryDims = e.api?.formato ? extractDimsCm(e.api.formato) : []
    const dimMatch = queryDims.length > 0 && entryDims.length > 0
      && queryDims.some((qd) => entryDims.includes(qd))
    const wordMatch = measurementWords.some((w) => {
      const collapsed = collapseMeasure(w)
      return normalizedHeading.includes(collapsed) || normalizedFormato.includes(collapsed)
    })
    const exactMeasurementMatch = dimMatch || wordMatch
    if ((n < MAX_PER_HEADING || exactMeasurementMatch) && top.length < MAX_SEARCH_RESULTS) {
      seen.set(key, n + 1)
      top.push(e)
    } else {
      rest.push(e)
    }
  }
  // Names only for everything that scored below the cut, so nothing is hidden —
  // the assistant still knows these exist and can search one by name.
  for (const { e } of scored.slice(relevant.length)) rest.push(e)

  let out = ''
  for (const e of top) {
    const block = describeEntry(e)
    // `continue`, not `break`: one oversized product (a huge ESCOLHAS list)
    // used to discard every smaller product behind it as well.
    if (out.length + block.length > MAX_SEARCH_CHARS) continue
    out += block
  }

  // A single product whose own block already blows the budget left `out` empty,
  // and an empty tool result tells the model nothing at all — it then loops or
  // escalates for a product that was, in fact, found. Send it truncated instead.
  if (!out && top.length > 0) {
    out = `${describeEntry(top[0]).slice(0, MAX_SEARCH_CHARS)}\n[ficha cortada por tamanho — se precisar de um detalhe que não apareceu, pergunte à equipe em vez de supor]\n`
  }

  // Names only (cheap) of other products that also matched, so the assistant
  // knows what else exists and can search one of them specifically.
  const others = [...new Set(rest.map((e) => baseName(e.heading)))].filter((h) => !seen.has(h)).slice(0, 12)
  if (others.length) {
    out += `Outros produtos que também combinam com essa busca (busque pelo nome pra ver preço e detalhes): ${others.join('; ')}\n`
  }

  const final = out.trim()
  // Belt and braces: never hand the model an empty tool result.
  return final || `Encontrei produtos para "${query}", mas não consegui ler as fichas deles. Não estime preço nem características: diga que a equipe confirma.`
}

// --- Sheet-sticker pricing (deterministic) ---
//
// "Folha Adesivo Personalizado" is priced BY SHEET, but customers ask in
// stickers ("100 adesivos 6x6cm"). Getting from one to the other means: how many
// fit on a 30x45cm sheet, how many sheets that needs, then the price tier for
// THAT sheet count. The model got this wrong repeatedly — charging per sticker
// (30x the real price), and quoting the 100-499 tier for a 5-sheet order — so
// the arithmetic lives here instead of in the prompt.

const SHEET_PRODUCT_CODE = 'A69E2B83'
const SHEET_W_CM = 30
const SHEET_H_CM = 45

function parseBRL(s: string): number {
  return Number(s.replace(/\./g, '').replace(',', '.'))
}

function brl(n: number): string {
  // Guard first: NaN.toFixed(2) is "NaN", which contains no ".", so `dec` came
  // out undefined and this returned the literal string "R$ NaN,undefined" —
  // which then reached the model's context as if it were a real price.
  if (!Number.isFinite(n)) return 'valor a confirmar'
  const [int, dec] = n.toFixed(2).split('.')
  return `R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}

// Looked up on every call rather than frozen at boot. These were consts built
// from the static snapshot, so after the live catalog loaded the calculator
// kept quoting the old sheet price while every other answer used the current
// one — the same product, two prices, in one conversation.
// Matched by name, tolerantly. The old lookup led with a product code that only
// exists in the static snapshot's headings — the live API's heading is just the
// bare title — so on the live catalog it always fell through to an exact-phrase
// match, and any difference in wording left the calculator with no product at
// all.
function isSheetHeading(heading: string): boolean {
  const h = normalize(heading)
  return h.includes('folha') && h.includes('adesivo')
}

function sheetEntry(): CatalogEntry | undefined {
  return (
    CATALOG_ENTRIES.find((e) => e.heading.includes(SHEET_PRODUCT_CODE)) ??
    CATALOG_ENTRIES.find((e) => normalize(e.heading).includes('folha adesivo personalizado')) ??
    CATALOG_ENTRIES.find((e) => isSheetHeading(e.heading))
  )
}

// The same product in the bundled snapshot, used as the fallback price table.
function staticSheetEntry(): CatalogEntry | undefined {
  return (
    STATIC_ENTRIES.find((e) => e.heading.includes(SHEET_PRODUCT_CODE)) ??
    STATIC_ENTRIES.find((e) => isSheetHeading(e.heading))
  )
}

function tiersFromStaticBody(e: CatalogEntry | undefined): Array<{ min: number; max: number; price: number }> {
  if (!e) return []
  const line = e.body.split('\n').find((l) => l.includes('Preço por quantidade')) ?? ''
  return [...line.matchAll(/(\d+)\s*-\s*(\d+)un:\s*R\$\s*([\d.,]+)/g)]
    .map((m) => ({ min: Number(m[1]), max: Number(m[2]), price: parseBRL(m[3]) }))
    .sort((a, b) => a.min - b.min)
}

// Where the tier table in use came from, for /folha-check.
let sheetTiersSource = 'indefinido'

function sheetTiers(): Array<{ min: number; max: number; price: number }> {
  const e = sheetEntry()
  if (!e) {
    sheetTiersSource = 'nenhum produto encontrado'
    return []
  }

  // From the API the tiers are exact quantities (100un, 250un, 500un…); the
  // static snapshot writes them as ranges (1-5un, 6-9un…). Both describe the
  // same thing: how much one sheet costs at that order size.
  if (e.api) {
    const tiers = priceTiers(e.api)
    if (tiers.length > 0) {
      // A per-unit range (de/ate/preco_unit) already IS a sheet band: "1 to 5
      // sheets at R$ 10,90 each". A quantity row (qtde/preco_atual) is a total
      // for one quantity, so the band runs up to the next quantity.
      sheetTiersSource = `API (${tiers.length} faixas, ${tiers[0].perUnit ? 'por unidade' : 'por quantidade'})`
      return tiers.map((t, i) => ({
        min: t.min,
        max: t.perUnit
          ? t.max
          : i + 1 < tiers.length
            ? tiers[i + 1].min - 1
            : Number.MAX_SAFE_INTEGER,
        price: t.price,
      }))
    }
    // This product is priced by rule, so the live API carries its materials but
    // no tier rows at all. That used to leave the calculator dead — the single
    // most-asked product answered with "não consegui ler a tabela" on every
    // request. The bundled snapshot does have the tiers, and they are the same
    // table the site prices from, so fall back to it rather than give up.
    const fallback = tiersFromStaticBody(staticSheetEntry())
    sheetTiersSource = fallback.length
      ? `snapshot (API sem faixas; ${fallback.length} faixas)`
      : 'API sem faixas e snapshot sem faixas'
    return fallback
  }

  const own = tiersFromStaticBody(e)
  sheetTiersSource = own.length ? `snapshot (${own.length} faixas)` : 'snapshot sem faixas'
  return own
}

function materialsFromStaticBody(e: CatalogEntry | undefined): Array<{ name: string; extra: number }> {
  if (!e) return []
  const line = e.body.split('\n').find((l) => l.includes('Opções:')) ?? ''
  const out: Array<{ name: string; extra: number }> = []
  for (const part of line.split(';')) {
    const m = part.match(/\[material\]\s*([^(]+?)\s*(?:\(\+R\$\s*([\d.,]+)\))?\s*$/)
    if (m) out.push({ name: m[1].trim(), extra: m[2] ? parseBRL(m[2]) : 0 })
  }
  return out
}

function sheetMaterials(): Array<{ name: string; extra: number }> {
  const e = sheetEntry()
  if (!e) return []

  if (e.api) {
    const fromApi = asArray<ApiVariation>(e.api.variacoes)
      .filter((v) => v?.nome && /material/i.test(v.opcao ?? ''))
      // toNumber, not Number: a value arriving as "4,00" became NaN, and
      // `|| 0` then silently turned a real surcharge into zero.
      .map((v) => ({ name: v.nome, extra: Number.isFinite(toNumber(v.valor)) ? toNumber(v.valor) : 0 }))
    if (fromApi.length > 0) return fromApi
    // Same fallback as the tiers: never leave the calculator without materials.
    return materialsFromStaticBody(staticSheetEntry())
  }

  return materialsFromStaticBody(e)
}

// Matches what the customer tapped against the catalog's own material names.
//
// The old matcher was exact-or-substring, and that broke on the most ordinary
// case there is: WhatsApp cuts a button title at 20 characters, so the
// assistant shortens "Vinil Adesivo Brilho" to "Vinil Brilho" to fit — and
// neither string contains the other, so the calculator rejected a material the
// customer had just picked from a list it produced itself.
//
// Word-based instead: every word the customer said must appear in the
// candidate. "vinil brilho" matches "Vinil Adesivo Brilho" and nothing else,
// while a genuinely ambiguous "vinil" matches four and is reported as such
// rather than silently resolving to the first (and cheapest) one.
function matchMaterial(
  material: string,
  materiais: Array<{ name: string; extra: number }>,
): { name: string; extra: number } | 'ambiguo' | undefined {
  const want = normalize(material)
  if (!want) return undefined

  const exact = materiais.find((m) => normalize(m.name) === want)
  if (exact) return exact

  const wantWords = want.split(/\s+/).filter((w) => w.length > 1)
  if (wantWords.length === 0) return undefined

  const hits = materiais.filter((m) => {
    const name = normalize(m.name)
    const nameWords = new Set(name.split(/\s+/))
    return wantWords.every((w) => nameWords.has(w) || name.includes(w))
  })
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return 'ambiguo'

  // Last resort, the original substring behaviour — kept so nothing that used
  // to resolve stops resolving.
  const loose = materiais.filter((m) => normalize(m.name).includes(want) || want.includes(normalize(m.name)))
  if (loose.length === 1) return loose[0]
  if (loose.length > 1) return 'ambiguo'
  return undefined
}

function materialList(): string {
  return sheetMaterials().map((m) => (m.extra ? `${m.name} (+${brl(m.extra)})` : m.name)).join('; ')
}

function quoteSheetStickers(larguraCm: number, alturaCm: number, quantidade: number, material?: string): string {
  const tiers = sheetTiers()
  const materiais = sheetMaterials()
  if (!sheetEntry() || tiers.length === 0) {
    // Names the actual cause, so the Railway log says which half failed instead
    // of only that something did.
    console.error(
      `calcular_folha_adesivo: sem tabela de preço — produto=${sheetEntry()?.heading ?? 'NÃO ENCONTRADO'}, origem=${sheetTiersSource}`,
    )
    return 'Não consegui ler a tabela desse produto no catálogo. Não estime o valor — diga que a equipe confirma o preço.'
  }
  // Number.isFinite rejects NaN and Infinity as well as 0 and negatives. Without
  // the finite check, an absurd value came back to the customer echoed verbatim
  // ("Um adesivo de Infinityx5cm..."). The upper bounds are sanity limits: a
  // sticker wider than the sheet is handled below, and a million-unit order is
  // a team conversation, not a calculation.
  const valido = (n: number, max: number) => Number.isFinite(n) && n > 0 && n <= max
  if (!valido(larguraCm, 1000) || !valido(alturaCm, 1000) || !valido(quantidade, 1_000_000)) {
    return 'Medidas ou quantidade inválidas. Peça ao cliente a largura e a altura em cm e a quantidade de adesivos.'
  }

  // Try the art both ways round on the sheet and keep whichever fits more.
  const perSheet = Math.max(
    Math.floor(SHEET_W_CM / larguraCm) * Math.floor(SHEET_H_CM / alturaCm),
    Math.floor(SHEET_W_CM / alturaCm) * Math.floor(SHEET_H_CM / larguraCm),
  )
  if (perSheet < 1) {
    return `Um adesivo de ${larguraCm}x${alturaCm}cm NÃO cabe na folha de ${SHEET_W_CM}x${SHEET_H_CM}cm, então esse pedido não é "Folha Adesivo Personalizado". É adesivo grande formato, cobrado por m²: busque "adesivo vinil metro quadrado" e cote por área.`
  }

  const folhas = Math.ceil(quantidade / perSheet)
  // Below the first tier is not an error: whether the source lists tiers from 1
  // or from 100, the smallest-quantity tier is the right (and most expensive
  // per unit) price for a small order. Only going past the largest tier is a
  // real gap, and that one goes to the team.
  const first = tiers[0]
  const last = tiers[tiers.length - 1]
  const tier = tiers.find((t) => folhas >= t.min && folhas <= t.max) ?? (folhas < first.min ? first : undefined)
  if (!tier) {
    return `Esse pedido daria ${folhas} folhas, acima da maior faixa de preço do catálogo (${last.max === Number.MAX_SAFE_INTEGER ? last.min : last.max} folhas). Não estime nem faça regra de três — diga que a equipe confirma o preço dessa quantidade.`
  }

  let extra = 0
  let materialName = materiais[0]?.name ?? 'material padrão'
  if (material) {
    const found = matchMaterial(material, materiais)
    if (found === 'ambiguo') {
      return `"${material}" pode ser mais de um material desse produto. Os reais são: ${materialList()}. Pergunte ao cliente qual exatamente (com mostrar_opcoes) antes de calcular.`
    }
    if (!found) {
      return `O material "${material}" não existe nesse produto. Os reais são: ${materialList()}. Pergunte ao cliente qual desses ele quer (com mostrar_opcoes) antes de calcular.`
    }
    extra = found.extra
    materialName = found.name
  }

  const unit = tier.price + extra
  return [
    'CÁLCULO OFICIAL DO SISTEMA — use exatamente estes números, não recalcule:',
    `- Produto: Folha Adesivo Personalizado (${SHEET_PRODUCT_CODE}) — ${materialName}`,
    `- Cabem ${perSheet} adesivos de ${larguraCm}x${alturaCm}cm na folha de ${SHEET_W_CM}x${SHEET_H_CM}cm`,
    `- ${quantidade} adesivos ÷ ${perSheet} por folha = ${folhas} folha(s), arredondando pra cima`,
    `- Faixa para ${folhas} folha(s): ${tier.min}-${tier.max} folhas a ${brl(tier.price)}/folha` +
      (extra ? ` + ${brl(extra)} de ${materialName} = ${brl(unit)}/folha` : ''),
    `- TOTAL: ${brl(unit * folhas)}`,
    folhas >= 10 || quantidade >= 1000
      ? '- Pedido grande: avise numa frase que a equipe confirma esse valor antes de fechar.'
      : '- Pode fechar esse valor normalmente.',
    material ? '' : `- O cliente ainda não escolheu material; este total usa "${materialName}". Materiais reais: ${materialList()}`,
  ]
    .filter(Boolean)
    .join('\n')
}

// --- Tattoo-cartela pricing (deterministic) ---
//
// Same shape of problem as the adhesive sheet above, found in real testing:
// "Cartela Tatuagem Temporária Personalizado" is priced BY CARTELA (a sheet
// of designs), but a customer orders by individual tattoo size ("200
// tatuagens de 3x3cm"). Without a calculator, the assistant — correctly,
// per the instructions at the time — refused to guess the fit and punted the
// whole order to the team instead of closing it on the spot. The fit math is
// identical to the sticker sheet (try both orientations, keep the better
// one); what differs is that this product has two cartela sizes to choose
// from (14x20cm standard, 20x28cm for +R$10,00/un) instead of one fixed
// sheet, and if the art doesn't fit the standard size the calculator should
// try the larger one automatically rather than just giving up.

const CARTELA_PRODUCT_CODE = 'CED11D5E'

function isCartelaHeading(heading: string): boolean {
  const h = normalize(heading)
  return h.includes('cartela') && h.includes('tatuagem')
}

function cartelaEntry(): CatalogEntry | undefined {
  return (
    CATALOG_ENTRIES.find((e) => e.heading.includes(CARTELA_PRODUCT_CODE)) ??
    CATALOG_ENTRIES.find((e) => normalize(e.heading).includes('cartela tatuagem temporaria personalizado')) ??
    CATALOG_ENTRIES.find((e) => isCartelaHeading(e.heading))
  )
}

function staticCartelaEntry(): CatalogEntry | undefined {
  return (
    STATIC_ENTRIES.find((e) => e.heading.includes(CARTELA_PRODUCT_CODE)) ??
    STATIC_ENTRIES.find((e) => isCartelaHeading(e.heading))
  )
}

let cartelaTiersSource = 'indefinido'

function cartelaTiers(): Array<{ min: number; max: number; price: number }> {
  const e = cartelaEntry()
  if (!e) {
    cartelaTiersSource = 'nenhum produto encontrado'
    return []
  }
  if (e.api) {
    const tiers = priceTiers(e.api)
    if (tiers.length > 0) {
      cartelaTiersSource = `API (${tiers.length} faixas, ${tiers[0].perUnit ? 'por unidade' : 'por quantidade'})`
      return tiers.map((t, i) => ({
        min: t.min,
        max: t.perUnit ? t.max : i + 1 < tiers.length ? tiers[i + 1].min - 1 : Number.MAX_SAFE_INTEGER,
        price: t.price,
      }))
    }
    const fallback = tiersFromStaticBody(staticCartelaEntry())
    cartelaTiersSource = fallback.length
      ? `snapshot (API sem faixas; ${fallback.length} faixas)`
      : 'API sem faixas e snapshot sem faixas'
    return fallback
  }
  const own = tiersFromStaticBody(e)
  cartelaTiersSource = own.length ? `snapshot (${own.length} faixas)` : 'snapshot sem faixas'
  return own
}

// Parses "[tamanho-da-cartela] 14x20cm; [tamanho-da-cartela] 20x28cm (+R$
// 10,00)" the same way materialsFromStaticBody parses [material] options.
function cartelaSizesFromStaticBody(
  e: CatalogEntry | undefined,
): Array<{ wCm: number; hCm: number; extra: number }> {
  if (!e) return []
  const line = e.body.split('\n').find((l) => l.includes('Opções:')) ?? ''
  const out: Array<{ wCm: number; hCm: number; extra: number }> = []
  for (const part of line.split(';')) {
    const m = part.match(
      /\[tamanho-da-cartela\]\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*cm\s*(?:\(\+R\$\s*([\d.,]+)\))?/i,
    )
    if (m) {
      out.push({
        wCm: Number(m[1].replace(',', '.')),
        hCm: Number(m[2].replace(',', '.')),
        extra: m[3] ? parseBRL(m[3]) : 0,
      })
    }
  }
  return out
}

function cartelaSizes(): Array<{ wCm: number; hCm: number; extra: number }> {
  const e = cartelaEntry()
  if (!e) return []
  if (e.api) {
    const fromApi = asArray<ApiVariation>(e.api.variacoes)
      .filter((v) => v?.nome && /tamanho/i.test(v.opcao ?? ''))
      .map((v) => {
        const m = /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)/.exec(v.nome)
        if (!m) return undefined
        return {
          wCm: Number(m[1].replace(',', '.')),
          hCm: Number(m[2].replace(',', '.')),
          extra: Number.isFinite(toNumber(v.valor)) ? toNumber(v.valor) : 0,
        }
      })
      .filter((x): x is { wCm: number; hCm: number; extra: number } => !!x)
    if (fromApi.length > 0) return fromApi
    return cartelaSizesFromStaticBody(staticCartelaEntry())
  }
  return cartelaSizesFromStaticBody(e)
}

function quoteTattooCartela(
  larguraCm: number,
  alturaCm: number,
  quantidade: number,
  tamanhoCartela?: string,
): string {
  const tiers = cartelaTiers()
  const tamanhos = cartelaSizes()
  if (!cartelaEntry() || tiers.length === 0 || tamanhos.length === 0) {
    console.error(
      `calcular_cartela_tatuagem: dados insuficientes — produto=${cartelaEntry()?.heading ?? 'NÃO ENCONTRADO'}, ` +
        `tiers=${cartelaTiersSource}, tamanhos=${tamanhos.length}`,
    )
    return 'Não consegui ler os tamanhos de cartela ou a tabela de preço desse produto no catálogo. Não estime o valor — diga que a equipe confirma.'
  }
  const valido = (n: number, max: number) => Number.isFinite(n) && n > 0 && n <= max
  if (!valido(larguraCm, 200) || !valido(alturaCm, 200) || !valido(quantidade, 1_000_000)) {
    return 'Medidas ou quantidade inválidas. Peça ao cliente a largura e a altura de UMA tatuagem em cm, e a quantidade de tatuagens.'
  }

  const fitsCount = (t: { wCm: number; hCm: number }) =>
    Math.max(
      Math.floor(t.wCm / larguraCm) * Math.floor(t.hCm / alturaCm),
      Math.floor(t.wCm / alturaCm) * Math.floor(t.hCm / larguraCm),
    )

  let tamanho = tamanhos.find((t) => t.extra === 0) ?? tamanhos[0]
  if (tamanhoCartela) {
    const norm = normalize(tamanhoCartela)
    const found = tamanhos.find((t) => norm.includes(String(t.wCm)) && norm.includes(String(t.hCm)))
    if (found) tamanho = found
  }

  let perCartela = fitsCount(tamanho)
  let avisoTamanho = ''
  if (perCartela < 1) {
    // Doesn't fit the chosen/default cartela — try the largest one available
    // before giving up, same instinct as the sheet calculator's m² fallback.
    const maior = [...tamanhos].sort((a, b) => b.wCm * b.hCm - a.wCm * a.hCm).find((t) => fitsCount(t) >= 1)
    if (!maior) {
      return (
        `Uma arte de ${larguraCm}x${alturaCm}cm não cabe em nenhum tamanho de cartela que a gente tem ` +
        `(${tamanhos.map((t) => `${t.wCm}x${t.hCm}cm`).join('; ')}). Não é esse produto — encaminhe pra equipe confirmar uma alternativa.`
      )
    }
    const padrao = tamanhos.find((t) => t.extra === 0)
    avisoTamanho = `- A arte só coube na cartela maior (${maior.wCm}x${maior.hCm}cm)${padrao ? ` — a de ${padrao.wCm}x${padrao.hCm}cm não comporta esse tamanho` : ''}.`
    tamanho = maior
    perCartela = fitsCount(tamanho)
  }

  const cartelas = Math.ceil(quantidade / perCartela)
  const first = tiers[0]
  const last = tiers[tiers.length - 1]
  const tier = tiers.find((t) => cartelas >= t.min && cartelas <= t.max) ?? (cartelas < first.min ? first : undefined)
  if (!tier) {
    return `Esse pedido daria ${cartelas} cartelas, acima da maior faixa de preço do catálogo (${last.max === Number.MAX_SAFE_INTEGER ? last.min : last.max} cartelas). Não estime nem faça regra de três — diga que a equipe confirma o preço dessa quantidade.`
  }

  const unit = tier.price + tamanho.extra
  return [
    'CÁLCULO OFICIAL DO SISTEMA — use exatamente estes números, não recalcule:',
    `- Produto: Cartela Tatuagem Temporária Personalizado — cartela de ${tamanho.wCm}x${tamanho.hCm}cm` +
      (tamanho.extra ? ` (+${brl(tamanho.extra)}/un)` : ' (tamanho padrão, sem acréscimo)'),
    avisoTamanho,
    `- Cabem ${perCartela} tatuagem(ns) de ${larguraCm}x${alturaCm}cm por cartela`,
    `- ${quantidade} tatuagens ÷ ${perCartela} por cartela = ${cartelas} cartela(s), arredondando pra cima`,
    `- Faixa para ${cartelas} cartela(s): ${tier.min}-${tier.max === Number.MAX_SAFE_INTEGER ? `${tier.min}+` : tier.max} cartelas a ${brl(tier.price)}/cartela` +
      (tamanho.extra ? ` + ${brl(tamanho.extra)} do tamanho maior = ${brl(unit)}/cartela` : ''),
    `- TOTAL: ${brl(unit * cartelas)}`,
    cartelas >= 10 || quantidade >= 500
      ? '- Pedido grande: avise numa frase que a equipe confirma esse valor antes de fechar.'
      : '- Pode fechar esse valor normalmente.',
    `- Tamanhos de cartela disponíveis: ${tamanhos.map((t) => `${t.wCm}x${t.hCm}cm${t.extra ? ` (+${brl(t.extra)})` : ''}`).join('; ')}`,
  ]
    .filter(Boolean)
    .join('\n')
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
  {
    name: 'mostrar_opcoes',
    description:
      'Envia uma pergunta com opções clicáveis pro cliente (vira botões se forem até 3, ou uma lista se forem 4 a 10) — em vez de escrever a pergunta e as opções como texto/lista numerada. Use sempre que for pedir pro cliente escolher entre 2 ou mais opções (tamanho, papel, acabamento, etc). Depois de chamar essa ferramenta pare — não escreva mais nenhum texto, a pergunta já foi enviada pra ele. Se só houver 1 opção possível (não é escolha), responda em texto normal em vez de usar essa ferramenta. IMPORTANTE: quando as opções forem características de um produto (tipo, cor, tamanho, material, acabamento), elas têm que vir literalmente do que `buscar_catalogo` retornou — nunca invente uma variação que não apareceu na busca, mesmo que pareça óbvia. A exceção são as listas fixas que as instruções já trazem prontas (as formas de entrega e retirada, por exemplo): essas não vêm do catálogo e podem ser usadas como estão. Cada título tem no máximo 20 caracteres — o que passar disso é cortado, então coloque a informação essencial no início e os detalhes no campo "descricao". O limite é 10 opções: se a lista do catálogo tiver mais que isso (alguns produtos têm 11, 13 tamanhos), NÃO mande as 10 primeiras como se fossem todas — pergunte antes algo que estreite (a finalidade, ou uma faixa de tamanho) e só então ofereça as que sobraram.',
      input_schema: {
      type: 'object',
      properties: {
        pergunta: {
          type: 'string',
          description: 'Pergunta curta que introduz as opções, ex: "Qual tamanho você prefere?"',
        },
        opcoes: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              titulo: {
                type: 'string',
                description:
                  'Texto curto do botão/opção. O WhatsApp corta em 20 caracteres quando são 2 ou 3 opções (viram botões) e em 24 quando são 4 a 10 (vira lista). Use no máximo 20 pra nunca ser cortado. Ex: "10x15cm", "Papel Kraft".',
              },
              descricao: {
                type: 'string',
                description: 'Detalhe extra opcional (só aparece quando vira lista, com 4+ opções), ex: "Couchê 90g, 4x0 — R$ 400,00"',
              },
              valor: {
                type: 'string',
                description:
                  'Texto completo dessa escolha, como se o cliente tivesse digitado (inclua tamanho/papel/acabamento e preço se souber) — é isso que volta pra você quando o cliente clicar aqui.',
              },
            },
            required: ['titulo', 'valor'],
          },
          description: 'Lista de 2 a 10 opções pro cliente escolher clicando.',
        },
      },
      required: ['pergunta', 'opcoes'],
    },
  },
  {
    name: 'calcular_folha_adesivo',
    description:
      'Calcula o preço exato de adesivos cortados em folha ("Folha Adesivo Personalizado"): quantos cabem na folha de 30x45cm, quantas folhas o pedido precisa, a faixa de preço correta pra esse número de folhas, e o total. Use SEMPRE que o cliente pedir adesivo personalizado por quantidade e tamanho (ex: "100 adesivos 6x6cm") — nunca faça essa conta de cabeça nem reaproveite um preço de outra mensagem da conversa. Os números que essa ferramenta devolve são os oficiais: repita eles como vieram.',
    input_schema: {
      type: 'object',
      properties: {
        largura_cm: {
          type: 'number',
          description:
            'Largura do adesivo em centímetros, tirada da MENSAGEM MAIS RECENTE do cliente. Se ele falou um tamanho antes e outro agora, vale o de agora — nunca reaproveite a medida de uma mensagem anterior da conversa.',
        },
        altura_cm: {
          type: 'number',
          description:
            'Altura do adesivo em centímetros, tirada da MENSAGEM MAIS RECENTE do cliente. Mesma regra da largura: o tamanho mais novo substitui qualquer um citado antes.',
        },
        quantidade: {
          type: 'number',
          description:
            'Quantos ADESIVOS o cliente quer (não folhas), também da mensagem mais recente dele.',
        },
        material: {
          type: 'string',
          description: 'Material escolhido pelo cliente, ex: "Vinil Adesivo Brilho". Deixe vazio se ele ainda não escolheu.',
        },
      },
      required: ['largura_cm', 'altura_cm', 'quantidade'],
    },
  },
  {
    name: 'calcular_cartela_tatuagem',
    description:
      'Calcula o preço exato de tatuagem temporária personalizada ("Cartela Tatuagem Temporária Personalizado"): esse produto é vendido POR CARTELA (uma folha com várias artes), mas o cliente costuma pedir por tatuagem individual (ex: "200 tatuagens de 3x3cm"). A ferramenta descobre quantas tatuagens cabem em uma cartela, quantas cartelas o pedido precisa, e o total — inclusive trocando pra cartela maior automaticamente se a arte não couber na padrão. Use SEMPRE que o cliente pedir tatuagem temporária por tamanho e quantidade — nunca faça essa conta de cabeça nem diga que não dá pra calcular.',
    input_schema: {
      type: 'object',
      properties: {
        largura_cm: {
          type: 'number',
          description: 'Largura de UMA tatuagem em centímetros, tirada da mensagem mais recente do cliente.',
        },
        altura_cm: {
          type: 'number',
          description: 'Altura de UMA tatuagem em centímetros, tirada da mensagem mais recente do cliente.',
        },
        quantidade: {
          type: 'number',
          description: 'Quantas TATUAGENS o cliente quer (não cartelas).',
        },
        tamanho_cartela: {
          type: 'string',
          description:
            'Tamanho de cartela que o cliente já escolheu, se escolheu (ex: "14x20cm", "20x28cm"). Deixe vazio se ele ainda não escolheu — a ferramenta calcula no tamanho padrão (sem acréscimo) e troca pro maior sozinha se precisar.',
        },
      },
      required: ['largura_cm', 'altura_cm', 'quantidade'],
    },
  },
  {
    name: 'oferecer_fechamento',
    description:
      'Envia, logo depois da sua mensagem, os botões "✅ Fechar pedido / 🔁 Outro produto / 💬 Falar com equipe". Use SOMENTE quando o orçamento já estiver completo, com valor fechado, e não faltar nenhuma informação sua pra montar o pedido. O teste é o que você ainda PRECISA saber: se a sua mensagem faz uma pergunta de verdade — qual material, qual tamanho, tem arte pronta — NÃO chame, espere a resposta, senão os botões atropelam a pergunta. Um convite de confirmação no fim do orçamento ("fecho assim ou quer ajustar algo?") não conta como pergunta pendente: aí pode chamar, é exatamente pra esse momento.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'salvar_nota_cliente',
    description:
      'Guarda UMA frase curta sobre este cliente para os próximos atendimentos (ex: "prefere retirar no escritório", "sempre pede cartão Premium", "tem uma loja de roupas, pede adesivo de vitrine"). Use raramente, só quando aprender algo que realmente ajuda a atender melhor da próxima vez — não é resumo da conversa. NUNCA guarde dado sensível (saúde, documento, pagamento, endereço completo, reclamação) nem nada que o cliente não disse abertamente sobre o próprio negócio ou preferência de compra. Não avise o cliente que você guardou a nota — isso é interno.',
    input_schema: {
      type: 'object',
      properties: {
        nota: {
          type: 'string',
          description: 'Frase curta e factual (até ~200 caracteres) sobre preferência ou padrão de compra deste cliente.',
        },
      },
      required: ['nota'],
    },
  },
]

// Built per request rather than once at startup: the catalog is reloaded from
// the API every few hours and its category list changes with it. Frozen at
// boot, this block would keep describing the static snapshot's categories while
// the search tool answered from the live one. Rebuilding identical text still
// hits the prompt cache — it only misses when the catalog genuinely changed,
// which is exactly when it should.
function buildSystem(): Anthropic.Messages.TextBlockParam[] {
  // Where today's prices come from. The instructions say prices are current and
  // need no caveat — true while the live API is loaded, and false the moment it
  // isn't, since the static snapshot is months behind. Without this line the
  // assistant would state stale prices with full confidence in exactly the
  // situation where it should hedge.
  // Age-based, not just "did it ever load". This used to be set once on the
  // first success and never cleared, so after one good load at boot the
  // assistant kept telling customers the prices were current even if every
  // refresh since had failed for days.
  const catalogoFresco = catalogLoadedAt > 0 && Date.now() - catalogLoadedAt < 2 * CATALOG_REFRESH_MS
  const freshness = catalogoFresco
    ? 'Os preços que a busca devolve vieram do sistema da Quick Gráfica e estão atualizados. Pode usá-los com confiança.'
    : 'ATENÇÃO: a consulta ao sistema da Quick Gráfica falhou ou está desatualizada, e você pode estar com uma cópia antiga do catálogo. Os preços podem estar defasados — dê o valor como referência e diga que a equipe confirma o valor atual antes de fechar.'

  return [
    {
      type: 'text',
      text: AI_INSTRUCTIONS,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
    {
      type: 'text',
      text: `Categorias e subcategorias disponíveis no catálogo:\n${CATALOG_OVERVIEW}\n\n${freshness}`,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
}

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
  // Strictly increasing write order. Timestamps cannot do this job: two messages
  // in one webhook batch routinely land on the same millisecond, and a reply is
  // logged after the next message was already stamped — both of which made
  // buildHistory silently drop turns. Absent on entries written before this
  // field existed, which sort as oldest and is correct for them.
  seq?: number
}

const DATA_DIR = process.env.DATA_DIR ?? '.'
const LOG_FILE = `${DATA_DIR}/conversas.json`
const LOG_TMP = `${LOG_FILE}.tmp`
const MAX_LOG = 2000

// Without this, a DATA_DIR pointing at a volume path that doesn't exist yet
// makes every write fail with ENOENT and persistence is silently off forever.
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch (err) {
  console.error(`log: não consegui criar ${DATA_DIR}:`, err)
}

let log: LogEntry[] = []
try {
  const parsed: unknown = JSON.parse(readFileSync(LOG_FILE, 'utf8'))
  // Shape check: a file that parsed to a non-array used to be assigned anyway,
  // and the first log.push threw TypeError inside the webhook handler — which
  // still answered 200, so Meta never retried and the message was simply lost.
  if (Array.isArray(parsed)) {
    // Validate every field buildHistory actually consumes, not just the ones
    // the dashboard shows. An entry missing `text` produced a message with no
    // content at all, and one missing `direction` was silently attributed to
    // the bot — both make the Anthropic call 400 for that customer on every
    // message until the entry ages out of the window.
    log = parsed.filter(
      (e): e is LogEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as LogEntry).chatId === 'string' &&
        typeof (e as LogEntry).timestamp === 'number' &&
        typeof (e as LogEntry).text === 'string' &&
        ((e as LogEntry).direction === 'in' || (e as LogEntry).direction === 'out'),
    )
    if (log.length !== parsed.length) {
      console.error(`log: ${parsed.length - log.length} entradas inválidas descartadas de conversas.json`)
    }
  } else {
    console.error('log: conversas.json não é uma lista — começando vazio')
  }
} catch (err) {
  // A missing file on first boot is normal; anything else means history was
  // lost, and that must not pass unnoticed — buildHistory reads this, so every
  // in-flight conversation loses its context.
  if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
    console.error('log: conversas.json ilegível, começando vazio:', err)
  }
}

// Resumes above whatever the persisted file already used, so sequence numbers
// stay strictly increasing across restarts.
let logSeq = log.reduce((max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max), 0)

// Returns the entry's sequence number, which callers pass to buildHistory as
// "everything written before this message".
function logMessage(entry: LogEntry): number {
  entry.seq = ++logSeq
  log.push(entry)
  if (log.length > MAX_LOG) {
    log = log.slice(log.length - MAX_LOG)
  }
  try {
    // Write to a temp file and rename. writeFileSync truncates before writing,
    // so a SIGTERM mid-write (Railway sends one on every redeploy) used to
    // leave a truncated file — which then failed to parse on the next boot and
    // wiped the entire history. rename is atomic on the same filesystem.
    writeFileSync(LOG_TMP, JSON.stringify(log))
    renameSync(LOG_TMP, LOG_FILE)
  } catch (err) {
    console.error('log: failed to persist conversas.json:', err)
  }
  return entry.seq
}

// --- Customer memory (persisted, so a returning customer gets recognised) ---
//
// Small per-phone-number record: how many times they've talked to us, and a
// short list of notes the assistant chose to keep (a preference, a recurring
// order, something worth remembering for a warmer, more useful chat next
// time). This is deliberately thin — it is NOT a CRM and never stores
// anything sensitive; see the `salvar_nota_cliente` tool description and
// instrucoes.md for what belongs here.

interface ClienteInfo {
  nome?: string
  primeiraInteracao: number
  ultimaInteracao: number
  totalConversas: number
  notas: string[]
  // Click-to-WhatsApp click ID from ad referral — used for CAPI attribution.
  ctwaClid?: string
}

const CLIENTES_FILE = `${DATA_DIR}/clientes.json`
const CLIENTES_TMP = `${CLIENTES_FILE}.tmp`
const MAX_NOTAS_POR_CLIENTE = 12
// A gap longer than this counts as a new conversation for the "já falamos N
// vezes" counter — it's just a courtesy number for tone, nothing depends on
// it being exact.
const NOVA_CONVERSA_GAP_MS = 6 * 60 * 60 * 1000

let clientes: Record<string, ClienteInfo> = {}
try {
  const parsed: unknown = JSON.parse(readFileSync(CLIENTES_FILE, 'utf8'))
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [chatId, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = (v ?? {}) as Partial<ClienteInfo>
      if (typeof c.primeiraInteracao === 'number' && typeof c.ultimaInteracao === 'number') {
        clientes[chatId] = {
          nome: typeof c.nome === 'string' ? c.nome : undefined,
          primeiraInteracao: c.primeiraInteracao,
          ultimaInteracao: c.ultimaInteracao,
          totalConversas: typeof c.totalConversas === 'number' ? c.totalConversas : 1,
          notas: Array.isArray(c.notas)
            ? c.notas.filter((n): n is string => typeof n === 'string').slice(-MAX_NOTAS_POR_CLIENTE)
            : [],
          ctwaClid: typeof (c as Record<string, unknown>).ctwaClid === 'string' ? (c as Record<string, unknown>).ctwaClid as string : undefined,
        }
      }
    }
  } else {
    console.error('clientes: clientes.json não é um objeto — começando vazio')
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
    console.error('clientes: clientes.json ilegível, começando vazio:', err)
  }
}

function saveClientes(): void {
  try {
    writeFileSync(CLIENTES_TMP, JSON.stringify(clientes))
    renameSync(CLIENTES_TMP, CLIENTES_FILE)
  } catch (err) {
    console.error('clientes: failed to persist clientes.json:', err)
  }
}

// Called once per inbound message. Never overwrites a name with an empty one,
// and never lets a WhatsApp profile nickname clobber something already saved.
function tocarCliente(chatId: string, pushName?: string, ctwaClid?: string): ClienteInfo {
  const now = Date.now()
  const existing = clientes[chatId]
  if (!existing) {
    const novo: ClienteInfo = {
      nome: pushName || undefined,
      primeiraInteracao: now,
      ultimaInteracao: now,
      totalConversas: 1,
      notas: [],
      ctwaClid: ctwaClid || undefined,
    }
    clientes[chatId] = novo
    saveClientes()
    // Fire LeadSubmitted to Meta CAPI — a brand-new contact reached out.
    sendCapiEvent('LeadSubmitted', { phone: chatId, ctwaClid: ctwaClid })
    return novo
  }
  // Update ctwa_clid if this conversation came from a new ad click.
  if (ctwaClid && !existing.ctwaClid) {
    existing.ctwaClid = ctwaClid
  }
  if (now - existing.ultimaInteracao > NOVA_CONVERSA_GAP_MS) existing.totalConversas += 1
  existing.ultimaInteracao = now
  if (pushName && !existing.nome) existing.nome = pushName
  saveClientes()
  return existing
}

// Backing the `salvar_nota_cliente` tool. Capped in length and count so one
// odd note (or a model that gets chatty) can't grow this file unbounded.
function salvarNotaCliente(chatId: string, nota: string): string {
  const texto = nota.trim().slice(0, 200)
  if (!texto) return 'Nota vazia — nada foi salvo.'
  const info = clientes[chatId] ?? tocarCliente(chatId)
  info.notas.push(texto)
  if (info.notas.length > MAX_NOTAS_POR_CLIENTE) info.notas = info.notas.slice(-MAX_NOTAS_POR_CLIENTE)
  saveClientes()
  return 'Nota salva.'
}

// Rendered straight into the system prompt (see handleWithAI) so the assistant
// can personalise without an extra tool round trip. Returns undefined for a
// first-time chat — there's nothing to say yet, and saying "first time here!"
// out loud would be stranger than saying nothing.
function clienteContext(chatId: string): string | undefined {
  const info = clientes[chatId]
  if (!info || info.totalConversas <= 1) return undefined
  const partes = [`Cliente já falou com a Quick Gráfica antes (${info.totalConversas}x ao todo).`]
  if (info.notas.length) {
    partes.push(`Notas guardadas de atendimentos anteriores: ${info.notas.join(' | ')}`)
  }
  return partes.join(' ')
}

// --- Token usage (so "why is this costing so much" has real numbers to answer
// it, instead of guesswork) ---
//
// The app never logged a single token count before this — the only place to
// see cost was Anthropic's own console, with no way to tie a spike back to a
// specific conversation or day. This keeps a running per-day total of what
// every `messages.create` call actually reported, cheap enough to write on
// every response.

interface UsoDia {
  turnos: number
  chamadas: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

const USO_FILE = `${DATA_DIR}/uso.json`
const USO_TMP = `${USO_FILE}.tmp`
const MAX_DIAS_USO = 90

let uso: Record<string, UsoDia> = {}
try {
  const parsed: unknown = JSON.parse(readFileSync(USO_FILE, 'utf8'))
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    uso = parsed as Record<string, UsoDia>
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
    console.error('uso: uso.json ilegível, começando vazio:', err)
  }
}

function saveUso(): void {
  try {
    // Keep only the most recent days — a print shop doesn't need per-day
    // history going back forever, and an unbounded file is exactly the kind
    // of slow leak that's hard to notice until DATA_DIR fills up.
    const dias = Object.keys(uso).sort()
    if (dias.length > MAX_DIAS_USO) {
      for (const d of dias.slice(0, dias.length - MAX_DIAS_USO)) delete uso[d]
    }
    writeFileSync(USO_TMP, JSON.stringify(uso))
    renameSync(USO_TMP, USO_FILE)
  } catch (err) {
    console.error('uso: failed to persist uso.json:', err)
  }
}

// Called once per `messages.create` response. Logs to stdout (so it shows up
// in Railway logs immediately, searchable by chatId) and accumulates into the
// daily total. `cacheReadTokens` high relative to `inputTokens` is the sign
// prompt caching is doing its job. `round` is 0 for the first API call of a
// customer message and counts up from there if the model needs more tool
// rounds — `chamadas / turnos` in the daily total is the average number of
// rounds per customer message, the thing that multiplies every other number
// here when it climbs (see MAX_TOOL_ROUNDS).
function registrarUso(chatId: string, round: number, usage: Anthropic.Messages.Usage | undefined): void {
  if (!usage) return
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  console.log(
    `uso: chatId=${chatId} rodada=${round + 1} input=${inputTokens} output=${outputTokens} ` +
      `cache_write=${cacheWriteTokens} cache_read=${cacheReadTokens}`,
  )
  const dia = new Date().toISOString().slice(0, 10)
  const atual = uso[dia] ?? {
    turnos: 0,
    chamadas: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  }
  if (round === 0) atual.turnos += 1
  atual.chamadas += 1
  atual.inputTokens += inputTokens
  atual.outputTokens += outputTokens
  atual.cacheWriteTokens += cacheWriteTokens
  atual.cacheReadTokens += cacheReadTokens
  uso[dia] = atual
  saveUso()
}

// --- Conversation review (which chats deserve a human's attention) ---
//
// Problems were being found by scrolling screenshots one conversation at a time.
// These flags surface the chats worth reading: where Sophia escalated, where the
// customer corrected her, where they had to repeat themselves, where she said
// the product doesn't exist, or where a reply took so long the customer gave up.
// Each flag points at a knowledge gap or a bug — which is the list that makes
// the assistant better week over week.

interface ReviewFlag {
  code: string
  label: string
  detail?: string
}

interface ReviewItem {
  chatId: string
  name: string
  lastAt: number
  messages: number
  flags: ReviewFlag[]
}

// A reply this slow means the customer sat waiting — the app asleep, the API
// stalling, or an error swallowed somewhere. It is how the sleeping-container
// bug showed up in real conversations.
const SLOW_REPLY_MS = 3 * 60 * 1000
// A quote nobody answered for this long counts as a conversation that died.
const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000

const RE_CORRECTION = /nao e isso|nao eh isso|esta errado|ta errado|nao tem |nao existe|na verdade|nao foi isso|nao seria|voce errou|errou o|nao e bem/
const RE_ESCALATED = /confirmar com a equipe|confirmo com a equipe|equipe vai confirmar|vou confirmar com|passar pra equipe|passo pra equipe|falar com a equipe|equipe confirma/
const RE_NOT_FOUND = /nao temos|nao trabalhamos|nao encontrei|nao consegui localizar|nao faz parte do nosso|nao esta no catalogo/
const RE_HUMAN_BUTTON = /falar com equipe/

function reviewConversations(entries: LogEntry[]): ReviewItem[] {
  const byChat = new Map<string, LogEntry[]>()
  for (const e of entries) {
    if (!byChat.has(e.chatId)) byChat.set(e.chatId, [])
    byChat.get(e.chatId)!.push(e)
  }

  const items: ReviewItem[] = []
  const now = Date.now()

  for (const [chatId, msgs] of byChat) {
    msgs.sort((a, b) => a.timestamp - b.timestamp)
    const flags: ReviewFlag[] = []
    const add = (code: string, label: string, detail?: string) => {
      if (!flags.some((f) => f.code === code)) flags.push({ code, label, detail })
    }

    let lastInboundText = ''
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      const text = normalize(m.text ?? '')

      if (m.direction === 'in') {
        if (RE_HUMAN_BUTTON.test(text)) {
          add('humano', 'Cliente pediu atendimento humano')
        } else if (RE_CORRECTION.test(text)) {
          add('correcao', 'Cliente corrigiu a Sophia', m.text)
        }
        // "?" alone, or the same message sent twice, means the previous answer
        // didn't land.
        const bare = text.replace(/[^a-z0-9]/g, '')
        if (!bare && /\?/.test(text)) add('repeticao', 'Cliente mandou só "?" — não foi entendido')
        else if (bare && bare === lastInboundText) add('repeticao', 'Cliente repetiu a mesma mensagem', m.text)
        if (bare) lastInboundText = bare

        // How long the customer waited for the next reply.
        const reply = msgs.slice(i + 1).find((x) => x.direction === 'out')
        if (reply && reply.timestamp - m.timestamp > SLOW_REPLY_MS) {
          const mins = Math.round((reply.timestamp - m.timestamp) / 60000)
          add('demora', `Resposta demorou ${mins} min`)
        }
      } else {
        if (RE_ESCALATED.test(text)) add('escalou', 'Sophia mandou confirmar com a equipe')
        if (RE_NOT_FOUND.test(text)) add('sem_produto', 'Sophia disse que não tem o produto', m.text)
      }
    }

    // Quoted a price and the customer never came back.
    const last = msgs[msgs.length - 1]
    if (
      last.direction === 'out' &&
      /r\$\s?\d/.test(normalize(last.text ?? '')) &&
      now - last.timestamp > ABANDONED_AFTER_MS
    ) {
      add('sem_retorno', 'Orçamento enviado e o cliente não respondeu')
    }

    if (flags.length) {
      items.push({
        chatId,
        name: msgs.find((m) => m.pushName)?.pushName ?? chatId,
        lastAt: last.timestamp,
        messages: msgs.length,
        flags,
      })
    }
  }

  return items.sort((a, b) => b.lastAt - a.lastAt)
}

// --- Signature validation ---

function verifySignature(rawBody: string, header: string | undefined): boolean {
  try {
    if (!header) return false
    // Anchored: an unanchored replace would strip the marker from anywhere in
    // the string, so "<hex>sha256=<hex>" was accepted as if it were clean.
    const sig = header.trim().replace(/^sha256=/i, '')
    // Only lowercase hex of the exact SHA-256 length is a candidate. This guard
    // matters: Buffer.from(sig) on a multi-byte character would produce a buffer
    // whose byte length differs from its string length, and timingSafeEqual
    // throws RangeError on mismatched buffers -> 500 -> Meta retries forever.
    if (!/^[0-9a-f]{64}$/.test(sig.toLowerCase())) return false
    const expected = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')
    const a = Buffer.from(sig.toLowerCase(), 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch (err) {
    console.error('webhook: signature check failed:', err)
    return false
  }
}

// --- WhatsApp API helper ---

const WA_TIMEOUT_MS = 25_000

// sendText returns status 0 when it refuses to send empty text, and constructing
// a Response with a status outside 200-599 throws RangeError — which surfaced to
// the caller as an opaque 500 instead of the real reason.
function httpStatus(status: number): ContentfulStatusCode {
  // 0 is sendText's "I refused to send that" — a caller error, not an upstream
  // failure, so it must not look like "WhatsApp is down".
  if (status === 0) return 400 as ContentfulStatusCode
  return (Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502) as ContentfulStatusCode
}

// Required once "Require App Secret" is enabled in the Meta App Dashboard
// (Settings > Advanced > Security) — without it, every Graph API call made
// with an access token gets rejected once that toggle is on.
function appsecretProof(token: string): string {
  return createHmac('sha256', APP_SECRET).update(token).digest('hex')
}

async function waApi(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  // Every outbound message goes through here. A throw used to propagate all the
  // way out: `handleWithAI` would catch it, try to apologise through this same
  // function, throw again, and the customer would get nothing. Failures are
  // returned as values instead, so callers can fall back.
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${WA_API}${path}${sep}appsecret_proof=${appsecretProof(ACCESS_TOKEN)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
      // Without a timeout a stalled Graph API connection holds the webhook
      // response open for minutes (undici's default is 300s) and blocks the
      // whole chat queue behind it.
      signal: AbortSignal.timeout(WA_TIMEOUT_MS),
    })
    // A 502 from an edge proxy, a Cloudflare interstitial or an empty body are
    // all non-JSON, and res.json() throws SyntaxError on each.
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { error: 'resposta não-JSON da API do WhatsApp', body: text.slice(0, 300) }
    }
    if (!res.ok) console.error(`waApi ${path}: HTTP ${res.status}`, JSON.stringify(data).slice(0, 500))
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    console.error(`waApi ${path}: falha de rede:`, err)
    return { ok: false, status: 503, data: { error: String(err) } }
  }
}

// --- Outbound send helper (shared by /send and the AI auto-reply) ---

// WhatsApp hard-rejects a text message over 4096 characters and rejects an
// empty one. Either way the customer would receive absolutely nothing, which
// reads exactly like "the bot stopped answering". So split long replies into
// chunks on paragraph -> line -> sentence -> hard-cut boundaries, in order.
const WA_TEXT_LIMIT = 4000

function splitForWhatsApp(text: string, limit = WA_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n')
    if (cut < limit * 0.5) cut = window.lastIndexOf('. ')
    if (cut > 0 && window[cut] === '.') cut += 1
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = limit
    // Only the hard cut above can land in the middle of a surrogate pair, which
    // would split an emoji into two broken halves. Step back one unit if it did.
    if (cut > 0 && cut < rest.length) {
      const prev = rest.charCodeAt(cut - 1)
      if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1
    }
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.filter((c) => c.length > 0)
}

async function sendText(
  to: string,
  text: string,
  replyTo?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const clean = typeof text === 'string' ? text.trim() : ''
  if (!clean) {
    console.error(`sendText: refusing to send empty text to ${to}`)
    return { ok: false, status: 0, data: { error: 'empty text' } }
  }

  const parts = splitForWhatsApp(clean)
  let last: { ok: boolean; status: number; data: unknown } = { ok: false, status: 0, data: null }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: part },
    }
    // Only the first chunk quotes the customer's message.
    if (replyTo && i === 0) body.context = { message_id: replyTo }

    last = await waApi('/messages', body)
    if (last.ok) {
      const wamid = (last.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
      logMessage({ direction: 'out', chatId: to, text: part, timestamp: Date.now(), wamid })
    } else {
      console.error(`sendText: WhatsApp rejected part ${i + 1}/${parts.length} to ${to}:`, JSON.stringify(last.data))
      break
    }
  }
  return last
}

// WhatsApp rejects an interactive message whose body exceeds 1024 characters,
// and rejects a button/list whose visible titles are not unique. Both produce a
// total silence for the customer, so both are normalised here rather than
// trusted to whatever the model wrote.
function clampBody(text: string): string {
  const clean = (typeof text === 'string' ? text : '').trim()
  if (!clean) return 'Escolha uma opção:'
  return clean.length <= 1024 ? clean : `${clean.slice(0, 1021)}...`
}

// Truncating to the WhatsApp title limit can collapse two distinct options into
// the same string ("Cartão 4x0 frente" / "Cartão 4x0 verso" -> "Cartão 4x0 ").
// Duplicated titles make WhatsApp reject the whole message, so disambiguate
// them with a numeric suffix that still fits inside the limit.
function uniqueTitles(titles: string[], limit: number): string[] {
  const seen = new Set<string>()
  return titles.map((raw) => {
    const base = (typeof raw === 'string' && raw.trim() ? raw.trim() : 'Opção').slice(0, limit)
    if (!seen.has(base)) {
      seen.add(base)
      return base
    }
    for (let n = 2; n < 100; n++) {
      const suffix = ` ${n}`
      const candidate = `${base.slice(0, limit - suffix.length).trimEnd()}${suffix}`
      if (!seen.has(candidate)) {
        seen.add(candidate)
        return candidate
      }
    }
    return base
  })
}

// Sends up to 3 quick-reply buttons attached to a message.
async function sendButtons(
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
  replyTo?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const titles = uniqueTitles(buttons.slice(0, 3).map((b) => b.title), 20)
  const waButtons = buttons
    .slice(0, 3)
    .map((b, i) => ({ type: 'reply' as const, reply: { id: b.id, title: titles[i] } }))

  if (waButtons.length === 0) {
    console.error(`sendButtons: no buttons to send to ${to}`)
    return { ok: false, status: 0, data: { error: 'no buttons' } }
  }

  const msgBody: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clampBody(body) },
      action: { buttons: waButtons },
    },
  }
  if (replyTo) msgBody.context = { message_id: replyTo }

  const result = await waApi('/messages', msgBody)
  if (result.ok) {
    const wamid = (result.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
    const summary = `${body}\n${waButtons.map((b) => `[${b.reply.title}]`).join(' ')}`
    logMessage({ direction: 'out', chatId: to, text: summary, timestamp: Date.now(), wamid })
  }
  return result
}

interface ListRow {
  id: string
  title: string
  description?: string
}
interface ListSection {
  title: string
  rows: ListRow[]
}

// Sends a WhatsApp list message (tap the button to open up to 10 rows total).
async function sendList(
  to: string,
  opts: { header?: string; body: string; footer?: string; buttonText: string; sections: ListSection[] },
  replyTo?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const msgBody: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(opts.header ? { header: { type: 'text', text: opts.header.slice(0, 60) } } : {}),
      body: { text: clampBody(opts.body) },
      ...(opts.footer ? { footer: { text: opts.footer.slice(0, 60) } } : {}),
      action: {
        button: opts.buttonText.slice(0, 20),
        sections: opts.sections.map((s) => {
          const rowTitles = uniqueTitles(s.rows.map((r) => r.title), 24)
          return {
            title: s.title.slice(0, 24),
            rows: s.rows.map((r, i) => ({
              id: r.id,
              title: rowTitles[i],
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          }
        }),
      },
    },
  }
  if (replyTo) msgBody.context = { message_id: replyTo }

  const result = await waApi('/messages', msgBody)
  if (result.ok) {
    const wamid = (result.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
    const summary = `${opts.body}\n${opts.sections.flatMap((s) => s.rows.map((r) => `• ${r.title}`)).join('\n')}`
    logMessage({ direction: 'out', chatId: to, text: summary, timestamp: Date.now(), wamid })
  }
  return result
}

// --- Order wizard (order-closing buttons + AI option taps) ---
//
// Category/subcategory/product browsing used to live here as a button-driven menu,
// but that meant customers picked from a flat list instead of the assistant actually
// figuring out what they need. It's gone — a customer typing "pedido"/"menu"/etc. now
// falls through to the normal AI flow like any other message, and `instrucoes.md`
// guides the AI through a short discovery conversation (finalidade → quantidade →
// tamanho → arte) before it searches the catalog and quotes. What's left here is just
// the order-closing buttons (`offersOrderButtons`) and resolving a tap on the AI's own
// `mostrar_opcoes` buttons/list back to text (`wiz|opt|`).

// Holds the last set of AI-generated options offered to each chat (see the
// `mostrar_opcoes` tool below), so a tap on one can be resolved back to its
// full text and fed into the AI flow as if the customer had typed it.
// Keyed by a per-question id, not just by chat. Button ids used to carry only a
// position ("wiz|opt|1"), and each new question overwrote the chat's option
// list — so a customer who scrolled up and tapped "20x30cm" on an EARLIER
// question got whatever now sat at index 1 of the CURRENT one ("Kraft"), and
// the bot quoted that instead, confidently and invisibly. The id now carries
// which question it belongs to, so a stale tap is recognised as stale.
const pendingOptions = new Map<string, string[]>()
// When each chat's pending options were stored, so they can be expired (see pruneChatState).
const pendingOptionsAt = new Map<string, number>()
// Which option set each chat is currently being asked about.
const pendingSetId = new Map<string, string>()
let optionSetSeq = 0

// Old buttons stay tappable forever in the WhatsApp history, and each tap
// arrives with a fresh id, so nothing upstream dedupes them. Without this, a
// customer re-tapping "Fechar pedido" starts the closing conversation again —
// and the assistant, seeing a closing request, can re-quote and re-offer the
// same buttons in a circle.
const recentlyClosed = new Map<string, number>()
const CLOSE_COOLDOWN_MS = 10 * 60 * 1000

async function handleWizardTap(chatId: string, id: string, replyTo?: string, pushName?: string): Promise<void> {
  try {
    if (id === 'wiz|outro') {
      await sendText(chatId, 'Claro! Me conta o que você precisa que eu já vejo pra você. 🙂', replyTo)
      return
    }
    // Asking for a human and being told "tell me, I'll help you here" is the
    // one answer this button must never give. It says the request reached a
    // person, and flags the conversation so the team finds it in /dashboard.
    if (id === 'wiz|human') {
      await sendText(
        chatId,
        'Claro! Já avisei a equipe e alguém te responde por aqui mesmo. Se quiser adiantar, pode deixar sua dúvida escrita que eles já leem junto. 🙂',
        replyTo,
      )
      logMessage({
        direction: 'in',
        chatId,
        text: '🙋 Cliente pediu para falar com a equipe',
        timestamp: Date.now(),
      })
      return
    }

    // Closing used to end here with a canned line, which meant the delivery
    // question — and the four real pickup/shipping options — never got asked,
    // and the assistant never saw that the order closed. Now the tap goes
    // through the assistant like any other message, so it can finish the
    // conversation properly.
    if (id === 'wiz|close') {
      const ts = Date.now()
      const last = recentlyClosed.get(chatId)
      if (last && ts - last < CLOSE_COOLDOWN_MS) {
        await sendText(chatId, 'Esse pedido já está registrado com a equipe. 👍 Precisa de mais alguma coisa?', replyTo)
        return
      }
      recentlyClosed.set(chatId, ts)
      // Fire Purchase event to Meta CAPI — the customer confirmed the order.
      const cliente = clientes[chatId]
      sendCapiEvent('Purchase', {
        phone: chatId,
        ctwaClid: cliente?.ctwaClid,
        // Value is not known at this point (the AI hasn't finished the closing
        // conversation yet), but Meta still benefits from the conversion signal.
      })
      const seq = logMessage({ direction: 'in', chatId, text: '⭐ Cliente tocou em "Fechar pedido"', timestamp: ts })
      await handleWithAI(
        chatId,
        replyTo ?? '',
        '[o cliente tocou no botão "✅ Fechar pedido"] Quero fechar esse pedido.',
        seq,
        pushName,
      )
      return
    }
    if (id.startsWith('wiz|opt|')) {
      // Customer tapped one of the AI's own buttons/list (from `mostrar_opcoes`).
      // Resolve it back to full text and continue the AI flow as if they'd typed it —
      // this is what lets the AI ask one question at a time (tamanho → papel → ...).
      // Format: wiz|opt|<setId>|<index>. The old format (wiz|opt|<index>) is
      // still accepted so buttons already in customers' histories keep working,
      // but only against the current option set.
      const parts = id.split('|')
      const setId = parts.length >= 4 ? parts[2] : ''
      const raw = parts[parts.length - 1]
      // Number('') is 0 and Number('0x1') is 1, so a malformed id like "wiz|opt|"
      // would silently select the first option.
      const i = /^\d+$/.test(raw) ? Number(raw) : -1
      const stored = pendingOptions.get(chatId)
      const currentSet = pendingSetId.get(chatId) ?? ''
      // Fails CLOSED: anything that isn't provably the current question is
      // treated as stale. An id with no set marker is from a build before those
      // existed, so it cannot be matched against anything — and resolving it
      // positionally is exactly the bug this replaced, where a tap on an old
      // question silently picked whatever now sits at that index.
      const stale = setId === '' || currentSet === '' || setId !== currentSet
      const value = stale || i < 0 ? undefined : stored?.[i]
      if (!value) {
        await sendText(
          chatId,
          stale
            ? 'Essa era a resposta de uma pergunta anterior. 🙂 Pode me dizer com suas palavras o que você prefere?'
            : 'Essa opção já expirou — pode me dizer de novo o que você precisa? 🙂',
          replyTo,
        )
        return
      }
      pendingOptions.delete(chatId)
      pendingOptionsAt.delete(chatId)
      pendingSetId.delete(chatId)
      const ts = Date.now()
      const seq = logMessage({ direction: 'in', chatId, text: value, timestamp: ts })
      await handleWithAI(chatId, replyTo ?? '', value, seq, pushName)
      return
    }

    // An id this build doesn't know — almost always a button from an older
    // version still sitting in the customer's WhatsApp history (the
    // category-browsing menu that used to live here). It matched the `wiz|`
    // prefix upstream, so it never reaches the AI, and without this it produced
    // total silence: the customer taps and nothing whatsoever happens.
    console.error(`wizard: id desconhecido "${id}" — respondendo com fallback`)
    await sendText(
      chatId,
      'Esse botão é de uma conversa antiga e não vale mais. 🙂 Me conta o que você precisa que eu vejo pra você agora.',
      replyTo,
    )
  } catch (err) {
    console.error('wizard: handling failed:', err)
    // Even a thrown error must not end in silence.
    await sendText(chatId, 'Tive um probleminha aqui. 😕 Pode me dizer o que você precisa?', replyTo).catch(() => {})
  }
}

// After the AI quotes a price (its reply mentions "R$"), offer follow-up buttons so
// the customer can close, ask about something else, or ask for a human.
// The body text rotates. It used to be one hardcoded line sent identically
// every time, immediately after the assistant's own closing question — so the
// customer read two confirmation questions back to back, the second one always
// word for word the same, which is the robotic tell the instructions spend a
// whole section trying to avoid.
const CLOSE_PROMPTS = [
  'Posso seguir com esse pedido?',
  'Quer que eu siga com esse?',
  'Fechamos assim?',
  'Seguimos com esse pedido?',
]
let closePromptIdx = 0

function offersOrderButtons(chatId: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const body = CLOSE_PROMPTS[closePromptIdx++ % CLOSE_PROMPTS.length]
  return sendButtons(chatId, body, [
    { id: 'wiz|close', title: '✅ Fechar pedido' },
    { id: 'wiz|outro', title: '🔁 Outro produto' },
    { id: 'wiz|human', title: '💬 Falar com equipe' },
  ])
}

// Executes the AI's `mostrar_opcoes` tool call: sends the question as buttons (≤3
// options) or a list (4-10), and remembers the full "valor" text behind each one so
// a tap can be resolved back to it (see the `wiz|opt|` branch in handleWizardTap).
async function sendAiOptions(
  chatId: string,
  input: unknown,
  replyTo?: string,
): Promise<void> {
  const data = input as { pergunta?: unknown; opcoes?: unknown }
  const pergunta = typeof data.pergunta === 'string' && data.pergunta.trim()
    ? data.pergunta
    : 'Qual dessas opções você prefere?'
  const rawOpcoes = Array.isArray(data.opcoes) ? data.opcoes : []
  const opcoes = rawOpcoes
    .map((o) => {
      // The schema asks for objects, but a model can emit plain strings
      // (["10x15cm", "20x30cm"]). Those used to be filtered out entirely,
      // leaving zero options and a turn that sent the customer nothing at all.
      if (typeof o === 'string') {
        const t = o.trim()
        return t ? { titulo: t, descricao: undefined as string | undefined, valor: t } : null
      }
      if (typeof o !== 'object' || o === null) return null
      const obj = o as { titulo?: unknown; descricao?: unknown; valor?: unknown }
      const titulo = typeof obj.titulo === 'string' && obj.titulo.trim() ? obj.titulo.trim() : ''
      const valor = typeof obj.valor === 'string' && obj.valor.trim() ? obj.valor.trim() : titulo
      if (!titulo && !valor) return null
      return {
        titulo: titulo || valor,
        descricao: typeof obj.descricao === 'string' && obj.descricao.trim() ? obj.descricao.trim() : undefined,
        valor: valor || titulo,
      }
    })
    .filter((o): o is { titulo: string; descricao: string | undefined; valor: string } => o !== null)
    .slice(0, 10)

  // Asking a question with no options at all would end the turn in silence,
  // since the model is told to write nothing else after calling this tool.
  // Send the question as plain text so the conversation still moves.
  if (opcoes.length === 0) {
    console.error('sendAiOptions: mostrar_opcoes veio sem opções utilizáveis, enviando só a pergunta:', JSON.stringify(input)?.slice(0, 500))
    await sendText(chatId, pergunta, replyTo)
    return
  }

  // Identifies THIS question, so a tap on a previous one is detectable.
  // Base36 and short, because WhatsApp caps a button id at 256 characters.
  const setId = (++optionSetSeq).toString(36)
  pendingOptions.set(chatId, opcoes.map((o) => o.valor))
  pendingOptionsAt.set(chatId, Date.now())
  pendingSetId.set(chatId, setId)

  const result =
    opcoes.length <= 3
      ? await sendButtons(
          chatId,
          pergunta,
          opcoes.map((o, i) => ({ id: `wiz|opt|${setId}|${i}`, title: o.titulo })),
          replyTo,
        )
      : await sendList(
          chatId,
          {
            body: pergunta,
            buttonText: 'Ver opções',
            sections: [
              {
                title: 'Opções',
                rows: opcoes.map((o, i) => ({
                  id: `wiz|opt|${setId}|${i}`,
                  title: o.titulo,
                  description: o.descricao,
                })),
              },
            ],
          },
          replyTo,
        )

  // If WhatsApp refuses the interactive message for any reason, the customer
  // would otherwise receive nothing at all. Fall back to the same question as
  // plain text so the conversation always continues.
  if (!result.ok) {
    console.error('sendAiOptions: interactive message rejected, falling back to text:', JSON.stringify(result.data))
    pendingOptions.delete(chatId)
    pendingOptionsAt.delete(chatId)
    pendingSetId.delete(chatId)
    const lista = opcoes
      .map((o, i) => `${i + 1}. ${o.titulo}${o.descricao ? ` — ${o.descricao}` : ''}`)
      .join('\n')
    await sendText(chatId, `${pergunta}\n\n${lista}\n\nÉ só me dizer qual você prefere. 🙂`, replyTo)
  }
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

// These per-chat maps would otherwise keep one entry per customer for the whole
// life of the process. Each entry is small, but the relay is meant to run for
// months without a restart, so they are swept on every message instead.
const PENDING_OPTIONS_TTL_MS = 6 * 60 * 60 * 1000
const MAX_TRACKED_CHATS = 5000

function pruneChatState(): void {
  const now = Date.now()
  for (const [chat, ts] of recentlyClosed) {
    if (now - ts > CLOSE_COOLDOWN_MS) recentlyClosed.delete(chat)
  }
  for (const [chat, ts] of pendingOptionsAt) {
    if (now - ts > PENDING_OPTIONS_TTL_MS) {
      pendingOptionsAt.delete(chat)
      pendingOptions.delete(chat)
      pendingSetId.delete(chat)
    }
  }
  // Hard ceiling in case something keeps entries fresh forever: Map preserves
  // insertion order, so the oldest keys come out first.
  for (const map of [pendingOptions, pendingOptionsAt, pendingSetId, recentlyClosed] as Array<Map<string, unknown>>) {
    while (map.size > MAX_TRACKED_CHATS) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
  }
}

function enqueueForChat(chatId: string, task: () => Promise<void>): Promise<void> {
  pruneChatState()
  const prev = chatQueues.get(chatId) ?? Promise.resolve()
  const next: Promise<void> = prev
    .then(task)
    .catch((err) => console.error('ai: task failed:', err))
    .finally(() => {
      // Drop the entry once this chat's queue has drained, so the map only
      // ever holds conversations that are actively being handled.
      if (chatQueues.get(chatId) === next) chatQueues.delete(chatId)
    })
  chatQueues.set(chatId, next)
  return next
}

// --- Message bursts: wait a few seconds before answering, in case the customer
// is still typing ---
//
// People texting on a phone routinely split one thought across 2-4 messages
// sent seconds apart ("100 adesivos" / "redondo" / "6x6cm"). Answering the
// first one immediately means answering a fragment — the assistant asks for
// information that's already on its way, which reads as not paying attention
// and rushes the conversation instead of letting the customer finish. This
// holds each new message for a short quiet period; if nothing else arrives
// from the same chat before it elapses, everything buffered is sent to the
// assistant as a single turn. A hard cap keeps a very chatty customer from
// pushing the wait out indefinitely.
interface Burst {
  texts: string[]
  firstSeq: number
  lastWamid: string
  pushName?: string
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  finish: () => void
}
const bursts = new Map<string, Burst>()
const BURST_QUIET_MS = 5000
const BURST_MAX_MS = 20000

function fireBurst(chatId: string): void {
  const burst = bursts.get(chatId)
  if (!burst) return
  bursts.delete(chatId)
  const combined = burst.texts.join('\n')
  enqueueForChat(chatId, () => handleWithAI(chatId, burst.lastWamid, combined, burst.firstSeq, burst.pushName))
    .catch((err) => console.error('burst: handling failed:', err))
    .finally(burst.finish)
}

// Queues one raw incoming message for the debounced burst instead of calling
// handleWithAI directly. Returns a promise that resolves once the whole burst
// (this message and anything that lands right after it) has been answered —
// the webhook handler awaits it just like it awaited handleWithAI before.
function scheduleBurst(chatId: string, wamid: string, text: string, seq: number, pushName?: string): Promise<void> {
  const existing = bursts.get(chatId)
  if (existing) {
    existing.texts.push(text)
    existing.lastWamid = wamid
    if (pushName) existing.pushName = pushName
    clearTimeout(existing.timer)
    const elapsed = Date.now() - existing.startedAt
    const wait = Math.max(0, Math.min(BURST_QUIET_MS, BURST_MAX_MS - elapsed))
    existing.timer = setTimeout(() => fireBurst(chatId), wait)
    return new Promise((resolve) => {
      const prevFinish = existing.finish
      existing.finish = () => {
        prevFinish()
        resolve()
      }
    })
  }
  return new Promise((resolve) => {
    const burst: Burst = {
      texts: [text],
      firstSeq: seq,
      lastWamid: wamid,
      pushName,
      startedAt: Date.now(),
      timer: setTimeout(() => fireBurst(chatId), BURST_QUIET_MS),
      finish: resolve,
    }
    bursts.set(chatId, burst)
  })
}

// Avoids double-replying if Meta retries a webhook delivery (e.g. because our
// response took a while while the AI was thinking).
const processedForAI = new Set<string>()
const MAX_PROCESSED_FOR_AI = 5000

// `beforeSeq` is the sequence number of the message being answered: everything
// written before it is history, everything after is this turn. This used to
// compare timestamps, which broke in two ways — two messages arriving in the
// same millisecond made the second one blind to the first, and a reply logged
// after the next message was stamped dropped out of that message's history.
function buildHistory(chatId: string, beforeSeq: number): Anthropic.Messages.MessageParam[] {
  const entries = log.filter((e) => e.chatId === chatId && (e.seq ?? 0) < beforeSeq).slice(-HISTORY_LIMIT)
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

// Marks a cache breakpoint on the last content block of the last message,
// without mutating the array the tool-round loop keeps appending to.
//
// Before this, a hard turn (a search, then a sheet calculation, then a
// confirmation search — now reachable up to MAX_TOOL_ROUNDS=6 times) resent
// the entire growing message list from scratch, uncached, on every single
// round: round 1 pays for the history; round 2 pays for the history AGAIN
// plus round 1's tool call; round 3 pays for all of that again plus round
// 2's — full price, every round, on content that hadn't changed since the
// last call. That's quadratic cost on exactly the turns that already take
// the most rounds to answer. Calling this on `messages` right before each
// `messages.create` and passing its result instead of `messages` itself
// fixes that: each round's result only differs from the previous one by the
// two entries just pushed (the model's tool call and its result), so from
// round 2 onward everything before that is a cache hit instead of a full
// re-read. `messages` itself is left untouched so the loop's own bookkeeping
// (push per round) doesn't have to know this exists.
function withCacheBreakpoint(msgs: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
  if (msgs.length === 0) return msgs
  const last = msgs[msgs.length - 1]
  const content: Anthropic.Messages.ContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content]
  if (content.length === 0) return msgs
  const lastBlock = { ...content[content.length - 1], cache_control: { type: 'ephemeral' as const } }
  content[content.length - 1] = lastBlock as Anthropic.Messages.ContentBlockParam
  return [...msgs.slice(0, -1), { ...last, content }]
}

// Caps how many search-then-answer round trips a single reply can take —
// just a safety net against the model looping, not a normal-case limit. Raised
// from 4 after a real production case (customer disputed a sheet-fit
// calculation) hit the cap twice in one conversation: buscar_catalogo +
// calcular_folha_adesivo + a couple of confirmation searches genuinely needs
// more than 4 rounds sometimes, and hitting the cap means the customer gets
// the generic "me embolei" apology instead of an answer.
const MAX_TOOL_ROUNDS = 6

function textOf(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

// Runs a tool the model asked for and returns the text that goes back to it as
// the tool result. Only the tools that feed information back come through here —
// `mostrar_opcoes` and `oferecer_fechamento` end the turn instead.
function runAiTool(tu: Anthropic.Messages.ToolUseBlock, chatId: string): string {
  // A throw in here would abort the whole turn and give the customer the
  // generic "technical problem" line. Returning the error as a tool result
  // instead lets the model recover inside the same conversation.
  try {
    const input = (tu.input ?? {}) as Record<string, unknown>
    if (tu.name === 'calcular_folha_adesivo') {
      return quoteSheetStickers(
        Number(input.largura_cm),
        Number(input.altura_cm),
        Number(input.quantidade),
        typeof input.material === 'string' && input.material.trim() ? input.material : undefined,
      )
    }
    if (tu.name === 'calcular_cartela_tatuagem') {
      return quoteTattooCartela(
        Number(input.largura_cm),
        Number(input.altura_cm),
        Number(input.quantidade),
        typeof input.tamanho_cartela === 'string' && input.tamanho_cartela.trim() ? input.tamanho_cartela : undefined,
      )
    }
    if (tu.name === 'buscar_catalogo') {
      return searchCatalog(typeof input.termo === 'string' ? input.termo : '')
    }
    if (tu.name === 'salvar_nota_cliente') {
      return salvarNotaCliente(chatId, typeof input.nota === 'string' ? input.nota : '')
    }
    // Unknown tool name: say so plainly rather than silently running a search
    // with an empty term, which returns noise the model then quotes.
    console.error(`runAiTool: ferramenta desconhecida "${tu.name}"`)
    return `Ferramenta "${tu.name}" não existe. Use buscar_catalogo para consultar produtos e preços.`
  } catch (err) {
    console.error(`runAiTool: ${tu.name} falhou:`, err)
    return 'A consulta falhou por um erro interno. Não invente preço nem características: peça desculpas ao cliente e diga que a equipe confirma essa informação.'
  }
}

async function handleWithAI(
  chatId: string,
  wamid: string,
  userText: string,
  seq: number,
  pushName?: string,
): Promise<void> {
  try {
    const messages: Anthropic.Messages.MessageParam[] = [
      ...buildHistory(chatId, seq),
      { role: 'user', content: userText || '(mensagem vazia)' },
    ]

    // Adds the WhatsApp profile name (when we have one) as its own, uncached
    // system block — placed after the cached instructions/catalog blocks so it
    // varies per customer without invalidating that cache. Lets the assistant
    // greet by name without having to ask for it on every conversation.
    const base = buildSystem()
    const extras: Anthropic.Messages.TextBlockParam[] = []
    if (pushName) {
      extras.push({
        type: 'text',
        text: `Nome do cliente (perfil do WhatsApp, pode não ser o nome que ele usa pra se apresentar): ${pushName}`,
      })
    }
    const memoria = clienteContext(chatId)
    if (memoria) extras.push({ type: 'text', text: memoria })
    const system = extras.length ? [...base, ...extras] : base

    let replyText = ''

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 2048,
        system,
        tools: AI_TOOLS,
        messages: withCacheBreakpoint(messages),
      })
      registrarUso(chatId, round, response.usage)

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
        replyText = textOf(response.content)
        break
      }

      // `mostrar_opcoes` sends its own WhatsApp message (buttons/list) and ends the
      // turn — the customer needs to tap before we continue, so stop here instead
      // of looping back to the model.
      const showOptions = toolUses.find((tu) => tu.name === 'mostrar_opcoes')
      if (showOptions) {
        // Any text written alongside the options used to be thrown away, which
        // silently deleted exactly the consultative part — the "for your case
        // I'd go with X, because..." that makes the choice easier. Send it
        // first, then the options.
        const intro = textOf(response.content)
        if (intro) {
          const sent = await sendText(chatId, intro, wamid)
          if (!sent.ok) console.error('ai: send failed:', sent.data)
        }
        await sendAiOptions(chatId, showOptions.input, wamid)
        return
      }

      // `oferecer_fechamento` is the model saying "the quote is done and I'm not
      // waiting on an answer" — send whatever text came with it, then the close
      // buttons. This replaced an automatic "reply mentions R$" trigger, which
      // fired even when the reply ended in a question and talked over it.
      const offerClose = toolUses.find((tu) => tu.name === 'oferecer_fechamento')
      if (offerClose) {
        const text = textOf(response.content)
        if (text) {
          const sent = await sendText(chatId, text, wamid)
          if (!sent.ok) console.error('ai: send failed:', sent.data)
        }
        const buttons = await offersOrderButtons(chatId)
        // The quote itself already went out above, so this is not silence — but
        // without the buttons the customer has no obvious way to say yes.
        if (!buttons.ok) {
          console.error('ai: botões de fechamento recusados:', JSON.stringify(buttons.data))
          await sendText(chatId, 'Quer que eu siga com esse pedido? É só me confirmar. 🙂')
        }
        return
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({
        role: 'user',
        content: toolUses.map((tu) => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: runAiTool(tu, chatId),
        })),
      })
    }

    // Running out of tool rounds used to end in silence — the loop finished
    // with no text and this returned without sending anything. The customer
    // simply never heard back, with nothing in the logs to show why. Four
    // searches in one turn is unusual but reachable (search → retry with
    // another term → sheet calculation → confirmation search), and silence is
    // the worst possible answer.
    if (!replyText) {
      console.error(`ai: sem resposta após ${MAX_TOOL_ROUNDS} rodadas de ferramenta, chatId=${chatId}`)
      await sendText(
        chatId,
        'Desculpa, me embolei aqui procurando isso pra você. 😅 Pode me dizer de novo o que precisa, com o nome do produto se souber?',
        wamid,
      )
      return
    }

    // No automatic close buttons here: the model asks for them with
    // `oferecer_fechamento` when the conversation is actually at that point.
    const result = await sendText(chatId, replyText, wamid)
    if (!result.ok) console.error('ai: send failed:', result.data)
  } catch (err) {
    console.error('ai: handling failed:', err)
    // An exception used to be swallowed here too, leaving the customer waiting
    // on a reply that was never coming.
    await sendText(
      chatId,
      'Tive um probleminha técnico agora. 😕 Pode mandar sua mensagem de novo? Se continuar, me avisa que eu chamo a equipe.',
      wamid,
    ).catch(() => {})
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
  interactive?: {
    type: string
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  // Referral data from Click-to-WhatsApp ads
  referral?: {
    source_url?: string
    source_type?: string
    source_id?: string
    headline?: string
    body?: string
    ctwa_clid?: string
  }
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
      // A mismatch here silently drops every message while /health still says
      // ok — the exact shape of "the bot stopped answering" with nothing in the
      // logs. One character wrong in the Railway variable is enough, so say so.
      if (value.metadata?.phone_number_id !== PHONE_NUMBER_ID) {
        console.error(
          `webhook: mensagem ignorada — phone_number_id "${value.metadata?.phone_number_id}" ` +
            `não bate com WHATSAPP_PHONE_NUMBER_ID "${PHONE_NUMBER_ID}"`,
        )
        continue
      }
      if (!Array.isArray(value.messages)) continue

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
          case 'interactive': {
            const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply
            enqueue({ ...base, text: reply?.title })
            logText = reply?.title ? `[menu] ${reply.title}` : '[menu]'
            break
          }
          default:
            enqueue({ ...base, text: `(unsupported type: ${msg.type})` })
        }

        const ts = Date.now()
        const seq = logMessage({ direction: 'in', chatId: msg.from, pushName, text: logText, timestamp: ts, wamid: msg.id })
        if (msg.type !== 'reaction') tocarCliente(msg.from, pushName, msg.referral?.ctwa_clid)

        // Skip auto-replying to plain reactions (a 👍 on an old message doesn't need a reply),
        // and skip messages we've already handled (Meta retried the webhook delivery).
        if (msg.type !== 'reaction' && !processedForAI.has(msg.id)) {
          processedForAI.add(msg.id)
          if (processedForAI.size > MAX_PROCESSED_FOR_AI) {
            const oldest = processedForAI.values().next().value
            if (oldest) processedForAI.delete(oldest)
          }

          if (msg.type === 'interactive') {
            // Tap on an order-closing button or one of the AI's own mostrar_opcoes
            // buttons/list — handled deterministically, no AI call needed. Taps
            // are discrete, unambiguous actions, so they skip the burst wait
            // that plain text goes through below.
            const wizId = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id
            if (wizId?.startsWith('wiz|')) {
              pending.push(enqueueForChat(msg.from, () => handleWizardTap(msg.from, wizId, msg.id, pushName)))
            } else {
              // Any other interactive reply — a WhatsApp Flow (nfm_reply), or a
              // subtype Meta adds later. This used to be dropped on the floor,
              // so the customer tapped something and nothing at all happened.
              // Send it to the assistant as text instead.
              console.error(`webhook: interactive sem id wiz| (tipo "${msg.interactive?.type}") — tratando como texto`)
              pending.push(enqueueForChat(msg.from, () => handleWithAI(msg.from, msg.id, logText, seq, pushName)))
            }
          } else {
            // Plain text/media: hold briefly in case more is coming from the same
            // chat (see scheduleBurst) instead of answering a possible fragment.
            pending.push(scheduleBurst(msg.from, msg.id, logText, seq, pushName))
          }
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
    // Respond to Meta right away instead of waiting for the AI reply. The
    // actual reply goes out through its own WhatsApp API call (sendText/
    // sendButtons), never through this response body, so Meta gets nothing
    // by waiting for it — and waiting can backfire: a burst wait (up to
    // BURST_QUIET_MS/BURST_MAX_MS) plus several tool rounds can add up to
    // more than Meta's own webhook timeout, and when that happens Meta
    // re-delivers the SAME message. That's not hypothetical — it happened in
    // a real test on 2026-09-13 (chatId 553175550007, seq 57/58): the
    // customer's message was logged twice, ~23s apart, with the identical
    // wamid, right as that turn was grinding through a long tool-call loop.
    // The redelivery is deduped by `processedForAI` so it doesn't trigger a
    // second AI reply, but there's no upside to keeping the connection open
    // that long. This used to be intentional — blocking here so the reply
    // work wouldn't be cut off if Railway put the container to sleep right
    // after the handler returned — but that only matters if Railway's
    // Serverless/App-Sleeping is turned on for this service, and it isn't
    // (checked the service config: no serverless setting is set). If that
    // ever changes, this needs to go back to awaiting the replies.
    parseMessages(payload).forEach((p) =>
      p.catch((err) => console.error('webhook: background handling failed:', err)),
    )
  } catch (err) {
    console.error('webhook: parse error:', err)
  }

  return c.text('ok', 200)
})

// Health check
app.get('/health', (c) => {
  return c.json({ ok: true, queue_size: queue.length, uptime: Math.floor((Date.now() - START) / 1000) })
})

// --- Public pages required by Meta for app review (Privacy Policy & Data Deletion) ---

const PRIVACY_HTML = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Política de Privacidade — Quick Gráfica</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}
  h1{border-bottom:2px solid #e63946;padding-bottom:.5rem}
  h2{margin-top:2rem;color:#111}
  a{color:#e63946}
  small{color:#666}
  ul{padding-left:1.2rem}
</style>
</head>
<body>
<h1>Política de Privacidade</h1>
<p><small>Última atualização: 23 de setembro de 2026</small></p>

<p>A <strong>Quick Gráfica</strong> ("nós") respeita a privacidade dos seus clientes e trata dados pessoais conforme a Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018) e as políticas da Meta/WhatsApp.</p>

<h2>1. Dados que coletamos</h2>
<ul>
  <li><strong>Identificação de contato:</strong> nome exibido no WhatsApp e número de telefone.</li>
  <li><strong>Conteúdo da conversa:</strong> mensagens (texto, áudio, imagem, documento) enviadas voluntariamente pelo cliente para o atendimento comercial.</li>
  <li><strong>Dados de pedido:</strong> especificações do produto solicitado, endereço de entrega, forma de pagamento (quando informados pelo cliente).</li>
  <li><strong>Dados técnicos:</strong> horários das mensagens e identificadores da API do WhatsApp para operação do atendimento.</li>
</ul>

<h2>2. Finalidade</h2>
<p>Os dados são usados exclusivamente para:</p>
<ul>
  <li>Atender solicitações de orçamento, pedidos e suporte;</li>
  <li>Enviar propostas, confirmações e informações do pedido;</li>
  <li>Emitir nota fiscal e documentos comerciais;</li>
  <li>Melhorar a qualidade do atendimento por meio de análise agregada.</li>
</ul>

<h2>3. Compartilhamento com terceiros</h2>
<p>Para operar o atendimento, utilizamos serviços de:</p>
<ul>
  <li><strong>Meta Platforms / WhatsApp Business API</strong> — transporte e processamento das mensagens;</li>
  <li><strong>Provedores de IA (OpenAI e Anthropic)</strong> — processamento das mensagens para geração de respostas;</li>
  <li><strong>Railway</strong> — hospedagem do servidor de atendimento;</li>
  <li><strong>Google Sheets</strong> — registro interno de pedidos e histórico.</li>
</ul>
<p>Não vendemos, alugamos ou cedemos seus dados a terceiros para fins de marketing.</p>

<h2>4. Retenção</h2>
<p>Mensagens e dados de contato são mantidos pelo tempo necessário ao atendimento e cumprimento de obrigações legais (fiscais e comerciais), tipicamente por até 5 anos, após o que são eliminados ou anonimizados.</p>

<h2>5. Seus direitos (LGPD)</h2>
<p>Você pode, a qualquer momento, solicitar:</p>
<ul>
  <li>Confirmação da existência de tratamento dos seus dados;</li>
  <li>Acesso aos dados;</li>
  <li>Correção de dados incompletos, inexatos ou desatualizados;</li>
  <li>Anonimização, bloqueio ou eliminação de dados desnecessários ou excessivos;</li>
  <li>Portabilidade;</li>
  <li>Eliminação dos dados tratados com base no consentimento;</li>
  <li>Revogação do consentimento.</li>
</ul>

<h2>6. Como exercer seus direitos ou excluir seus dados</h2>
<p>Envie sua solicitação para <a href="mailto:contato@quickgrafica.com.br">contato@quickgrafica.com.br</a> ou pelo WhatsApp comercial. Para instruções detalhadas de exclusão, consulte a página de <a href="/data-deletion">Exclusão de Dados</a>.</p>

<h2>7. Segurança</h2>
<p>Adotamos medidas técnicas e administrativas razoáveis para proteger os dados contra acesso não autorizado, destruição, perda ou alteração acidental.</p>

<h2>8. Alterações</h2>
<p>Esta política pode ser atualizada. A data no topo indica a versão vigente.</p>

<h2>9. Contato</h2>
<p><strong>Quick Gráfica</strong><br>
E-mail: <a href="mailto:contato@quickgrafica.com.br">contato@quickgrafica.com.br</a><br>
Site: <a href="https://quickgrafica.com.br">quickgrafica.com.br</a></p>
</body>
</html>`

const DATA_DELETION_HTML = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Exclusão de Dados — Quick Gráfica</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}
  h1{border-bottom:2px solid #e63946;padding-bottom:.5rem}
  h2{margin-top:2rem;color:#111}
  a{color:#e63946}
  small{color:#666}
  ol{padding-left:1.2rem}
  .box{background:#f7f7f7;border-left:4px solid #e63946;padding:1rem;margin:1.5rem 0}
</style>
</head>
<body>
<h1>Solicitação de Exclusão de Dados</h1>
<p><small>Última atualização: 23 de setembro de 2026</small></p>

<p>Nos termos da Lei Geral de Proteção de Dados (LGPD) e das políticas da Meta, você tem o direito de solicitar a exclusão dos seus dados pessoais mantidos pela <strong>Quick Gráfica</strong>.</p>

<h2>Como solicitar</h2>
<ol>
  <li>Envie um e-mail para <a href="mailto:contato@quickgrafica.com.br?subject=Solicita%C3%A7%C3%A3o%20de%20exclus%C3%A3o%20de%20dados">contato@quickgrafica.com.br</a> com o assunto <em>"Solicitação de exclusão de dados"</em>.</li>
  <li>No corpo da mensagem, informe:
    <ul>
      <li>Nome completo</li>
      <li>Número de WhatsApp/telefone utilizado no atendimento</li>
      <li>E-mail de contato (para retorno)</li>
    </ul>
  </li>
  <li>Alternativamente, envie a solicitação diretamente pelo WhatsApp comercial da Quick Gráfica.</li>
</ol>

<div class="box">
<strong>Prazo:</strong> processamos a exclusão em até 15 dias corridos e enviamos confirmação por e-mail ou WhatsApp.
</div>

<h2>O que será excluído</h2>
<ul>
  <li>Histórico de mensagens do WhatsApp associado ao seu número;</li>
  <li>Dados de contato (nome, telefone, e-mail);</li>
  <li>Registros de atendimento e preferências.</li>
</ul>

<h2>O que pode ser retido</h2>
<p>Podemos reter, exclusivamente pelo tempo legal exigido, dados vinculados a obrigações fiscais e contábeis (notas fiscais, pedidos faturados) conforme legislação brasileira. Esses dados são mantidos com acesso restrito e não são utilizados para nenhum outro fim.</p>

<h2>Contato</h2>
<p><strong>Quick Gráfica</strong><br>
E-mail: <a href="mailto:contato@quickgrafica.com.br">contato@quickgrafica.com.br</a><br>
Site: <a href="https://quickgrafica.com.br">quickgrafica.com.br</a></p>
</body>
</html>`

const TERMS_HTML = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Termos de Serviço — Quick Gráfica</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}
  h1{border-bottom:2px solid #e63946;padding-bottom:.5rem}
  h2{margin-top:2rem;color:#111}
  a{color:#e63946}
  small{color:#666}
  ul{padding-left:1.2rem}
</style>
</head>
<body>
<h1>Termos de Serviço</h1>
<p><small>Última atualização: 24 de setembro de 2026</small></p>

<p>Estes Termos regulam o atendimento comercial e a compra de produtos gráficos oferecidos pela <strong>Quick Gráfica</strong> ("nós") por meio de canais digitais, incluindo o atendimento automatizado via WhatsApp ("Sophia").</p>

<h2>1. Sobre o serviço</h2>
<p>A Quick Gráfica oferece orçamento, personalização e produção de itens gráficos (banners, cartões, adesivos e produtos correlatos). O atendimento inicial pode ser realizado por um assistente virtual, que auxilia na cotação, esclarecimento de dúvidas e encaminhamento do pedido para produção.</p>

<h2>2. Pedidos e pagamento</h2>
<ul>
  <li>Orçamentos são estimativas e podem variar conforme especificações finais do pedido (dimensões, material, quantidade e prazo).</li>
  <li>A confirmação do pedido ocorre após aprovação do orçamento e, quando aplicável, confirmação do pagamento.</li>
  <li>Prazos de produção e entrega são informados no momento do orçamento e podem variar conforme a demanda.</li>
</ul>

<h2>3. Cancelamentos e trocas</h2>
<p>Pedidos personalizados, por sua natureza sob encomenda, seguem as exceções previstas no Código de Defesa do Consumidor para produtos fabricados sob medida. Problemas de qualidade ou divergência em relação ao pedido aprovado devem ser reportados o quanto antes pelo canal de atendimento.</p>

<h2>4. Uso do atendimento automatizado</h2>
<p>O assistente virtual (Sophia) é uma ferramenta de apoio para agilizar cotações e dúvidas frequentes. Casos que exijam atenção humana podem ser encaminhados a um atendente da Quick Gráfica.</p>

<h2>5. Propriedade intelectual</h2>
<p>Artes e materiais enviados pelo cliente para impressão são de responsabilidade do próprio cliente quanto a direitos autorais e de uso de imagem. A Quick Gráfica não se responsabiliza por violações de direitos de terceiros em conteúdos fornecidos pelo cliente.</p>

<h2>6. Privacidade</h2>
<p>O tratamento de dados pessoais é regido pela nossa <a href="/privacy">Política de Privacidade</a>.</p>

<h2>7. Alterações</h2>
<p>Estes Termos podem ser atualizados periodicamente. A data no topo indica a versão vigente.</p>

<h2>8. Contato</h2>
<p><strong>Quick Gráfica</strong><br>
E-mail: <a href="mailto:contato@quickgrafica.com.br">contato@quickgrafica.com.br</a><br>
Site: <a href="https://quickgrafica.com.br">quickgrafica.com.br</a></p>
</body>
</html>`

app.get('/privacy', (c) => c.html(PRIVACY_HTML))
app.get('/privacidade', (c) => c.html(PRIVACY_HTML))
app.get('/data-deletion', (c) => c.html(DATA_DELETION_HTML))
app.get('/exclusao-dados', (c) => c.html(DATA_DELETION_HTML))
app.get('/terms', (c) => c.html(TERMS_HTML))
app.get('/termos', (c) => c.html(TERMS_HTML))

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
  if (!result.ok) return c.json({ error: result.data }, httpStatus(result.status))

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
  if (!result.ok) return c.json({ error: result.data }, httpStatus(result.status))

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
  if (!result.ok) return c.json({ error: result.data }, httpStatus(result.status))

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
  if (!result.ok) return c.json({ error: result.data }, httpStatus(result.status))
  return c.json({ ok: true })
})

// --- Conversation dashboard (read-only, token-protected) ---

// Returns the conversation log as JSON, newest last. The full log can be
// large (up to MAX_LOG entries) — big enough that a naive fetch of it truncates
// before reaching the newest entries at the end, which is exactly what you'd
// want when checking "did my test message just now go through". `limit`
// (default 50) returns only the last N entries, an optional `chatId` scopes to
// one conversation, and an optional `offset` pages through a long
// conversation from the start (0-indexed into the filtered list) instead of
// always anchoring to the end — needed because a single busy chat can still be
// too big for one fetch to see in full.
app.get('/log', (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const chatId = c.req.query('chatId')
  const limitParam = Number(c.req.query('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LOG) : 50
  const filtered = chatId ? log.filter((e) => e.chatId === chatId) : log
  const offsetParam = Number(c.req.query('offset'))
  const hasOffset = Number.isFinite(offsetParam) && offsetParam >= 0
  const offset = hasOffset ? offsetParam : Math.max(0, filtered.length - limit)
  const page = filtered.slice(offset, offset + limit)
  return c.json({ total: filtered.length, offset, mostrando: page.length, log: page })
})

// Daily token totals from registrarUso — the numbers behind "why is this
// costing so much". `dias` defaults to the last 14; pass ?dias=N for more
// (capped at what's actually kept, see MAX_DIAS_USO). `mediaRodadasPorTurno`
// is `chamadas / turnos` for that day: close to 1 means most customer
// messages get answered in a single API call; anything well above that means
// a lot of turns are burning multiple tool rounds (searches, calculations,
// retries), which is the single biggest cost multiplier in this system.
app.get('/custo', (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const diasParam = Number(c.req.query('dias'))
  const nDias = Number.isFinite(diasParam) && diasParam > 0 ? Math.min(diasParam, MAX_DIAS_USO) : 14
  const dias = Object.keys(uso)
    .sort()
    .slice(-nDias)
    .map((dia) => {
      const d = uso[dia]
      return {
        dia,
        turnos: d.turnos,
        chamadas: d.chamadas,
        mediaRodadasPorTurno: d.turnos > 0 ? Number((d.chamadas / d.turnos).toFixed(2)) : 0,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheWriteTokens: d.cacheWriteTokens,
        cacheReadTokens: d.cacheReadTokens,
      }
    })
  return c.json({ dias })
})

// --- Quick Gráfica product API: shape probe ---
//
// Step one of replacing the static catalog snapshot. The sandbox this was
// written in can't reach the API, and guessing a JSON shape means writing a
// parser against an imaginary contract. So this endpoint calls the API from the
// server that CAN reach it and reports back what actually came: status, the
// top-level keys, how many products, and one sample product with its fields.
// The real importer gets written against that. Reads credentials from the
// environment — the token never goes near the repository, and is never echoed
// back in the response.
app.get('/api-check', async (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)

  const url = process.env.QUICK_API_URL
  const apiToken = process.env.QUICK_API_TOKEN
  if (!url || !apiToken) {
    return c.json({
      erro: 'Faltam variáveis de ambiente no Railway.',
      necessarias: {
        QUICK_API_URL: url ? 'ok' : 'FALTANDO — ex: https://www.quickgrafica.com.br/api-v1/produtos',
        QUICK_API_TOKEN: apiToken ? 'ok' : 'FALTANDO — o Bearer token, sem a palavra "Bearer"',
      },
    })
  }

  // Optional extra query string to append (e.g. extra=pagina%3D2), so the API's
  // pagination and filters can be explored without a redeploy for each guess.
  // Only query params are accepted — the host always stays the configured one.
  const extra = c.req.query('extra')
  const target = extra ? url + (url.includes('?') ? '&' : '?') + extra : url

  try {
    const res = await fetch(target, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
    })
    const raw = await res.text()

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return c.json({
        status: res.status,
        aviso: 'A resposta não é JSON. Primeiros 800 caracteres:',
        amostra: raw.slice(0, 800),
      })
    }

    // Find the array of products wherever it happens to live.
    let list: unknown[] | null = Array.isArray(parsed) ? parsed : null
    let listaEm = list ? '(raiz)' : ''
    if (!list && parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          list = v
          listaEm = k
          break
        }
      }
    }

    const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    const sample = list?.[0]
    // `campo` narrows the answer to one field of the sample product, so a big
    // response can be read a piece at a time instead of overflowing.
    const campo = c.req.query('campo')
    if (campo && sample && typeof sample === 'object') {
      return c.json({ campo, valor: (sample as Record<string, unknown>)[campo] ?? null })
    }
    return c.json({
      urlChamada: target,
      status: res.status,
      chavesNoTopo: Object.keys(root).length ? Object.keys(root) : '(a raiz é uma lista)',
      listaEm,
      quantidadeNestaPagina: list?.length ?? 0,
      // Everything at the root that isn't the product list — usually where the
      // pagination lives.
      metaDados: Object.fromEntries(Object.entries(root).filter(([k]) => k !== listaEm)),
      camposDeUmProduto: sample && typeof sample === 'object' ? Object.keys(sample as object) : null,
      primeirosTitulos: (list ?? []).slice(0, 5).map((p) => (p as Record<string, unknown>)?.titulo ?? null),
    })
  } catch (err) {
    return c.json({ erro: 'A chamada falhou', detalhe: String(err) })
  }
})

// Every product whose price table fails a sanity check, with the id the shop's
// own admin uses. Built so a price error found here can be located and fixed at
// the source instead of being described in prose — and re-run afterwards to
// confirm the list got shorter.
//
// ?familia=adesivo narrows to matching product names.
app.get('/precos-suspeitos', (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)

  const familia = normalize(c.req.query('familia') ?? '')
  const itens: Array<Record<string, unknown>> = []

  for (const e of CATALOG_ENTRIES) {
    if (familia && !normalize(e.heading).includes(familia) && !normalize(e.body).includes(familia)) continue

    const tiers = e.api ? priceTiers(e.api) : tiersFromText(e.body)
    const aviso = tierWarning(tiers)
    if (!aviso) continue

    const campo = (nome: string) => {
      const m = e.body.match(new RegExp(`${nome}:\\s*([^|\\n]+)`))
      return m ? m[1].trim() : null
    }
    itens.push({
      id: e.api?.id ?? null,
      pai: e.api?.pai ?? null,
      produto: e.heading,
      formato: e.api?.formato ?? campo('Formato'),
      material: e.api?.material ?? campo('Material'),
      cores: e.api?.cores ?? campo('Cores/Impressão'),
      precoAtual: tiers.map(tierLabel).join('; '),
      problema: aviso.replace('⚠️ PREÇO SUSPEITO: ', '').split('. NÃO dê valor')[0],
    })
  }

  return c.json({
    fonte: catalogSource,
    filtro: c.req.query('familia') ?? '(todos)',
    encontrados: itens.length,
    deUmTotalDe: CATALOG_ENTRIES.length,
    itens,
  })
})

// Everything the sheet-sticker calculator can see, in one place. This exists
// because the calculator once failed in production with a message that said
// only "não consegui ler a tabela", and diagnosing it from the outside meant
// guessing at the API's shape. Now the answer is one request.
app.get('/folha-check', (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)

  const e = sheetEntry()
  const tiers = sheetTiers()
  const materiais = sheetMaterials()
  const exemplo = quoteSheetStickers(5, 5, 100, materiais[0]?.name)

  return c.json({
    produtoEncontrado: e?.heading ?? null,
    origemDoProduto: e ? (e.api ? 'API ao vivo' : 'snapshot (catalogo.md)') : null,
    precoNaApi: e?.api ? (e.api.preco ?? null) : '(não é entrada da API)',
    faixasDePreco: tiers.map((t) => ({
      de: t.min,
      ate: t.max === Number.MAX_SAFE_INTEGER ? 'em diante' : t.max,
      porFolha: brl(t.price),
    })),
    origemDasFaixas: sheetTiersSource,
    materiais: materiais.map((m) => ({ nome: m.name, acrescimo: brl(m.extra) })),
    exemplo100Adesivos5x5: exemplo,
  })
})

// Where the catalog currently comes from, and a way to force a reload after
// prices change on the site instead of waiting for the next refresh.
app.get('/catalogo-status', async (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)

  if (c.req.query('recarregar') === '1') {
    // &forcar=1 accepts a load even if it came back much smaller than the last
    // good one — the manual override for a real, large catalog reduction.
    const r = await refreshCatalogFromApi(c.req.query('forcar') === '1')
    return c.json({
      recarregou: r.ok,
      erro: r.erro ?? null,
      fonte: catalogSource,
      produtos: CATALOG_ENTRIES.length,
    })
  }

  const exemplo = CATALOG_ENTRIES.find((e) => normalize(e.heading).includes('cartao de visita promocional'))
  return c.json({
    fonte: catalogSource,
    produtos: CATALOG_ENTRIES.length,
    carregadoEm: catalogLoadedAt ? new Date(catalogLoadedAt).toISOString() : null,
    ultimoErro: catalogLastError || null,
    formatosInesperados: shapeNotes,
    exemplo: exemplo ? describeEntry(exemplo).trim() : null,
  })
})

// The review queue: conversations with something worth a human's eyes, and why.
app.get('/revisao', (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ items: reviewConversations(log) })
})

// Lets the dashboard reply to a customer as the business. Gated by the same
// DASHBOARD_TOKEN as the rest of the dashboard (not RELAY_SECRET) — anyone who
// can see the conversations can reply to them, and the two tokens stay
// independent in case DASHBOARD_TOKEN is ever set to something separate.
app.post('/dashboard-send', async (c) => {
  if (c.req.query('token') !== DASHBOARD_TOKEN) return c.json({ error: 'unauthorized' }, 401)

  const { to, text } = await c.req.json<{ to: string; text: string }>()
  if (!to || !text?.trim()) return c.json({ error: 'to e text são obrigatórios' }, 400)

  const result = await sendText(to, text.trim())
  if (!result.ok) return c.json({ error: result.data }, httpStatus(result.status))

  const wamid = (result.data as { messages?: Array<{ id: string }> }).messages?.[0]?.id
  return c.json({ wamid })
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
  #chat-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #chat { flex: 1; overflow-y: auto; padding: 16px; }
  .bubble { max-width: 70%; padding: 8px 12px; border-radius: 8px; margin-bottom: 8px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .bubble.in { background: #fff; margin-right: auto; }
  .bubble.out { background: #d9fdd3; margin-left: auto; }
  .bubble .meta { font-size: 10px; color: #888; margin-top: 4px; text-align: right; }
  #empty { padding: 40px; text-align: center; color: #888; }
  #composer { display: none; gap: 8px; padding: 10px; background: #f0f0f0; border-top: 1px solid #ddd; }
  #composer.visible { display: flex; }
  #msgInput { flex: 1; padding: 10px 12px; border-radius: 20px; border: 1px solid #ccc; font-size: 14px; font-family: inherit; outline: none; }
  #sendBtn { padding: 0 18px; border-radius: 20px; border: none; background: #075e54; color: #fff; font-size: 14px; cursor: pointer; }
  #sendBtn:disabled { opacity: 0.5; cursor: default; }
  #sendError { color: #c0392b; font-size: 12px; padding: 0 12px 8px; }
  header .tabs { display: flex; gap: 6px; }
  header button.tab { background: rgba(255,255,255,0.15); color: #fff; border: none; padding: 6px 12px; border-radius: 14px; font-size: 13px; font-family: inherit; cursor: pointer; }
  header button.tab.active { background: #fff; color: #075e54; font-weight: 600; }
  #review { flex: 1; overflow-y: auto; padding: 12px; display: none; }
  #review.visible { display: block; }
  #review .intro { font-size: 13px; color: #555; margin-bottom: 12px; line-height: 1.5; }
  .rev { background: #fff; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; cursor: pointer; border: 1px solid #ddd; }
  .rev:hover { border-color: #075e54; }
  .rev .top { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
  .rev .who { font-weight: 600; }
  .rev .when { color: #888; font-size: 11px; white-space: nowrap; }
  .rev .flags { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .rev .flag { font-size: 11px; padding: 3px 8px; border-radius: 10px; background: #eee; color: #333; }
  .rev .flag.correcao, .rev .flag.sem_produto { background: #fdecea; color: #922b21; }
  .rev .flag.repeticao, .rev .flag.demora { background: #fef5e7; color: #9c640c; }
  .rev .flag.escalou, .rev .flag.humano { background: #eaf2f8; color: #1a5276; }
  .rev .quote { margin-top: 8px; font-size: 12px; color: #666; font-style: italic; border-left: 3px solid #ddd; padding-left: 8px; white-space: pre-wrap; word-break: break-word; }
  #review .none { text-align: center; color: #888; padding: 40px 20px; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b141a; color: #eee; }
    #contacts { background: #111b21; border-color: #222; }
    .contact { border-color: #222; }
    .contact:hover, .contact.active { background: #1f2c33; }
    .contact .preview { color: #999; }
    .bubble.in { background: #1f2c33; }
    .bubble.out { background: #005c4b; }
    #composer { background: #111b21; border-color: #222; }
    #msgInput { background: #1f2c33; border-color: #333; color: #eee; }
    #review .intro { color: #aaa; }
    .rev { background: #111b21; border-color: #222; }
    .rev .flag { background: #1f2c33; color: #ddd; }
    .rev .flag.correcao, .rev .flag.sem_produto { background: #4a1f1a; color: #f5b7b1; }
    .rev .flag.repeticao, .rev .flag.demora { background: #4a3a15; color: #f7dc6f; }
    .rev .flag.escalou, .rev .flag.humano { background: #17334d; color: #aed6f1; }
    .rev .quote { color: #999; border-color: #333; }
  }
</style>
</head>
<body>
<header>
  <div class="tabs">
    <button class="tab active" id="tabConversas">Conversas</button>
    <button class="tab" id="tabRevisao">Revisão</button>
  </div>
  <span class="status" id="status">carregando…</span>
</header>
<div id="layout">
  <div id="contacts"></div>
  <div id="chat-panel">
    <div id="chat"><div id="empty">Selecione uma conversa</div></div>
    <div id="sendError"></div>
    <div id="composer">
      <input id="msgInput" type="text" placeholder="Digite uma mensagem..." autocomplete="off">
      <button id="sendBtn">Enviar</button>
    </div>
  </div>
  <div id="review"></div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
let selected = null;
let lastLen = 0;
let tab = 'conversas';

async function tick() {
  try {
    const res = await fetch('/log?token=' + encodeURIComponent(TOKEN));
    if (!res.ok) { document.getElementById('status').textContent = 'erro de autenticação'; return; }
    const { log } = await res.json();
    document.getElementById('status').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR');
    render(log);
    if (tab === 'revisao') loadReview();
  } catch (e) {
    document.getElementById('status').textContent = 'sem conexão';
  }
}

function setTab(next) {
  tab = next;
  document.getElementById('tabConversas').classList.toggle('active', next === 'conversas');
  document.getElementById('tabRevisao').classList.toggle('active', next === 'revisao');
  document.getElementById('contacts').style.display = next === 'conversas' ? '' : 'none';
  document.getElementById('chat-panel').style.display = next === 'conversas' ? '' : 'none';
  document.getElementById('review').classList.toggle('visible', next === 'revisao');
  if (next === 'revisao') loadReview();
}

async function loadReview() {
  const el = document.getElementById('review');
  try {
    const res = await fetch('/revisao?token=' + encodeURIComponent(TOKEN));
    if (!res.ok) { el.innerHTML = '<div class="none">Erro ao carregar.</div>'; return; }
    const { items } = await res.json();
    renderReview(items);
  } catch (e) {
    el.innerHTML = '<div class="none">Sem conexão.</div>';
  }
}

function renderReview(items) {
  const el = document.getElementById('review');
  if (!items.length) {
    el.innerHTML = '<div class="none">Nenhuma conversa precisando de atenção. 👍</div>';
    return;
  }
  let html = '<div class="intro">Conversas que valem uma olhada — cada marca aponta um conhecimento que falta ou um erro pra corrigir. Toque para abrir a conversa.</div>';
  for (const it of items) {
    const when = new Date(it.lastAt).toLocaleString('pt-BR');
    const flags = it.flags.map(f => '<span class="flag ' + f.code + '">' + escapeHtml(f.label) + '</span>').join('');
    const quoted = it.flags.filter(f => f.detail).slice(0, 2)
      .map(f => '<div class="quote">' + escapeHtml(f.detail) + '</div>').join('');
    html += '<div class="rev" data-chat="' + escapeHtml(it.chatId) + '">' +
      '<div class="top"><span class="who">' + escapeHtml(it.name) + '</span><span class="when">' + when + '</span></div>' +
      '<div class="flags">' + flags + '</div>' + quoted + '</div>';
  }
  el.innerHTML = html;
  for (const card of el.querySelectorAll('.rev')) {
    card.onclick = () => {
      selected = card.getAttribute('data-chat');
      lastLen = 0;
      setTab('conversas');
      tick();
    };
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
    div.onclick = () => { selected = id; lastLen = 0; document.getElementById('sendError').textContent = ''; render(log); };
    contactsEl.appendChild(div);
  }

  const composerEl = document.getElementById('composer');
  composerEl.classList.toggle('visible', !!selected);

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

const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const sendErrorEl = document.getElementById('sendError');

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !selected) return;

  sendBtn.disabled = true;
  msgInput.disabled = true;
  sendErrorEl.textContent = '';

  try {
    const res = await fetch('/dashboard-send?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: selected, text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      sendErrorEl.textContent = 'Falha ao enviar: ' + (body.error ? JSON.stringify(body.error) : res.status);
    } else {
      msgInput.value = '';
      lastLen = 0; // force the next tick to re-render this chat with the message we just sent
      tick();
    }
  } catch (e) {
    sendErrorEl.textContent = 'Sem conexão — tente de novo.';
  } finally {
    sendBtn.disabled = false;
    msgInput.disabled = false;
    msgInput.focus();
  }
}

sendBtn.onclick = sendMessage;
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
});

document.getElementById('tabConversas').onclick = () => setTab('conversas');
document.getElementById('tabRevisao').onclick = () => setTab('revisao');

tick();
setInterval(tick, 4000);
</script>
</body>
</html>`)
})

// --- Start ---

// On Node 20+ an unhandled rejection terminates the process by default, which
// would take the bot offline over a single stray promise. Every known path is
// already covered, but a crash here is a silent outage for every customer at
// once, so it is logged and survived rather than trusted.
// A stray rejection is survivable: every await path here is guarded, so this
// only catches something nobody is waiting on, and killing the bot over it
// would be worse than logging it.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (processo mantido de pé):', reason)
})

// An uncaught exception is NOT survivable, and staying up is the worse option.
// The stack unwound at an arbitrary point, so module state may be half-mutated;
// worse, if it escaped inside the webhook path the response never went out, Meta
// retries, and the message id is already in `processedForAI` — so the retry is
// skipped and the customer gets nothing, while /health still says ok. Exiting
// costs almost nothing: the conversation log is written after every message, so
// at most the in-flight one is lost, and Railway restarts in seconds.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException — encerrando para o Railway reiniciar limpo:', err)
  try {
    writeFileSync(LOG_TMP, JSON.stringify(log))
    renameSync(LOG_TMP, LOG_FILE)
  } catch {}
  try {
    writeFileSync(CLIENTES_TMP, JSON.stringify(clientes))
    renameSync(CLIENTES_TMP, CLIENTES_FILE)
  } catch {}
  try {
    writeFileSync(USO_TMP, JSON.stringify(uso))
    renameSync(USO_TMP, USO_FILE)
  } catch {}
  process.exit(1)
})

// Railway sends SIGTERM on every redeploy. Flushing here means the conversation
// log is written once, cleanly, instead of being caught mid-write.
let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} recebido, encerrando`)
  try {
    writeFileSync(LOG_TMP, JSON.stringify(log))
    renameSync(LOG_TMP, LOG_FILE)
  } catch (err) {
    console.error('log: falha ao salvar no encerramento:', err)
  }
  try {
    writeFileSync(CLIENTES_TMP, JSON.stringify(clientes))
    renameSync(CLIENTES_TMP, CLIENTES_FILE)
  } catch (err) {
    console.error('clientes: falha ao salvar no encerramento:', err)
  }
  try {
    writeFileSync(USO_TMP, JSON.stringify(uso))
    renameSync(USO_TMP, USO_FILE)
  } catch (err) {
    console.error('uso: falha ao salvar no encerramento:', err)
  }
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`whatsapp relay listening on :${info.port}`)
  // Load the live catalog after the port is open, so a slow or failing API
  // never delays or blocks startup — the static snapshot answers until it
  // lands, and keeps answering if it never does.
  void refreshCatalogFromApi()
  setInterval(() => void refreshCatalogFromApi(), CATALOG_REFRESH_MS)
})
