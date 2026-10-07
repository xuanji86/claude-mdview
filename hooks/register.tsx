import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { MdviewDoc, MdviewEdit, MdviewFind, MdviewPending } from '../types'
import { blocksOf, bmpPixels, clean, fitCells, halfBlocks, hashOf, html, paginate, pngSize, sectionAt, sections, split, tables } from './doc'
import { basename, dirname, FENCE, hrefOf, linkify, MD, refOf, resolveRef } from './links'
import type { Ref } from './links'

const PANE = 'mdview'
const doc = atom({ plugin: 'mdview', key: 'doc' } as const, null as MdviewDoc | null)
const rev = atom({ plugin: 'mdview', key: 'rev' } as const, 0)
const toc = atom({ plugin: 'mdview', key: 'toc' } as const, false)
const find = atom({ plugin: 'mdview', key: 'find' } as const, null as MdviewFind | null)
const edit = atom({ plugin: 'mdview', key: 'edit' } as const, null as MdviewEdit | null, { shape: 'line+hash' })
const pending = atom({ plugin: 'mdview', key: 'pending' } as const, [] as MdviewPending[], { shape: 'id+text+turn+changed+done' })
const cwdHistory = atom({ plugin: 'mdview', key: 'cwds' } as const, [] as string[])

const TEXT_MAX = 9_000 // a Markdown or Code element takes at most 10,000 characters
const PAGE_MAX = 60_000 // a page of a long file: a whole tree tops out near 100k characters
const MAYBE_MD = /\.(?:md|markdown|mdx)\b/i
const MARK = '↗' // after each path a click opens here, so it reads as clickable
const PNG = /\.png$/i
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?|heic)$/i
const LONE_IMAGE = /^\s*!\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*$/
const ANY_IMAGE = /!\[([^\]\n]*)\]\(/g

type Part =
  | { kind: 'md'; text: string; hrefs: string[] }
  | { kind: 'img'; file: string; alt: string; columns: number; rows: number }
  | { kind: 'raster'; file: string; cells: string; alt: string; columns: number; rows: number }
  | { kind: 'code'; source: string; path: string; startLine: number }
// A stretch the pane jumps to: a section of a markdown file, or a run of lines of any other.
// A blank-line separated block of the file (a paragraph, list, table, fence, heading): the lines it spans, how it
// begins, and what draws it.
type Block = { line: number; end: number; first: string; hash: string; parts: Part[] }
type Unit = { level: number; title: string; slug: string; line: number; end: number; plain: string; blocks: Block[] }
type View = { units: Unit[]; pages: number[]; lines: number } | { note: string }

// Module state: a reload starts these over, which costs only a few stats.
let home = ''
let columns = 0 // the widest the terminal has been seen
let paneColumns = 80
let isOpen = false
const known = new Set<string>() // files seen to exist
// A transcript row's working directory when first drawn: its relative paths are resolved there first, so a cd does not
// move them (lost on a reload, when the session's directory history stands in).
const cwdOf = new Map<string, string>()
const views = new Map<string, View>() // lazy: the last 8 files drawn, by path, mtime and width
const sizes = new Map<string, { width: number; height: number } | null>() // lazy: a picture's size, never re-read
let pictures = false // the terminal draws an Image itself (kitty's graphics protocol); elsewhere pictures are Rasters
let isWarp = false // Warp has a Markdown viewer of its own, a click away from the pane
// What a click on a path in the conversation opens (userConfig): outside Warp `clickOpens`, in Warp `clickOpensInWarp`.
type Mode = 'pane' | 'warp' | 'app'
const SETTING = {
  warp: { key: 'clickOpensInWarp', choices: ['warp', 'pane', 'app'] as Mode[] },
  other: { key: 'clickOpens', choices: ['pane', 'app'] as Mode[] },
} as const
const modes: Record<keyof typeof SETTING, Mode> = { warp: 'warp', other: 'pane' }
const here = (): keyof typeof SETTING => (isWarp ? 'warp' : 'other')
const modeHere = (): Mode => modes[here()]
const asMode = (value: unknown, choices: readonly Mode[], fallback: Mode): Mode => choices.find(m => m === value) ?? fallback
const MODE_TEXT: Record<Mode, string> = {
  pane: "mdview's pane",
  warp: "Warp's Markdown viewer",
  app: 'the app macOS opens .md files with',
}
let tmp = '/tmp'
let made = 0

const tilde = (p: string): string => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p)
// lines as an editor counts them: a final newline ends the last line rather than starting one
const lineCount = (s: string): number => (s ? s.replace(/\n$/, '').split('\n').length : 0)
const plainTitle = (t: string): string => t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*~]/g, '')
const note = (text: string): View => ({ note: text })
const keyOf = (unit: number, part: number) => (part ? `u${unit}-${part}` : `u${unit}`)

// A working directory the session moved to, kept in the session's state so a reload of the mod keeps it.
async function remember($: EngineInterface, cwd: string) {
  if ((await read($, cwdHistory))[0] === cwd) return // unchanged: no write, so no transcript row redraws
  await update($, cwdHistory, list => [cwd, ...(list ?? []).filter(c => c !== cwd)].slice(0, 10))
}

async function homeDir($: EngineInterface) {
  return (home ||= (await $.env.get('HOME')) ?? '')
}

