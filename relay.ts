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

const AI_MODEL = 'claude-sonnet-5'
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

const FACTS = new Map<CatalogEntry, EntryFacts>()
for (const e of CATALOG_ENTRIES) FACTS.set(e, parseFacts(e))

// Sibling entries = the same product under different codes/sizes. A spec that
// changes across them is a genuine choice the customer gets to make; one that
// holds steady across all of them is just how the product is.
const productBaseName = (h: string) =>
  h
    .replace(/\s*\([0-9A-Za-z]+\)\s*$/, '')
    .replace(/\s*[-\u2013]?\s*\d+([.,]\d+)?\s*x\s*\d+([.,]\d+)?\s*(mm|cm|m)?\s*$/i, '')
    .replace(/\s*[-\u2013]?\s*\d+([.,]\d+)?\s*(mm|cm|m)\s*$/i, '')
    .trim()

const SIBLINGS = new Map<string, CatalogEntry[]>()
for (const e of CATALOG_ENTRIES) {
  const key = `${e.category}/${e.subcategory}/${normalize(productBaseName(e.heading))}`
  if (!SIBLINGS.has(key)) SIBLINGS.set(key, [])
  SIBLINGS.get(key)!.push(e)
}

function siblingsOf(e: CatalogEntry): CatalogEntry[] {
  return SIBLINGS.get(`${e.category}/${e.subcategory}/${normalize(productBaseName(e.heading))}`) ?? [e]
}

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