// `text` with every reference to an existing file made a file:// link (markdown files, and with `anyLink` any
// file a markdown link names), tried against each of `bases` in turn; null when there is none.
async function linkFiles($: EngineInterface, text: string, bases: readonly string[], opts: { self?: string; anyLink?: boolean } = {}) {
  await homeDir($)
  const found = new Map<string, Ref[]>()
  linkify(text, (raw, kind) => {
    const refs: Ref[] = []
    for (const base of bases) {
      const ref = resolveRef(raw, base, home, { anyExt: opts.anyLink && kind === 'link', self: opts.self })
      if (ref && !refs.some(r => r.abs === ref.abs)) refs.push(ref)
    }
    if (refs.length) found.set(`${kind}|${raw}`, refs)
    return null
  })
  if (found.size === 0) return null
  await Promise.all(
    [...new Set([...found.values()].flat().map(r => r.abs))]
      .filter(p => !known.has(p))
      .map(async p => {
        const st = await $.fs.stat(p).catch(() => null)
        if (st?.kind === 'file') known.add(p)
      }),
  )
  const hrefs = new Set<string>()
  const out = linkify(
    text,
    (raw, kind) => {
      const ref = found.get(`${kind}|${raw}`)?.find(r => known.has(r.abs))
      if (!ref) return null
      try {
        const h = hrefOf(ref)
        hrefs.add(h)
        return h
      } catch {
        return null // a lone surrogate encodeURI refuses
      }
    },
    MARK,
  )
  return hrefs.size ? { text: out, hrefs: [...hrefs] } : null
}

const mdParts = (text: string, hrefs: readonly string[]): Part[] =>
  split(text, TEXT_MAX).map(t => ({ kind: 'md', text: t, hrefs: hrefs.filter(h => t.includes(`](${h})`)).slice(0, 256) }))

// macOS's own image tool: what converts and scales any picture format here. Null where it is missing or fails.
async function sips($: EngineInterface, args: string[]): Promise<string | null> {
  const run = await $.process.run(['sips', ...args], { timeoutMs: 15_000 }).catch(() => null)
  return run?.exitCode === 0 ? run.stdout : null
}

async function imageSize($: EngineInterface, file: string) {
  if (!sizes.has(file)) {
    let size: { width: number; height: number } | null = null
    if (PNG.test(file)) {
      const bytes = await $.fs.read(file, { as: 'bytes' }).catch(() => null)
      size = bytes ? pngSize(bytes.base64) : null
    }
    if (!size) {
      const out = (await sips($, ['-g', 'pixelWidth', '-g', 'pixelHeight', file])) ?? ''
      const width = Number(/pixelWidth: (\d+)/.exec(out)?.[1])
      const height = Number(/pixelHeight: (\d+)/.exec(out)?.[1])
      size = width > 0 && height > 0 ? { width, height } : null
    }
    sizes.set(file, size)
  }
  return sizes.get(file) ?? null
}

// A local picture drawn in place, sized to the pane and kept to its proportions: the terminal's own picture where it
// draws one (another format turned into a PNG first), elsewhere colored half-block cells any truecolor terminal shows.
async function imagePart($: EngineInterface, src: string, alt: string, base: string): Promise<Part | null> {
  const ref = resolveRef(src, base, home, { anyExt: true })
  if (!ref || !IMAGE.test(ref.abs) || (await $.fs.stat(ref.abs).catch(() => null))?.kind !== 'file') return null
  const size = await imageSize($, ref.abs)
  if (!size) return null
  alt ||= basename(ref.abs)
  if (pictures) {
    let file = ref.abs
    if (!PNG.test(file)) {
      file = `${tmp}/mdview-${[...ref.abs].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}.png` // left in place: the terminal reads it
      if ((await sips($, ['-s', 'format', 'png', ref.abs, '--out', file])) === null) return null
    }
    return { kind: 'img', file, alt, ...fitCells(size.width, size.height, Math.min(paneColumns - 2, 80), 40) }
  }
  const box = fitCells(size.width, size.height, Math.min(paneColumns - 2, 80), 24) // lazy: 24 rows keeps a page's cells small; tall pictures shrink
  const bmp = `${tmp}/mdview-${made++}.bmp`
  if ((await sips($, ['-s', 'format', 'bmp', '-z', String(box.rows * 2), String(box.columns), ref.abs, '--out', bmp])) === null) return null
  const bytes = await $.fs.read(bmp, { as: 'bytes' }).catch(() => null)
  void $.process.run(['rm', '-f', bmp]).catch(() => null)
  const px = bytes ? bmpPixels((Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(bytes.base64)) : null
  if (!px) return null
  const cells = new Uint8Array(halfBlocks(px, box.columns, box.rows).buffer) as Uint8Array & { toBase64: () => string }
  return { kind: 'raster', file: ref.abs, cells: cells.toBase64(), alt, ...box }
}

// One section of a markdown file as the pane draws it: HTML and too-wide tables turned to markdown, local PNGs on
// a line of their own drawn as pictures, other pictures a link, file references links.
async function sectionParts($: EngineInterface, text: string, path: string): Promise<Part[]> {
  const base = dirname(path)
  const parts: Part[] = []
  let buf: string[] = []
  const flush = async () => {
    const md = buf.join('\n').replace(/^\n+|\n+$/g, '')
    buf = []
    if (!md) return
    const linked = await linkFiles($, md, [base], { self: path, anyLink: true })
    parts.push(...mdParts(linked?.text ?? md, linked?.hrefs ?? []))
  }
  let fence: string | null = null
  for (const line of tables(html(text), paneColumns - 2).split('\n')) {
    const f = FENCE.exec(line)?.[1]
    if (fence || f) {
      if (fence && f && f[0] === fence[0] && f.length >= fence.length) fence = null
      else if (!fence && f) fence = f
      buf.push(line)
      continue
    }
    const lone = LONE_IMAGE.exec(line)
    const img = lone ? await imagePart($, lone[2]!, lone[1]!, base) : null
    if (img) {
      await flush()
      parts.push(img)
    } else buf.push(line.replace(ANY_IMAGE, (_, alt: string) => `[🖼 ${alt || 'image'}](`))
  }
  await flush()
  return parts
}

async function build($: EngineInterface, path: string): Promise<View> {
  const link = `[${basename(path)}](${hrefOf({ abs: path, frag: '' })})`
  if (IMAGE.test(path)) {
    const img = await imagePart($, path, basename(path), '/')
    return img
      ? { units: [{ level: 0, title: '', slug: '', line: 1, end: 1, plain: '', blocks: [{ line: 1, end: 1, first: '', hash: '', parts: [img] }] }], pages: [0], lines: 0 }
      : note(`This picture can't be drawn here. Open ${link} instead.`)
  }
  let raw: string
  try {
    raw = await $.fs.read(path)
  } catch (err) {
    return note(`Can't read ${link}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500))
  }
  if (raw.slice(0, 8000).includes(String.fromCharCode(0))) return note(`${link} is a binary file.`)
  const src = clean(raw)

  if (!MD.test(path)) {
    const units: Unit[] = []
    let line = 1
    for (const source of split(src, TEXT_MAX)) {
      const end = line + source.split('\n').length - 1
      const parts: Part[] = [{ kind: 'code', source, path, startLine: line }]
      units.push({ level: 0, title: '', slug: '', line, end, plain: source.toLowerCase(), blocks: [{ line, end, first: '', hash: hashOf(source), parts }] })
      line = end + 1
    }
    return { units, pages: paginate(units.map(u => u.plain.length), PAGE_MAX), lines: lineCount(src) }
  }

  const units: Unit[] = []
  for (const s of sections(src)) {
    const blocks: Block[] = []
    for (const b of blocksOf(s.text, s.line)) {
      const parts = await sectionParts($, b.text, path)
      const first = [...(b.text.split('\n').find(l => l.trim())?.trim().replace(/\s+/g, ' ') ?? '')]
      const begins = first.length > 40 ? `${first.slice(0, 40).join('')}…` : first.join('')
      if (parts.length) blocks.push({ line: b.line, end: b.end, first: begins, hash: hashOf(b.text), parts })
    }
    units.push({ level: s.level, title: plainTitle(s.title), slug: s.slug, line: s.line, end: 0, plain: s.text.toLowerCase(), blocks })
  }
  const lines = lineCount(src)
  units.forEach((u, i) => (u.end = (units[i + 1]?.line ?? lines + 1) - 1))
  if (!units.length) units.push({ level: 0, title: '', slug: '', line: 1, end: 1, plain: '', blocks: [{ line: 1, end: 1, first: '', hash: '', parts: [{ kind: 'md', text: '*(empty file)*', hrefs: [] }] }] })
  const size = (u: Unit) =>
    u.blocks.flatMap(b => b.parts).reduce((n, p) => n + (p.kind === 'md' ? p.text.length : p.kind === 'code' ? p.source.length : p.kind === 'raster' ? p.cells.length : 100), 0)
  return { units, pages: paginate(units.map(size), PAGE_MAX), lines }
}

// The file as the pane draws it, parsed once per change on disk and width.
async function load($: EngineInterface, path: string): Promise<View> {
  await homeDir($)
  const st = await $.fs.stat(path).catch(() => null)
  if (st?.kind !== 'file') return note(`Can't find ${tilde(path)}.`)
  const key = `${path}|${st.mtimeMs}|${paneColumns}`
  const hit = views.get(key)
  if (hit) return hit
  const view = await build($, path)
  views.set(key, view)
  if (views.size > 8) views.delete(views.keys().next().value!)
  return view
}

async function openPane($: EngineInterface, path: string): Promise<string> {
  // No placement takes the whole screen: ask the dock for all of it, and the engine leaves the transcript its narrowest strip.
  const pane = { id: PANE, title: basename(path), focus: true as const, closeOnEscape: true as const }
  const opened = await $.ui.open(columns ? { ...pane, columns } : pane).catch(() => $.ui.open(pane))
  isOpen = true
  return opened.isPlaced ? 'shown' : `waiting: ${opened.reason}`
}

// Brings an element of the pane into view (null: its top), retrying while a pane just opened is not drawn yet.
async function scrollTo($: EngineInterface, key: string | null) {
  try {
    for (let n = 0; n < 8; n++) {
      const r = await $.ui.scroll({ in: PANE, to: key ? { key } : 'start', block: 'start' }).catch((err: unknown) => ({ deny: String(err) }))
      if (!r.deny) return
      await $.clock.sleep(80)
    }
  } catch {
    // the module reloaded or the dispatch ended: the pane stays where it is
  }
}

// Shows `page` of the file with `target` brought into view; the scroll runs on without holding up the caller.
async function moveTo($: EngineInterface, page: number, target: string | null) {
  await update($, doc, x => (x ? { ...x, page, target } : x))
  void scrollTo($, target)
}

async function goUnit($: EngineInterface, i: number) {
  const d = await read($, doc)
  if (!d) return
  const v = await load($, d.path)
  if ('note' in v) return
  await update($, toc, () => false)
  await moveTo($, v.pages[i] ?? 0, keyOf(i, 0))
}

async function show($: EngineInterface, ref: Ref | null): Promise<string> {
  if (!ref) return 'no file'
  // Open first, before any await: only an open made while the person's click or command is being answered is
  // placed at any width; one made later counts as the plugin's own and waits below 144 columns.
  const opening = openPane($, ref.abs)
  const d = await read($, doc)
  const isNew = d?.path !== ref.abs
  if (isNew) {
    await update($, doc, x => ({ path: ref.abs, page: 0, target: null, back: x ? [...x.back, x.path].slice(-30) : [] }))
    await update($, find, () => null)
    await update($, edit, () => null)
    await update($, toc, () => false)
  }
  const placed = await opening
  const v = ref.frag ? await load($, ref.abs) : null
  const i = v && !('note' in v) ? sectionAt(v.units, ref.frag) : null
  if (i !== null) await goUnit($, i)
  else if (isNew) void scrollTo($, null)
  return placed
}


// Warp's own Markdown viewer, split to the right as its "open file layout" setting says (a file:// URL would open a tab).
const warpUrl = (ref: Ref): string => {
  const line = /^L(\d+)$/i.exec(ref.frag)?.[1]
  return `warp://action/open_file_editor?path=${encodeURIComponent(ref.abs)}${line ? `&line=${line}` : ''}`
}

// Opens a file where `mode` says: the pane, Warp's own viewer beside the session, or the app macOS opens it with; when
// either of the last two cannot, the pane. Says where it went. For the pane, the open starts before any await (see show).
async function openRef($: EngineInterface, ref: Ref, mode: Mode): Promise<string> {
  // `open` launches whatever it is handed (a .command runs, a .app starts): the app takes markdown files only, judged
  // by where the path lands, not how it is spelled, so a link named `x.md` that leads to a script or an app goes to
  // the pane. `open` is then handed the landing path, so the link cannot be repointed between the check and the open.
  let abs = ref.abs
  if (mode === 'app') {
    const st = await $.fs.stat(ref.abs, { resolve: true }).catch(() => null)
    if (st?.kind === 'file' && st.realPath !== undefined && MD.test(st.realPath)) abs = st.realPath
    else mode = 'pane'
  }
  // lazy: the fallback opens the pane after `open` has answered, which on a narrow terminal counts as the mod's own
  // open and waits for room; checking for an app first (LaunchServices) would keep it the click's
  if (mode !== 'pane' && (await openWith($, [mode === 'warp' ? warpUrl(ref) : abs]))) return MODE_TEXT[mode]
  return `${MODE_TEXT.pane}, ${await show($, ref)}`
}

// A click on a path in the conversation, opened where this terminal's setting says.
function clickFrom($: EngineInterface) {
  return (link: { href: string }) => press($, refOf(link.href), modeHere())
}

// A click on a link: opened where `mode` says, and a toast when the pane has to wait or it fails. The promise goes
// back to the press, so the open is part of answering it.
function press($: EngineInterface, ref: Ref | null, mode: Mode = 'pane'): Promise<unknown> {
  if (!ref) return Promise.resolve()
  return openRef($, ref, mode)
    .then(where => where.includes('waiting') && $.ui.toast(`mdview: ${where}`))
    .catch((err: unknown) => $.ui.toast(`mdview: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)))
}

async function back($: EngineInterface) {
  const d = await read($, doc)
  const prev = d?.back.at(-1)
  if (!d || !prev) return
  await update($, doc, () => ({ path: prev, page: 0, target: null, back: d.back.slice(0, -1) }))
  await update($, find, () => null)
  await update($, edit, () => null)
  await update($, toc, () => false)
  await openPane($, prev)
  void scrollTo($, null)
}

// Hands a file or URL to macOS (`open`): the app it opens that kind with; false, after a toast, when that fails.
async function openWith($: EngineInterface, args: string[]): Promise<boolean> {
  const run = await $.process.run(['open', ...args], { timeoutMs: 10_000 }).catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
  if (run.exitCode === 0) return true
  $.ui.toast(`mdview: could not open it (${run.stderr.trim().slice(0, 120) || `exit ${run.exitCode}`})`)
  return false
}

// ✎ then Enter: the instruction goes to Claude as your own prompt, naming the file, the block's lines and how it begins;
// its progress shows under the block (see turn.start). A prompt that does not enter says why, and leaves no progress.
async function sendEdit($: EngineInterface, path: string, u: Unit, b: Block, instruction: string) {
  await update($, edit, () => null)
  const what = instruction.trim()
  if (!what) return
  const where = u.title ? ` in the section "${u.title}"` : ''
  const begins = b.first ? `, which begin "${b.first}"` : ''
  const text = `Edit lines ${b.line}-${b.end} of \`${tilde(path)}\`${where}${begins}: ${what}`
  const id = `${await $.clock.now()}-${b.hash}`
  // a block sent again replaces its earlier line; lazy: the five latest edits are shown, an older one drops
  const mine: MdviewPending = { id, path, line: b.line, hash: b.hash, text, turn: null, changed: false, done: null }
  await update($, pending, list => [...(list ?? []).filter(p => p.path !== path || p.hash !== b.hash), mine].slice(-5))
  const sent = await $.prompt.submit({ text, asUser: true }).catch((err: unknown) => ({ drop: err instanceof Error ? err.message : String(err) }))
  if (sent.drop === undefined) return
  await update($, pending, list => (list ?? []).filter(p => p.id !== id))
  $.ui.toast(`mdview: not sent (${sent.drop})`.slice(0, 200))
}

// Enter in the find bar: the next section holding the text, wrapping around; a new text starts from the first.
async function findNext($: EngineInterface, query: string) {
  const d = await read($, doc)
  const q = query.trim()
  if (!d) return
  const v = await load($, d.path)
  if (!q || 'note' in v) return void (await update($, find, () => ({ query: q, at: 0, hits: 0 })))
  const hits = v.units.flatMap((u, i) => (u.plain.includes(q.toLowerCase()) ? [i] : []))
  const prev = await read($, find)
  const at = prev && prev.query === q && hits.length ? (prev.at + 1) % hits.length : 0
  await update($, find, () => ({ query: q, at, hits: hits.length }))
  const hit = hits[at]
  if (hit !== undefined) await goUnit($, hit)
}

export const register: Register = (on, options) => {
  for (const where of ['warp', 'other'] as const) {
    const { key, choices } = SETTING[where]
    modes[where] = asMode((options as Record<string, unknown> | undefined)?.[key], choices, choices[0]!)
  }
  on('session.start', async ($, e, next) => {
    await homeDir($)
    await remember($, e.cwd)
    // As Claude Code decides it: kitty or Ghostty, or forced on (iTerm2 3.7 draws kitty pictures; Warp can't place them)
    const forced = (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? ''
    pictures =
      (forced !== '' && !/^(0|false|no|off)$/i.test(forced)) ||
      /kitty/i.test((await $.env.get('TERM')) ?? '') ||
      /ghostty/i.test((await $.env.get('TERM_PROGRAM')) ?? '') ||
      !!(await $.env.get('KITTY_WINDOW_ID'))
    isWarp = (await $.env.get('TERM_PROGRAM')) === 'WarpTerminal'
    tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '') || '/tmp'
    await $.command.register({ name: 'md', description: 'Show a file rendered in a side pane; `mode` switches what a click opens', argumentHint: '<path>[#heading|:line] | mode [warp|pane|app]' })
    await $.tool.register({
      name: 'show',
      description:
        'Open a local file in the mdview side pane for the person to read: markdown rendered, any other text file as highlighted code. Use when the person asks to see, open or preview a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute, ~ or working-directory-relative path; may end in #heading or :line' } },
        required: ['path'],
      },
    })
    // Redraw the pane when its file changes on disk, and let an edit's line go a few seconds after its turn ended
    // (here rather than in a timer of its own, which a reload would cancel: this one starts again with the mod).
    let seen = -1
    $.clock.every(1_500, async () => {
      const sent = await read($, pending)
      if (sent.some(p => p.done !== null)) {
        const now = await $.clock.now()
        const isOver = (p: MdviewPending) => p.done !== null && now - p.done >= 5_000
        if (sent.some(isOver)) await update($, pending, list => (list ?? []).filter(p => !isOver(p)))
      }
      const d = isOpen ? await read($, doc) : null
      if (!d) return
      const m = (await $.fs.stat(d.path).catch(() => null))?.mtimeMs ?? -1
      if (m !== seen) {
        seen = m
        await update($, rev, () => m)
      }
    })
    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    await remember($, e.new_cwd)
    return next(e)
  })

  // A markdown file Claude just wrote: links to it appear, and the pane showing it redraws, at once. Written while an
  // edit from ✎ on that file runs, it is that edit's change.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const file = (e as { file_path?: unknown }).file_path
    if ((e.tool === 'Write' || e.tool === 'Edit') && typeof file === 'string') {
      if (MD.test(file) || (isOpen && (await read($, doc))?.path === file)) $.ui.invalidate('ui.render')
      const isRunning = (p: MdviewPending) => p.path === file && p.turn !== null && p.done === null && !p.changed
      if (!result.deny && !result.isError && (await read($, pending)).some(isRunning))
        await update($, pending, list => (list ?? []).map(p => (isRunning(p) ? { ...p, changed: true } : p)))
    }
    return result
  })

  on('tool.call', { tool: 'mcp__mdview__show' }, async ($, e) => {
    const arg = String((e as { path?: unknown }).path ?? '').trim()
    const ref = resolveRef(arg, await $.session.cwd(), await homeDir($), { anyExt: true })
    const st = ref ? await $.fs.stat(ref.abs).catch(() => null) : null
    if (!ref || st?.kind !== 'file') return { result: `No such file: ${arg}` }
    try {
      // the model's tool views only: Warp's viewer or the pane, never the app (see openRef)
      return { result: `${tilde(ref.abs)}: opened in ${await openRef($, ref, isWarp ? 'warp' : 'pane')}` }
    } catch (err) {
      return { result: `Could not open it: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('command.run', { command: 'md' }, async ($, e) => {
    const arg = e.args.trim().replace(/^(['"`])(.*)\1$/, '$2')
    // `/md mode [choice]`: the click setting of this terminal, as /config sets it (stored; the mod reloads with it).
    // A file of that name wins.
    const mode = /^mode(?:\s+(\S+))?$/.exec(arg)
    const named = mode ? resolveRef(arg, await $.session.cwd(), await homeDir($), { anyExt: true }) : null
    if (mode && (!named || (await $.fs.stat(named.abs).catch(() => null))?.kind !== 'file')) {
      const { key, choices } = SETTING[here()]
      const now = modeHere()
      const want = mode[1] ?? choices[(choices.indexOf(now) + 1) % choices.length]!
      if (!(choices as string[]).includes(want)) return { text: `Usage: /md mode [${choices.join('|')}]` }
      if (want === now) return { text: `A click on a path already opens ${MODE_TEXT[now]} (${key}: ${now})` }
      const set = await $.config.set({ key: `mdview.${key}`, value: want }).catch((err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }))
      if (set.deny !== undefined) return { text: `Could not switch: ${set.deny}` }
      const got = asMode(set.value, choices, now)
      modes[here()] = got
      return { text: `A click on a path now opens ${MODE_TEXT[got]} (${key}: ${got})` }
    }
    if (!arg) {
      const d = await read($, doc)
      if (!d) return { text: 'Usage: /md <path>[#heading|:line]' }
      await openPane($, d.path)
      return { text: `Showing ${tilde(d.path)}` }
    }
    const ref = resolveRef(arg, await $.session.cwd(), await homeDir($), { anyExt: true })
    const st = ref ? await $.fs.stat(ref.abs).catch(() => null) : null
    if (!ref || st?.kind !== 'file') return { text: `No such file: ${arg}` }
    await show($, ref)
    return { text: `Showing ${tilde(ref.abs)}` }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE && !(result && 'deny' in result && result.deny)) {
      isOpen = false
      await update($, toc, () => false)
      await update($, find, () => null)
      await update($, edit, () => null)
    }
    return result
  })

  // A reply that names .md files: drawn as the engine draws it, with those paths a click away.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    columns = Math.max(columns, e.viewport?.columns ?? 0)
    // Clicks reach a plugin only in the fullscreen terminal; elsewhere the engine's own drawing stays.
    if (e.surface !== 'terminal' || !e.viewport?.isFullscreen || !MAYBE_MD.test(e.props.text)) return next(e)
    const now = await $.session.cwd()
    if (!cwdOf.has(e.requestId)) cwdOf.set(e.requestId, now)
    const linked = await linkFiles($, e.props.text, [...new Set([cwdOf.get(e.requestId)!, now, ...(await read($, cwdHistory))])])
    if (!linked) return next(e)
    const { Box, Markdown, Text } = $.ui.resolve(e)
    const follow = clickFrom($)
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box minWidth={2}>
          <Text>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {split(linked.text, TEXT_MAX).map((text, i) => {
            const hrefs = linked.hrefs.filter(h => text.includes(`](${h})`)).slice(0, 256)
            return hrefs.length ? (
              <Markdown key={`r${i}`} text={text} pressableLinks={hrefs} onLinkPress={follow} />
            ) : (
              <Markdown key={`r${i}`} text={text} />
            )
          })}
        </Box>
      </Box>
    )
  })

  // A tool row that read or wrote a markdown file: the engine's own row, with a line under it that opens the file here.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const file = (e.props.input as { file_path?: unknown } | null)?.file_path
    const isMdTool = ['Read', 'Write', 'Edit'].includes(e.props.tool) && typeof file === 'string' && MD.test(file)
    if (e.surface !== 'terminal' || !e.viewport?.isFullscreen || !isMdTool || e.props.isRunning || e.props.isErrored) return next(e)
    const st = await $.fs.stat(file).catch(() => null)
    if (st?.kind !== 'file') return next(e)
    const href = hrefOf({ abs: file, frag: '' })
    const { Box, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box paddingLeft={2}>
          <Markdown key="open" dimColor text={`⎿  [${tilde(file)}${MARK}](${href})`} pressableLinks={[href]} onLinkPress={clickFrom($)} />
        </Box>
      </Box>
    )
  })

  // A prompt of yours naming markdown files: your own row, with a line under it that opens them here.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !e.viewport?.isFullscreen || e.props.origin.kind !== 'composer' || !MAYBE_MD.test(e.props.text)) return next(e)
    const now = await $.session.cwd()
    if (!cwdOf.has(e.requestId)) cwdOf.set(e.requestId, now)
    const linked = await linkFiles($, e.props.text, [...new Set([cwdOf.get(e.requestId)!, now, ...(await read($, cwdHistory))])])
    if (!linked) return next(e)
    const hrefs = linked.hrefs.slice(0, 20)
    const { Box, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box paddingLeft={2}>
          <Markdown
            key="open"
            dimColor
            text={`⎿  ${hrefs.map(h => `[${tilde(refOf(h)?.abs ?? h)}${MARK}](${h})`).join(' · ')}`}
            pressableLinks={hrefs}
            onLinkPress={clickFrom($)}
          />
        </Box>
      </Box>
    )
  })

  // The turn that runs an edit sent from ✎: the one that starts with its prompt, waiting until then behind any other.
  // lazy: a prompt another plugin rewrites before it enters is never matched and reads "waiting" until five newer
  // edits push it out; matching the text that entered (a prompt.submit hook beneath the others) would find it
  on('turn.start', async ($, e, next) => {
    const p = (await read($, pending)).find(x => x.turn === null && e.text.includes(x.text))
    if (p) await update($, pending, list => (list ?? []).map(x => (x.id === p.id ? { ...x, turn: e.turnId } : x)))
    return next(e)
  })

  // That turn ended: its edit reads as Updated or No changes made, and goes a few seconds later (see the poll).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, pending)).some(p => p.turn === e.turnId)) {
      const now = await $.clock.now()
      await update($, pending, list => (list ?? []).map(p => (p.turn === e.turnId ? { ...p, done: now } : p)))
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isOpen = true
    paneColumns = e.props.bodyColumns || paneColumns
    const { Box, Button, Code, Markdown, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input
    const Image = e.surface === 'terminal' ? $.ui.resolve(e).Image : null
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : null
    const d = await read($, doc)
    await read($, rev) // subscribes: a change on disk redraws
    const isTocOpen = await read($, toc)
    const f = await read($, find)
    const ed = await read($, edit)
    const sent = await read($, pending)
    // a ⎿ line, as Claude Code hangs a result under its row
    const hang = (body: RenderNode, key: string) => (
      <Box key={key} flexDirection="row">
        <Text dimColor>{'⎿  '}</Text>
        {body}
      </Box>
    )
    if (!d) return hang(<Text dimColor>{'Click a .md path in the conversation, or run /md <path>'}</Text>, 'empty')

    const v = await load($, d.path)
    const units = 'note' in v ? [] : v.units
    const pages = 'note' in v ? [0] : v.pages
    const pageCount = (pages.at(-1) ?? 0) + 1
    const page = Math.min(d.page, pageCount - 1)
    const heads = units.flatMap((u, i) => (u.level > 0 ? [{ u, i }] : []))
    const follow = (link: { href: string }) => press($, refOf(link.href))
    // the section in view: the one last jumped to, else the first on this page
    const inView = Number(/^u(\d+)/.exec(d.target ?? '')?.[1] ?? pages.indexOf(page))
    // The block the edit bar is on, and the one an edit was sent from: the block with the same text, nearest where it
    // was, since the file may have changed above it; a block whose text is gone has no bar (it closes rather than move).
    // lazy: two blocks of identical text are told apart by the nearer line only; harmless, as either holds that text
    const locate = (where: { path: string; line: number; hash: string } | null, nearest = false) => {
      let at: { i: number; k: number } | null = null
      let gap = Infinity
      if (where?.path !== d.path) return at
      for (const [i, u] of units.entries())
        for (const [k, b] of u.blocks.entries()) {
          if ((!nearest && b.hash !== where.hash) || Math.abs(b.line - where.line) >= gap) continue
          gap = Math.abs(b.line - where.line)
          at = { i, k }
        }
      return at
    }
    const editAt = locate(ed)
    // Each edit sent from ✎, as a line under its block: found by its text until Claude wrote the file, then the block
    // now at its lines.
    const progress = sent.flatMap(p => {
      const at = p.changed ? locate(p, true) : (locate(p) ?? locate(p, true))
      if (!at) return []
      const body =
        p.done === null ? (
          <Text color="claude">{p.turn ? '✶ Claude is editing…' : '✶ Waiting for Claude…'}</Text>
        ) : p.changed ? (
          <Text color="success">Updated</Text>
        ) : (
          <Text dimColor>No changes made</Text>
        )
      return [{ ...at, line: hang(body, `progress-${p.id}`) }]
    })

    // The keys, as Claude Code's own panels list theirs: one dim row, each a click away.
    const keys = [
      d.back.length > 0 && <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => back($)} />,
      heads.length > 1 && <Button key="toc" plain dimColor hotkey="t" label="contents" onPress={() => update($, toc, x => !x)} />,
      Input && units.length > 0 && <Button key="find-toggle" plain dimColor hotkey="f" label="find" onPress={() => update($, find, x => (x ? null : { query: '', at: 0, hits: 0 }))} />,
      page > 0 && <Button key="prev" plain dimColor hotkey="p" label="previous part" onPress={() => moveTo($, page - 1, null)} />,
      page < pageCount - 1 && <Button key="next" plain dimColor hotkey="n" label="next part" onPress={() => moveTo($, page + 1, null)} />,
      isWarp && <Button key="warp" plain dimColor hotkey="w" label="Warp" onPress={() => openWith($, [warpUrl({ abs: d.path, frag: '' })])} />,
      <Button key="close" plain dimColor role="dismiss" hotkey="q" label="close" onPress={() => $.ui.close({ id: PANE })} />,
    ].filter(Boolean)
    // items in a dim row, a dot between each
    const dotted = <T,>(items: readonly T[], key: string) => items.flatMap((k, i) => (i ? [<Text key={`${key}${i}`} dimColor>·</Text>, k] : [k]))
    const dir = dirname(d.path)
    const meta =
      'note' in v
        ? ''
        : `${v.lines ? ` · ${v.lines} line${v.lines === 1 ? '' : 's'}` : ''}${heads.length ? ` · ${heads.length} section${heads.length === 1 ? '' : 's'}` : ''}`

    const draw = (p: Part, key: string) => {
      if (p.kind === 'code') return <Code key={key} source={p.source} path={p.path} startLine={p.startLine} wrap="wrap" />
      if (p.kind === 'raster')
        return Raster ? (
          <Box key={`${key}-box`} flexDirection="column" alignItems="flex-start">
            <Raster key={key} cells={p.cells} columns={p.columns} rows={p.rows} />
            <Button key={`${key}-original`} plain dimColor label="⎿  open the original" onPress={() => openWith($, [p.file])} />
          </Box>
        ) : (
          <Text key={key} dimColor>{`[picture: ${p.alt}]`}</Text>
        )
      if (p.kind === 'img')
        return Image ? (
          <Image key={key} source={{ file: p.file, format: 'png' }} columns={p.columns} rows={p.rows} alt={p.alt} />
        ) : (
          <Text key={key} dimColor>{`[picture: ${p.alt}]`}</Text>
        )
      return p.hrefs.length ? (
        <Markdown key={key} text={p.text} pressableLinks={p.hrefs} onLinkPress={follow} />
      ) : (
        <Markdown key={key} text={p.text} />
      )
    }

    // a part boundary, as a dim rule
    const rule = (text: string, key: string) => (
      <Text key={key} dimColor wrap="truncate-end">
        {`── ${text} ${'─'.repeat(Math.max(0, paneColumns - text.length - 4))}`}
      </Text>
    )

    return (
      <Box flexDirection="column">
        {/* the file, as Claude Code names one in its rows: ⏺ name, then where and how big, dim */}
        <Box flexDirection="row">
          <Text>{'⏺ '}</Text>
          <Text bold>{basename(d.path)}</Text>
          <Text dimColor wrap="truncate-start">{`  ${tilde(dir)}${meta}`}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginBottom={1}>
          {dotted(keys, 'dot')}
        </Box>
        {f && Input && (
          // the find row, as Claude Code's history search reads: search: <text>  2/5
          <Box flexDirection="row" gap={1} marginBottom={1}>
            <Box flexGrow={1}>
              <Input key="find" label="search:" placeholder="text in this file" value={f.query} submitLabel="next" autoFocus onSubmit={q => findNext($, q)} />
            </Box>
            {f.query !== '' && <Text dimColor>{f.hits ? `${f.at + 1}/${f.hits}` : 'no match'}</Text>}
          </Box>
        )}
        {isTocOpen && (
          // the contents, as Claude Code's own menus list: the section in view marked, a row lights while hovered
          <Box flexDirection="column" marginBottom={1}>
            {heads.slice(0, 200).map(({ u, i }) => (
              <Box key={`tocrow-${i}`} flexDirection="row">
                <Text color="suggestion">{i === inView ? '› ' : '  '}</Text>
                <Button
                  key={`toc-${i}`}
                  plain
                  hover={{ color: 'suggestion' }}
                  label={`${'  '.repeat(u.level - 1)}${u.title}`.slice(0, Math.max(10, paneColumns - 4))}
                  onPress={() => goUnit($, i)}
                />
              </Box>
            ))}
          </Box>
        )}
        {pageCount > 1 && page > 0 && rule(`part ${page + 1} of ${pageCount}`, 'rule-top')}
        {'note' in v && hang(<Markdown key="note" text={v.note} />, 'note')}
        {units.flatMap((u, i) => {
          if (pages[i] !== page) return []
          const firstPart = u.blocks.map((_, k) => u.blocks.slice(0, k).reduce((n, b) => n + b.parts.length, 0))
          return [
            // a blank line between sections and between blocks, as the file itself reads
            <Box key={`sec${i}`} flexDirection="column" marginTop={pages.indexOf(page) === i ? 0 : 1}>
              {u.blocks.map((b, k) => (
                // each block a hover scope: while the pointer is over it, it takes the background Claude Code gives
                // your own prompts, and shows its ✎
                <Box key={`blk${i}-${k}`} flexDirection="column" marginTop={k ? 1 : 0} hover={{ backgroundColor: 'userMessageBackground' }}>
                  {editAt?.i === i && editAt.k === k && Input && (
                    // a small prompt to Claude: its border, its ">", and the keys under it
                    <Box flexDirection="column" marginBottom={1}>
                      <Box borderStyle="round" borderColor="promptBorder" paddingX={1}>
                        <Input
                          key="edit-input"
                          label=">"
                          placeholder={`what to change in lines ${b.line}-${b.end}`}
                          submitLabel="send"
                          autoFocus
                          onSubmit={text => sendEdit($, d.path, u, b, text)}
                        />
                      </Box>
                      <Box flexDirection="row" columnGap={1} paddingLeft={2}>
                        <Text dimColor>enter to send to Claude ·</Text>
                        <Button key="edit-cancel" plain dimColor label="cancel" onPress={() => update($, edit, () => null)} />
                      </Box>
                    </Box>
                  )}
                  {b.parts.map((p, m) => draw(p, keyOf(i, firstPart[k]! + m)))}
                  {progress.filter(x => x.i === i && x.k === k).map(x => x.line)}
                  {Input && (
                    <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }}>
                      <Button key={`edit-${i}-${k}`} plain dimColor label="✎" onPress={() => update($, edit, () => ({ path: d.path, line: b.line, hash: b.hash }))} />
                    </Box>
                  )}
                </Box>
              ))}
            </Box>,
          ]
        })}
        {pageCount > 1 && (
          // the end of a part: where it stands, and the way to either neighbor
          <Box flexDirection="row" columnGap={1} marginTop={1}>
            {dotted(
              [
                <Text key="end-part" dimColor>{`── part ${page + 1} of ${pageCount}`}</Text>,
                page > 0 && <Button key="prev-end" plain dimColor label="↑ previous part" onPress={() => moveTo($, page - 1, null)} />,
                page < pageCount - 1 ? (
                  <Button key="next-end" plain dimColor label="next part ↓" onPress={() => moveTo($, page + 1, null)} />
                ) : (
                  <Text key="end" dimColor>end</Text>
                ),
              ].filter(Boolean),
              'enddot',
            )}
            <Text dimColor>──</Text>
          </Box>
        )}
      </Box>
    )
  })
}