// Renders one product the way the assistant should reason about it.
function describeEntry(e: CatalogEntry): string {
  const f = FACTS.get(e) ?? parseFacts(e)
  const variations = realVariations(e)
  const varyingKeys = new Set(variations.map((v) => v.key))

  const fixed = SPEC_KEYS.filter((k) => f.specs.has(k) && !varyingKeys.has(k))
    .map((k) => `${k}: ${f.specs.get(k)}`)
    .join(' | ')
  const thisOne = SPEC_KEYS.filter((k) => varyingKeys.has(k) && f.specs.has(k))
    .map((k) => `${k}: ${f.specs.get(k)}`)
    .join(' | ')

  const lines = [`### ${e.heading} [${e.category} / ${e.subcategory}]`]
  if (fixed) lines.push(`J\u00c1 VEM ASSIM (fixo \u2014 nunca pergunte como se fosse escolha): ${fixed}`)
  if (thisOne) lines.push(`ESTA VERS\u00c3O: ${thisOne}`)
  for (const p of f.priceLines) lines.push(p)

  const choices: string[] = []
  if (f.options) choices.push(f.options)
  for (const v of variations) choices.push(`[${v.key}] ${v.values.join('; ')}`)
  lines.push(
    choices.length
      ? `ESCOLHAS REAIS deste produto (s\u00f3 estas, nada al\u00e9m): ${choices.join(' || ')}`
      : 'ESCOLHAS REAIS deste produto: NENHUMA \u2014 n\u00e3o h\u00e1 nada pra escolher aqui, \u00e9 s\u00f3 confirmar quantidade.',
  )

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
  { when: /identific|credencia|cracha|acesso|participante|convidado|inscrit/, add: 'pulseira cracha credencial cordao' },
  { when: /vitrine|porta de vidro|janela|vidro da loja/, add: 'adesivo vitrine' },
  { when: /fachada|frente da loja|muro|tapume/, add: 'lona perfurada adesivo vitrine faixa banner' },
  { when: /divulg|propagand|anunci|publicidade|chamar atencao|na rua|marketing/, add: 'banner faixa panfleto cartaz wind banner' },
  { when: /chao|piso|pisar/, add: 'adesivo de piso' },
  { when: /parede/, add: 'adesivo de parede papel de parede' },
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
  const seen = new Map<string, number>()
  const top: CatalogEntry[] = []
  const rest: CatalogEntry[] = []
  for (const { e } of scored) {
    const key = baseName(e.heading)
    const n = seen.get(key) ?? 0
    if (n < MAX_PER_HEADING && top.length < MAX_SEARCH_RESULTS) {
      seen.set(key, n + 1)
      top.push(e)
    } else {
      rest.push(e)
    }
  }

  let out = ''
  for (const e of top) {
    const block = describeEntry(e)
    if (out.length + block.length > MAX_SEARCH_CHARS) break
    out += block
  }

  // Names only (cheap) of other products that also matched, so the assistant
  // knows what else exists and can search one of them specifically.
  const others = [...new Set(rest.map((e) => baseName(e.heading)))].filter((h) => !seen.has(h)).slice(0, 12)
  if (others.length) {
    out += `Outros produtos que também combinam com essa busca (busque pelo nome pra ver preço e detalhes): ${others.join('; ')}\n`
  }
  return out.trim()
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

const SHEET_ENTRY = CATALOG_ENTRIES.find((e) => e.heading.includes(SHEET_PRODUCT_CODE))

function parseBRL(s: string): number {
  return Number(s.replace(/\./g, '').replace(',', '.'))
}

function brl(n: number): string {
  const [int, dec] = n.toFixed(2).split('.')
  return `R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}

const SHEET_TIERS: Array<{ min: number; max: number; price: number }> = (() => {
  const line = SHEET_ENTRY?.body.split('\n').find((l) => l.includes('Preço por quantidade')) ?? ''
  return [...line.matchAll(/(\d+)\s*-\s*(\d+)un:\s*R\$\s*([\d.,]+)/g)]
    .map((m) => ({ min: Number(m[1]), max: Number(m[2]), price: parseBRL(m[3]) }))
    .sort((a, b) => a.min - b.min)
})()

const SHEET_MATERIALS: Array<{ name: string; extra: number }> = (() => {
  const line = SHEET_ENTRY?.body.split('\n').find((l) => l.includes('Opções:')) ?? ''
  const out: Array<{ name: string; extra: number }> = []
  for (const part of line.split(';')) {
    const m = part.match(/\[material\]\s*([^(]+?)\s*(?:\(\+R\$\s*([\d.,]+)\))?\s*$/)
    if (m) out.push({ name: m[1].trim(), extra: m[2] ? parseBRL(m[2]) : 0 })
  }
  return out
})()

function materialList(): string {
  return SHEET_MATERIALS.map((m) => (m.extra ? `${m.name} (+${brl(m.extra)})` : m.name)).join('; ')
}

function quoteSheetStickers(larguraCm: number, alturaCm: number, quantidade: number, material?: string): string {
  if (!SHEET_ENTRY || SHEET_TIERS.length === 0) {
    return 'Não consegui ler a tabela desse produto no catálogo. Não estime o valor — diga que a equipe confirma o preço.'
  }
  if (!(larguraCm > 0) || !(alturaCm > 0) || !(quantidade > 0)) {
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
  const tier = SHEET_TIERS.find((t) => folhas >= t.min && folhas <= t.max)
  if (!tier) {
    const maior = SHEET_TIERS[SHEET_TIERS.length - 1].max
    return `Esse pedido daria ${folhas} folhas, fora das faixas de preço do catálogo (vão até ${maior} folhas). Não estime nem faça regra de três — diga que a equipe confirma o preço dessa quantidade.`
  }

  let extra = 0
  let materialName = SHEET_MATERIALS[0]?.name ?? 'material padrão'
  if (material) {
    const want = normalize(material)
    const found =
      SHEET_MATERIALS.find((m) => normalize(m.name) === want) ??
      SHEET_MATERIALS.find((m) => normalize(m.name).includes(want) || want.includes(normalize(m.name)))
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
      'Envia uma pergunta com opções clicáveis pro cliente (vira botões se forem até 3, ou uma lista se forem 4 a 10) — em vez de escrever a pergunta e as opções como texto/lista numerada. Use sempre que for pedir pro cliente escolher entre 2 ou mais opções (tamanho, papel, acabamento, etc). Depois de chamar essa ferramenta pare — não escreva mais nenhum texto, a pergunta já foi enviada pra ele. Se só houver 1 opção possível (não é escolha), responda em texto normal em vez de usar essa ferramenta. IMPORTANTE: as opções têm que vir literalmente do que `buscar_catalogo` retornou pra esse produto (a linha "Opções:", ou variações distintas do mesmo produto) — nunca invente uma variação (tipo, cor, lado de impressão, etc) que não apareceu na busca, mesmo que pareça óbvia pra esse tipo de produto.',
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
                description: 'Texto curto do botão/opção, até 24 caracteres, ex: "10x15cm" ou "Papel Kraft"',
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
        largura_cm: { type: 'number', description: 'Largura do adesivo em centímetros' },
        altura_cm: { type: 'number', description: 'Altura do adesivo em centímetros' },
        quantidade: { type: 'number', description: 'Quantos ADESIVOS o cliente quer (não folhas)' },
        material: {
          type: 'string',
          description: 'Material escolhido pelo cliente, ex: "Vinil Adesivo Brilho". Deixe vazio se ele ainda não escolheu.',
        },
      },
      required: ['largura_cm', 'altura_cm', 'quantidade'],
    },
  },
  {
    name: 'oferecer_fechamento',
    description:
      'Envia, logo depois da sua mensagem, os botões "✅ Fechar pedido / 🔁 Outro produto / 💬 Falar com equipe". Use SOMENTE quando o orçamento já estiver completo E você não estiver esperando o cliente responder nada. Se a sua mensagem termina com uma pergunta (qual material, tem arte pronta, qual tamanho, etc), NÃO chame — espere ele responder primeiro, senão os botões atropelam a pergunta.',
    input_schema: { type: 'object', properties: {} },
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

// Sends up to 3 quick-reply buttons attached to a message.
async function sendButtons(
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
  replyTo?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const waButtons = buttons
    .slice(0, 3)
    .map((b) => ({ type: 'reply' as const, reply: { id: b.id, title: b.title.slice(0, 20) } }))

  const msgBody: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: { type: 'button', body: { text: body }, action: { buttons: waButtons } },
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
      body: { text: opts.body },
      ...(opts.footer ? { footer: { text: opts.footer.slice(0, 60) } } : {}),
      action: {
        button: opts.buttonText.slice(0, 20),
        sections: opts.sections.map((s) => ({
          title: s.title.slice(0, 24),
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        })),
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
const pendingOptions = new Map<string, string[]>()

async function handleWizardTap(chatId: string, id: string, replyTo?: string, pushName?: string): Promise<void> {
  try {
    if (id === 'wiz|outro') {
      await sendText(chatId, 'Claro! Me conta o que você precisa que eu já vejo pra você. 🙂', replyTo)
      return
    }
    if (id === 'wiz|human') {
      await sendText(chatId, 'Beleza! Pode me contar o que precisa que eu já te ajudo por aqui. 🙂', replyTo)
      return
    }
    if (id === 'wiz|close') {
      await sendText(chatId, 'Show! 🙌 Vou passar pra equipe confirmar os detalhes e o pagamento com você. Só um instante!', replyTo)
      // Flagged in the log so the team can spot closing intents in the /dashboard.
      logMessage({ direction: 'in', chatId, text: '⭐ Cliente quer fechar o pedido (confirmar pelos bastidores)', timestamp: Date.now() })
      return
    }
    if (id.startsWith('wiz|opt|')) {
      // Customer tapped one of the AI's own buttons/list (from `mostrar_opcoes`).
      // Resolve it back to full text and continue the AI flow as if they'd typed it —
      // this is what lets the AI ask one question at a time (tamanho → papel → ...).
      const i = Number(id.split('|')[2])
      const value = pendingOptions.get(chatId)?.[i]
      if (!value) {
        await sendText(chatId, 'Essa opção já expirou — pode me dizer de novo o que você precisa? 🙂', replyTo)
        return
      }
      pendingOptions.delete(chatId)
      const ts = Date.now()
      logMessage({ direction: 'in', chatId, text: value, timestamp: ts })
      await handleWithAI(chatId, replyTo ?? '', value, ts, pushName)
      return
    }
  } catch (err) {
    console.error('wizard: handling failed:', err)
  }
}

// After the AI quotes a price (its reply mentions "R$"), offer follow-up buttons so
// the customer can close, ask about something else, or ask for a human.
function offersOrderButtons(chatId: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  return sendButtons(chatId, 'Posso seguir com esse pedido?', [
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
  const pergunta = typeof data.pergunta === 'string' ? data.pergunta : 'Qual dessas opções você prefere?'
  const rawOpcoes = Array.isArray(data.opcoes) ? data.opcoes : []
  const opcoes = rawOpcoes
    .filter((o): o is { titulo: unknown; descricao?: unknown; valor: unknown } => typeof o === 'object' && o !== null)
    .map((o) => ({
      titulo: typeof o.titulo === 'string' && o.titulo ? o.titulo : 'Opção',
      descricao: typeof o.descricao === 'string' ? o.descricao : undefined,
      valor: typeof o.valor === 'string' && o.valor ? o.valor : String(o.titulo ?? 'opção'),
    }))
    .slice(0, 10)

  if (opcoes.length === 0) return

  pendingOptions.set(chatId, opcoes.map((o) => o.valor))

  if (opcoes.length <= 3) {
    await sendButtons(
      chatId,
      pergunta,
      opcoes.map((o, i) => ({ id: `wiz|opt|${i}`, title: o.titulo })),
      replyTo,
    )
  } else {
    await sendList(
      chatId,
      {
        body: pergunta,
        buttonText: 'Ver opções',
        sections: [
          {
            title: 'Opções',
            rows: opcoes.map((o, i) => ({ id: `wiz|opt|${i}`, title: o.titulo, description: o.descricao })),
          },
        ],
      },
      replyTo,
    )
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
function runAiTool(tu: Anthropic.Messages.ToolUseBlock): string {
  const input = (tu.input ?? {}) as Record<string, unknown>
  if (tu.name === 'calcular_folha_adesivo') {
    return quoteSheetStickers(
      Number(input.largura_cm),
      Number(input.altura_cm),
      Number(input.quantidade),
      typeof input.material === 'string' && input.material.trim() ? input.material : undefined,
    )
  }
  return searchCatalog(typeof input.termo === 'string' ? input.termo : '')
}

async function handleWithAI(chatId: string, wamid: string, userText: string, ts: number, pushName?: string): Promise<void> {
  try {
    const messages: Anthropic.Messages.MessageParam[] = [
      ...buildHistory(chatId, ts),
      { role: 'user', content: userText || '(mensagem vazia)' },
    ]

    // Adds the WhatsApp profile name (when we have one) as its own, uncached
    // system block — placed after the cached instructions/catalog blocks so it
    // varies per customer without invalidating that cache. Lets the assistant
    // greet by name without having to ask for it on every conversation.
    const system = pushName
      ? [...AI_SYSTEM, { type: 'text' as const, text: `Nome do cliente (perfil do WhatsApp, pode não ser o nome que ele usa pra se apresentar): ${pushName}` }]
      : AI_SYSTEM

    let replyText = ''

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 2048,
        system,
        tools: AI_TOOLS,
        messages,
      })

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
        await offersOrderButtons(chatId)
        return
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({
        role: 'user',
        content: toolUses.map((tu) => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: runAiTool(tu),
        })),
      })
    }

    if (!replyText) return

    // No automatic close buttons here: the model asks for them with
    // `oferecer_fechamento` when the conversation is actually at that point.
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
  interactive?: {
    type: string
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
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
        logMessage({ direction: 'in', chatId: msg.from, pushName, text: logText, timestamp: ts, wamid: msg.id })

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
            // buttons/list — handled deterministically, no AI call needed. Unrecognized
            // interactive replies are ignored.
            const wizId = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id
            if (wizId?.startsWith('wiz|')) {
              pending.push(enqueueForChat(msg.from, () => handleWizardTap(msg.from, wizId, msg.id, pushName)))
            }
          } else {
            pending.push(enqueueForChat(msg.from, () => handleWithAI(msg.from, msg.id, logText, ts, pushName)))
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

  try {
    const res = await fetch(url, {
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

    const sample = list?.[0]
    return c.json({
      status: res.status,
      chavesNoTopo: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : '(a raiz é uma lista)',
      listaEm,
      quantidadeDeProdutos: list?.length ?? 0,
      camposDeUmProduto: sample && typeof sample === 'object' ? Object.keys(sample as object) : null,
      exemploDeProduto: sample ?? null,
    })
  } catch (err) {
    return c.json({ erro: 'A chamada falhou', detalhe: String(err) })
  }
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
  if (!result.ok) return c.json({ error: result.data }, result.status as ContentfulStatusCode)

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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`whatsapp relay listening on :${info.port}`)
})
