import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

import { blocksOf, bmpPixels, fitCells, halfBlocks, html, paginate, pngSize, sectionAt, sections, split, tables } from './doc'
import { hrefOf, linkify, refOf, resolveRef } from './links'

const PNG_640x480 = 'iVBORw0KGgoAAAANSUhEUgAAAoAAAAHgCAIAAAA='
// 2×2 24-bit BMPs, red green / blue white: rows stored top-down, and bottom-up
const BMP_TOP_DOWN = 'Qk1GAAAAAAAAADYAAAAoAAAAAgAAAP7///8BABgAAAAAABAAAAATCwAAEwsAAAAAAAAAAAAAAAD/AP8AAAD/AAD///8AAA=='
const BMP_BOTTOM_UP = 'Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAAATCwAAEwsAAAAAAAAAAAAA/wAA////AAAAAP8A/wAAAA=='
const bytesOf = (b64: string) => (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(b64)
const FULL = { columns: 160, rows: 40, isFullscreen: true }
const reply = (text: string, viewport: object = FULL, requestId = 'm1') =>
  ({ plugin: 'mdview', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true }, viewport }) as never
const PANE = {
  plugin: 'mdview', surface: 'terminal', component: 'Pane', requestId: 'mdview',
  props: { title: 'a.md', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: FULL,
} as never

type World = {
  files: Record<string, string | { bytes: string }>
  links: Record<string, string>
  dirs: string[]
  env: Record<string, string>
  runs: string[][]
  prompts: string[]
  configs: [string, unknown][]
  mtimes: Record<string, number>
  openFails?: boolean
  configAnswer?: { value: unknown } | { deny: string }
  cwd: string
  opened: string[]
  invalidated: number
  closed: number
  doc?: { page: number; target: string | null }
  clock?: MockClock
  dropPrompt?: string
}
const world = (files: World['files'], env: Record<string, string> = {}): World => ({ files, links: {}, dirs: [], env, cwd: '/w', runs: [], prompts: [], configs: [], mtimes: {}, opened: [], invalidated: 0, closed: 0 })

// The engine beneath a started session: a tiny file system, the working directory, and the pane calls.
const start = async ($: { session: { start: (e: never) => Promise<unknown> } }, on: On, w: World) => {
  w.clock = mock.clock(on)
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : w.env[e.name] }) as never)
  // sips: a picture's size, or a conversion written where --out says (a 2×2 BMP stands for every picture)
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    const out = e.argv[e.argv.indexOf('--out') + 1]
    if (e.argv.includes('--out') && out) w.files[out] = { bytes: BMP_TOP_DOWN }
    if (e.argv[0] === 'open' && w.openFails) return { value: { exitCode: 1, stdout: '', stderr: 'No application knows how to open it.', isStdoutTruncated: false, isStderrTruncated: false } } as never
    const stdout = e.argv.includes('-g') ? 'x\n  pixelWidth: 100\n  pixelHeight: 50\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.cwd', () => ({ value: w.cwd }) as never)
  // a symbolic link (`links`) is followed, as the engine does: the stat is of where it leads, a folder there `dir`
  on('fs.stat', ($, e) => {
    const real = w.links[e.path] ?? e.path
    const realPath = e.resolve ? { realPath: real } : {}
    const isLink = real !== e.path
    if (w.dirs.includes(real)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink, ...realPath } } as never
    const f = w.files[real]
    if (f === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: typeof f === 'string' ? f.length : 100, mtimeMs: w.mtimes[real] ?? 1, isLink, ...realPath } } as never
  })
  on('fs.read', ($, e) => {
    const f = w.files[e.path]
    if (f === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: typeof f === 'string' ? f : { base64: f.bytes } } as never
  })
  on('prompt.submit', ($, e) => (w.prompts.push(e.text), w.dropPrompt ? { drop: w.dropPrompt } : { text: e.text }) as never)
  on('config.set', ($, e) => (w.configs.push([e.key, e.value]), w.configAnswer ?? { value: e.value }) as never)
  on('command.register', () => ({ value: { command: 'md' } }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__mdview__show' } }) as never)
  on('ui.open', ($, e) => (w.opened.push(e.title ?? e.id), { value: { isPlaced: true } }) as never)
    on('ui.close', () => (w.closed++, { value: undefined }))
  on('state.set', ($, e, next) => {
    if (e.plugin === 'mdview' && e.key === 'doc') w.doc = e.value as World['doc']
    return next(e)
  })
  on('ui.invalidate', () => (w.invalidated++, { value: undefined }) as never)
  on('tool.call', () => ({ result: { type: 'create', filePath: '/w/new.md', content: '' } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }) as never)
  // the engine's own drawings
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }) as never)
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'engine', ref: 0 }) as never)
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'engine', ref: 0 }) as never)
  await $.session.start({ cwd: w.cwd, surface: null, isInteractive: true } as never)
}

describe('links', () => {
  test('references resolve with their heading or line', () => {
    expect(resolveRef('x.md', '/w', '/home/u')).toEqual({ abs: '/w/x.md', frag: '' })
    expect(resolveRef('~/notes/a.md:12', '/w', '/home/u')).toEqual({ abs: '/home/u/notes/a.md', frag: 'L12' })
    expect(resolveRef('../docs/./b.md#setup', '/w/sub', '/home/u')).toEqual({ abs: '/w/docs/b.md', frag: 'setup' })
    expect(resolveRef('file:///w/My%20Doc.md', '/w', '/home/u')).toEqual({ abs: '/w/My Doc.md', frag: '' })
    expect(resolveRef('#intro', '/w', '/home/u', { self: '/w/a.md' })).toEqual({ abs: '/w/a.md', frag: 'intro' })
    expect(resolveRef('#intro', '/w', '/home/u')).toBeNull()
    expect(resolveRef('https://x.com/a.md', '/w', '/home/u')).toBeNull()
    expect(resolveRef('src/a.ts', '/w', '/home/u')).toBeNull()
    expect(resolveRef('src/a.ts', '/w', '/home/u', { anyExt: true })?.abs).toBe('/w/src/a.ts')
    const odd = { abs: '/w/Star Trek/a (1)#x.md', frag: '安装 步骤' }
    expect(refOf(hrefOf(odd))).toEqual(odd)
    expect(hrefOf(odd)).not.toMatch(/[ ()]/)
  })

  test('linkify: code spans, links, bare paths and Chinese-adjacent paths; URLs, images and fences stay', () => {
    const ok = new Set(['/w/README.md', '/home/u/a.md', '/w/docs/b.md'])
    const link = (raw: string) => {
      const r = resolveRef(raw, '/w', '/home/u')
      return r && ok.has(r.abs) ? hrefOf(r) : null
    }
    const text = [
      'See `~/a.md:3`, README.md. and [the doc](docs/b.md#x) or `missing.md`.',
      '见README.md文件 https://github.com/x/README.md ![pic](docs/b.md)',
      '```',
      'cat README.md',
      '```',
    ].join('\n')
    expect(linkify(text, link, '↗')).toBe(
      [
        'See [`~/a.md:3`↗](file:///home/u/a.md#L3), [README.md↗](file:///w/README.md). and [the doc↗](file:///w/docs/b.md#x) or `missing.md`.',
        '见[README.md↗](file:///w/README.md)文件 https://github.com/x/README.md ![pic](docs/b.md)',
        '```',
        'cat README.md',
        '```',
      ].join('\n'),
    )
  })
})

describe('doc', () => {
  test('HTML becomes markdown outside code; tables keep their rows', () => {
    const src = [
      '<!-- hidden --><details><summary>More</summary>',
      'Body<br>next <b>bold</b> <a href="x.md">x</a> <img src="a b.png" alt="pic">',
      '</details>',
      '| a | b<br>c |',
      '`<b>kept</b>`',
      '```',
      '<br>',
      '```',
    ].join('\n')
    expect(html(src)).toBe(
      ['**▸ More**', '', 'Body  ', 'next **bold** [x](x.md) ![pic](a%20b.png)', '', '| a | b · c |', '`<b>kept</b>`', '```', '<br>', '```'].join('\n'),
    )
  })

  test('a table that cannot fit becomes records; one that can stays', () => {
    const t = '| Name | Notes |\n|---|---|\n| alpha | a-very-long-unbreakable-word |\n| beta | short |'
    expect(tables(t, 80)).toBe(t)
    expect(tables(t, 20)).toBe('**alpha**\n- **Notes**: a-very-long-unbreakable-word\n\n**beta**\n- **Notes**: short\n')
  })

  test('sections: front matter, GitHub slugs, headings in fences ignored, lines kept', () => {
    const secs = sections('---\nname: x\n---\nintro\n# Setup\n```\n# not a heading\n```\n## 安装 步骤\n# Setup\ntext')
    expect(secs.map(s => [s.level, s.slug, s.line])).toEqual([
      [0, '', 1],
      [0, '', 4],
      [1, 'setup', 5],
      [2, '安装-步骤', 9],
      [1, 'setup-1', 10],
    ])
    expect(secs[0]!.text).toBe('```yaml\nname: x\n```')
    expect(sectionAt(secs, 'setup-1')).toBe(4)
    expect(sectionAt(secs, '安装 步骤')).toBe(3)
    expect(sectionAt(secs, 'L7')).toBe(2)
    expect(sectionAt(secs, 'nope')).toBeNull()
  })

  test('split keeps pieces under the cap: blank lines first, a long fence closed and reopened, a table header repeated', () => {
    const short = 'a\n\nb'
    expect(split(short, 100)).toEqual([short])
    const fence = ['```ts', ...Array.from({ length: 30 }, (_, i) => `line ${i}`), '```'].join('\n')
    const fenced = split(fence, 120)
    expect(fenced.length).toBeGreaterThan(1)
    expect(fenced.every(p => p.length <= 120 && p.startsWith('```ts\n') && p.endsWith('\n```'))).toBe(true)
    const table = ['| a | b |', '|---|---|', ...Array.from({ length: 30 }, (_, i) => `| ${i} | x |`)].join('\n')
    expect(split(table, 100).every(p => p.startsWith('| a | b |\n|---|---|\n') && p.length <= 100)).toBe(true)
    expect(paginate([50, 50, 50, 10], 100)).toEqual([0, 0, 1, 1])
  })

  test('blocks keep the file lines they span; a fence stays whole across its blank lines', () => {
    expect(blocksOf('# T\n\npara one\nstill one\n\n```\na\n\nb\n```\n\n- x', 10)).toEqual([
      { text: '# T', line: 10, end: 10 },
      { text: 'para one\nstill one', line: 12, end: 13 },
      { text: '```\na\n\nb\n```', line: 15, end: 19 },
      { text: '- x', line: 21, end: 21 },
    ])
  })

  test('a PNG size comes from its header', () => {
    expect(pngSize(PNG_640x480)).toEqual({ width: 640, height: 480 })
    expect(pngSize('aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=')).toBeNull()
  })
})

test('a reply links existing .md files; a click opens the pane; links inside jump to headings; Back returns', async ($, on) => {
  const w = world({
    '/w/README.md': '---\nname: r\n---\n# Read me\n\nNext: [guide](docs/guide.md#usage) and [top](#read-me)',
    '/w/docs/guide.md': '# Guide\n\nintro\n\n## Usage\n\nrun it',
  })
  await start($, on, w)

  const ui = await $.ui.mount(reply('Wrote `README.md` and `nope.md`.'))
  const md = await ui.find({ type: 'Markdown', key: 'r0' })
  expect(md?.props.text).toBe('Wrote [`README.md`↗](file:///w/README.md) and `nope.md`.')
  expect(md?.props.pressableLinks).toEqual(['file:///w/README.md'])
  expect(await ui.find({ type: 'Text', text: '⏺' })).toBeDefined()

  await ui.press({ key: 'r0', link: { href: 'file:///w/README.md' } })
  expect(w.opened.at(-1)).toBe('README.md')

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Markdown', key: 'u0' }))?.props.text).toBe('```yaml\nname: r\n```')
  expect((await pane.find({ type: 'Markdown', key: 'u1' }))?.props.text).toBe('# Read me') // a block each
  expect((await pane.find({ type: 'Markdown', key: 'u1-1' }))?.props.text).toBe(
    'Next: [guide↗](file:///w/docs/guide.md#usage) and [top↗](file:///w/README.md#read-me)',
  )
  expect(await pane.find({ key: 'back' })).toBeUndefined()

  await pane.press({ key: 'u1-1', link: { href: 'file:///w/docs/guide.md#usage' } })
  expect(w.opened.at(-1)).toBe('guide.md')
  expect((await pane.find({ type: 'Markdown', key: 'u1' }))?.props.text).toBe('## Usage')
  expect((await pane.find({ type: 'Markdown', key: 'u1-1' }))?.props.text).toBe('run it')
  expect(w.doc?.target).toBe('u1')

  await pane.press({ key: 'back' })
  expect(w.opened.at(-1)).toBe('README.md')
  expect(w.doc?.target).toBeNull()
  expect(await pane.find({ key: 'back' })).toBeUndefined()

  await pane.press({ key: 'close' })
  expect(w.closed).toBe(1)
  await pane.unmount()
  await ui.unmount()
})

test('relative paths resolve against earlier working directories, and Chinese text may run into a path', async ($, on) => {
  const w = world({ '/w/notes.md': '# N' })
  await start($, on, w)
  w.cwd = '/x'
  const ui = await $.ui.mount(reply('见notes.md文件'))
  expect((await ui.find({ type: 'Markdown', key: 'r0' }))?.props.text).toBe('见[notes.md↗](file:///w/notes.md)文件')
  await ui.unmount()
})

test('outside the fullscreen terminal, or with no existing .md, the engine draws the reply', async ($, on) => {
  const w = world({ '/w/README.md': '# R' })
  await start($, on, w)
  for (const props of [reply('See `README.md`.', { ...FULL, isFullscreen: false }), reply('See `gone.md` and src/a.ts')]) {
    const ui = await $.ui.mount(props)
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
})

test('contents and find jump to sections; in Ghostty a PNG on its own line is the terminal\'s own picture', async ($, on) => {
  const w = world(
    {
      '/w/a.md': '# One\n\nalpha\n\n![shot](img/s.png)\n\n# Two\n\nbeta gamma\n\n# Three\n\ngamma again',
      '/w/img/s.png': { bytes: PNG_640x480 },
    },
    { TERM_PROGRAM: 'ghostty' },
  )
  await start($, on, w)
  await $.command.run({ command: 'md', args: 'a.md' } as never)
  const pane = await $.ui.mount(PANE)

  expect(await pane.find({ type: 'Text', text: 'a.md' })).toBeDefined() // the header names the file
  expect(await pane.find({ type: 'Text', text: /· 13 lines · 3 sections$/ })).toBeDefined()
  const img = await pane.find({ type: 'Image' })
  expect(img?.props).toMatchObject({ source: { file: '/w/img/s.png', format: 'png' }, columns: 78, rows: 29, alt: 'shot' })

  await pane.press({ key: 'toc' })
  expect(await pane.find({ key: 'toc-2', type: 'Button' })).toBeDefined()
  const row = async (i: number) => JSON.stringify((await pane.find({ key: `tocrow-${i}` }))?.children)
  expect([await row(0), await row(2)].map(r => r.includes('› '))).toEqual([true, false]) // the section in view is marked
  await pane.press({ key: 'toc-2' })
  expect(w.doc?.target).toBe('u2')
  expect(await pane.find({ key: 'toc-2' })).toBeUndefined() // contents fold after a jump

  await pane.press({ key: 'find-toggle' })
  const field = pane as unknown as { input: (t: { key: string; text: string }) => Promise<unknown> }
  await field.input({ key: 'find', text: 'GAMMA' })
  expect(w.doc?.target).toBe('u1')
  expect(await pane.find({ type: 'Text', text: '1/2' })).toBeDefined()
  await field.input({ key: 'find', text: 'GAMMA' })
  expect(w.doc?.target).toBe('u2')
  await pane.unmount()
})

test('a long file is paged; another file is shown as highlighted code from its line', async ($, on) => {
  const big = Array.from({ length: 12 }, (_, i) => `# Part ${i}\n\n${'word '.repeat(1_000)}`).join('\n\n')
  const w = world({ '/w/big.md': big, '/w/src/a.ts': 'const a = 1\n' })
  await start($, on, w)
  await $.command.run({ command: 'md', args: 'big.md' } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'next-end' }))?.props.label).toBe('next part ↓')
  expect(await pane.find({ key: 'prev-end' })).toBeUndefined()
  expect(await pane.find({ key: 'u11' })).toBeUndefined()
  await pane.press({ key: 'next' })
  expect(await pane.find({ key: 'u11' })).toBeDefined()
  expect(await pane.find({ key: 'u0' })).toBeUndefined()
  expect(await pane.find({ key: 'next-end' })).toBeUndefined() // the last part ends; the one before is a click away
  await pane.press({ key: 'prev-end' })
  expect(await pane.find({ key: 'u0' })).toBeDefined()

  expect(await $.command.run({ command: 'md', args: '"src/a.ts:1"' } as never)).toMatchObject({ text: 'Showing /w/src/a.ts' })
  const code = await pane.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ source: 'const a = 1\n', path: '/w/src/a.ts', startLine: 1 })
  expect(await $.command.run({ command: 'md', args: 'missing.md' } as never)).toMatchObject({ text: 'No such file: missing.md' })
  await pane.unmount()
})

test('writing a markdown file redraws the replies, so links to it appear', async ($, on) => {
  const w = world({})
  await start($, on, w)
  await $.tool.call({ tool: 'Write', file_path: '/w/new.md', content: '# New' } as never)
  expect(w.invalidated).toBe(1)
  await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: '' } as never)
  expect(w.invalidated).toBe(1)
})

test('a tool row that wrote a markdown file, and a prompt naming one, get a line that opens it', async ($, on) => {
  const w = world({ '/w/README.md': '# R' })
  await start($, on, w)
  const row = (tool: string, file_path: string, isRunning = false) =>
    ({
      plugin: 'mdview', surface: 'terminal', component: 'ToolUse', requestId: 't1', viewport: FULL,
      props: { tool_use_id: 't1', tool, input: { file_path, content: '' }, isRunning, isErrored: false, isInterrupted: false },
    }) as never
  const ui = await $.ui.mount(row('Write', '/w/README.md'))
  const open = await ui.find({ type: 'Markdown', key: 'open' })
  expect(open?.props).toMatchObject({ text: '⎿  [/w/README.md↗](file:///w/README.md)', pressableLinks: ['file:///w/README.md'] })
  await ui.press({ key: 'open', link: { href: 'file:///w/README.md' } })
  expect(w.opened.at(-1)).toBe('README.md')
  await ui.unmount()
  for (const props of [row('Write', '/w/README.md', true), row('Bash', '/w/README.md'), row('Write', '/w/gone.md')]) {
    const quiet = await $.ui.mount(props)
    expect(await quiet.find({ type: 'Markdown' })).toBeUndefined()
    await quiet.unmount()
  }

  const prompt = await $.ui.mount({
    plugin: 'mdview', surface: 'terminal', component: 'UserMessage', requestId: 'p1', viewport: FULL,
    props: { text: 'look at README.md please', origin: { kind: 'composer' }, isExpanded: false },
  } as never)
  expect((await prompt.find({ type: 'Markdown', key: 'open' }))?.props.text).toBe('⎿  [/w/README.md↗](file:///w/README.md)')
  await prompt.unmount()
})

describe('pictures', () => {
  test('a BMP reads the same stored either way up; half blocks put two pixels in a cell', () => {
    for (const b64 of [BMP_TOP_DOWN, BMP_BOTTOM_UP]) {
      const px = bmpPixels(bytesOf(b64))!
      expect([px.width, px.height, px.at(0, 0), px.at(1, 0), px.at(0, 1), px.at(1, 1)]).toEqual([2, 2, 0xff0000, 0x00ff00, 0x0000ff, 0xffffff])
    }
    expect(bmpPixels(bytesOf(PNG_640x480))).toBeNull()
    const px = bmpPixels(bytesOf(BMP_TOP_DOWN))!
    expect([...halfBlocks(px, 2, 1)]).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
    const holes = { width: 1, height: 2, at: (_x: number, y: number) => (y === 0 ? -1 : 0x123456) }
    expect([...halfBlocks(holes, 1, 1)]).toEqual([0x2584, 0x123456, 0x01000000])
    expect(fitCells(640, 480, 78, 40)).toEqual({ columns: 78, rows: 29 })
    expect(fitCells(640, 480, 78, 24)).toEqual({ columns: 64, rows: 24 })
  })

  test('in Warp and iTerm2 a picture is drawn as colored half blocks from a BMP sips makes', async ($, on) => {
    const w = world({ '/w/a.md': '# A\n\n![shot](s.png)', '/w/s.png': { bytes: PNG_640x480 } }, { TERM_PROGRAM: 'WarpTerminal', TMPDIR: '/t/' })
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    expect(w.runs[0]).toEqual(['sips', '-s', 'format', 'bmp', '-z', '48', '64', '/w/s.png', '--out', '/t/mdview-0.bmp'])
    const raster = await pane.find({ type: 'Raster' })
    expect(raster?.props).toMatchObject({ columns: 64, rows: 24 })
    const cells = new Uint32Array(bytesOf(String(raster?.props.cells)).buffer)
    expect(cells.length).toBe(64 * 24 * 3)
    expect([...cells.slice(0, 3)]).toEqual([0x2580, 0xff0000, 0xff0000]) // red at the top left
    expect(await pane.find({ type: 'Image' })).toBeUndefined()
    await pane.unmount()
  })

  test('iTerm2 is no kitty-protocol terminal: its pictures are half blocks too', async ($, on) => {
    const w = world({ '/w/a.md': '![shot](s.png)', '/w/s.png': { bytes: PNG_640x480 } }, { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' })
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Raster' })).toBeDefined()
    expect(await pane.find({ type: 'Image' })).toBeUndefined()
    await pane.unmount()
  })

  test('iTerm2 with CLAUDE_CODE_FORCE_TERMINAL_IMAGES gets the terminal\'s own pictures', async ($, on) => {
    const w = world({ '/w/a.md': '![shot](s.png)', '/w/s.png': { bytes: PNG_640x480 } }, { TERM_PROGRAM: 'iTerm.app', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Image' })).toBeDefined()
    await pane.unmount()
  })

  test('in Ghostty another format is turned into a PNG the terminal draws', async ($, on) => {
    const w = world({ '/w/a.md': '![p](p.jpg)', '/w/p.jpg': { bytes: 'AAAA' } }, { TERM_PROGRAM: 'ghostty' })
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    const img = await pane.find({ type: 'Image' })
    expect(String((img?.props.source as { file: string }).file)).toMatch(/^\/tmp\/mdview-\d+\.png$/)
    expect(img?.props).toMatchObject({ columns: 13, rows: 3, alt: 'p' })
    expect(w.runs.map(r => r.slice(0, 3))).toEqual([
      ['sips', '-g', 'pixelWidth'],
      ['sips', '-s', 'format'],
    ])
    await pane.unmount()
  })
})

describe('editing', () => {
  const field = (pane: unknown) => pane as { input: (t: { key: string; text: string }) => Promise<unknown> }

  test('blocks that begin alike are told apart by their whole text', async ($, on) => {
    const w = world({ '/w/a.md': '# T\n\n```bash\necho a\n```\n\n```bash\necho b\n```' }, {})
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    let pane = await $.ui.mount(PANE)
    await pane.press({ key: 'edit-0-2' }) // the "echo b" fence, lines 7-9
    await pane.unmount()
    w.files['/w/a.md'] = '# T\n\nx\n\ny\n\n```bash\necho a\n```\n\n```bash\necho b\n```' // "echo a" now nearer line 7
    w.mtimes['/w/a.md'] = 2
    pane = await $.ui.mount(PANE)
    await field(pane).input({ key: 'edit-input', text: 'use printf' })
    expect(w.prompts).toEqual(['Edit lines 11-13 of `/w/a.md` in the section "T", which begin "```bash": use printf'])
    await pane.press({ key: 'edit-0-4' })
    await pane.unmount()
    w.files['/w/a.md'] = '# T\n\nx\n\ny\n\n```bash\necho a\n```' // the block is gone; its look-alike stays
    w.mtimes['/w/a.md'] = 3
    pane = await $.ui.mount(PANE)
    expect(await pane.find({ key: 'edit-input' })).toBeUndefined()
    await pane.unmount()
  })

  test('an edit from ✎ shows under its block and follows its own turn: waiting, editing, then Updated, gone 5 s later', async ($, on) => {
    const w = world({ '/w/a.md': '# One\n\nalpha\n\nbeta' }, {})
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    const under = async (key: string) => JSON.stringify((await pane.find({ key }))?.children ?? null)
    const turn = (turnId: string) => ({ turnId, reason: 'answer', answer: '', durationMs: 1, isAborted: false }) as never
    await pane.press({ key: 'edit-0-1' }) // "alpha"
    await field(pane).input({ key: 'edit-input', text: 'shorter' })
    expect(await under('blk0-1')).toContain('✶ Waiting for Claude…')
    expect(await under('blk0-2')).not.toContain('Claude')
    await $.turn.complete(turn('earlier')) // a turn already running ends first: not this edit's
    expect(await under('blk0-1')).toContain('✶ Waiting for Claude…')
    await $.turn.start({ text: w.prompts[0]!, turnId: 't1' })
    expect(await under('blk0-1')).toContain('✶ Claude is editing…')

    // a save from elsewhere is not Claude's change
    w.files['/w/a.md'] = '# One\n\nalph\n\nbeta'
    w.mtimes['/w/a.md'] = 2
    await w.clock!.advance(1_500)
    expect(await under('blk0-1')).toContain('✶ Claude is editing…')
    // a second edit sent meanwhile waits for its own turn
    await pane.press({ key: 'edit-0-2' }) // "beta"
    await field(pane).input({ key: 'edit-input', text: 'longer' })
    expect(await under('blk0-2')).toContain('✶ Waiting for Claude…')

    await $.tool.call({ tool: 'Edit', file_path: '/w/a.md', old_string: 'alpha', new_string: 'alph' } as never)
    await $.turn.complete(turn('t1'))
    expect(await under('blk0-1')).toContain('Updated')
    expect(await under('blk0-2')).toContain('✶ Waiting for Claude…')
    await $.turn.start({ text: w.prompts[1]!, turnId: 't2' })
    await $.turn.complete(turn('t2'))
    expect(await under('blk0-2')).toContain('No changes made')
    await w.clock!.advance(6_000)
    expect(await under('blk0-1')).not.toContain('Updated')
    expect(await under('blk0-2')).not.toContain('No changes made')
    await pane.unmount()
  })

  test('an edit whose prompt does not enter leaves no line under its block', async ($, on) => {
    const w = world({ '/w/a.md': '# One\n\nalpha' }, {})
    w.dropPrompt = 'blocked by a hook'
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    await pane.press({ key: 'edit-0-1' })
    await field(pane).input({ key: 'edit-input', text: 'shorter' })
    expect(w.prompts.length).toBe(1)
    expect(JSON.stringify((await pane.find({ key: 'blk0-1' }))?.children)).not.toContain('Claude')
    await pane.unmount()
  })

  test('a file in the home folder is under ~; lines are counted as an editor counts them', async ($, on) => {
    const w = world({ '/home/u/notes.md': '# N\n\none\n' }, {})
    await start($, on, w)
    await $.command.run({ command: 'md', args: '/home/u/notes.md' } as never)
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ type: 'Text', text: '  ~ · 3 lines · 1 section' })).toBeDefined()
    await pane.unmount()
  })

  test('the edit bar stays on its block when the file changes above it, and closes when the block is gone', async ($, on) => {
    const w = world({ '/w/a.md': '# One\n\nalpha\n\nbeta' }, {})
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    let pane = await $.ui.mount(PANE)
    await pane.press({ key: 'edit-0-2' }) // "beta", line 5
    await pane.unmount()
    w.files['/w/a.md'] = '# One\n\nnew\n\nalpha\n\nbeta'
    w.mtimes['/w/a.md'] = 2
    pane = await $.ui.mount(PANE)
    await field(pane).input({ key: 'edit-input', text: 'shorter' })
    expect(w.prompts).toEqual(['Edit lines 7-7 of `/w/a.md` in the section "One", which begin "beta": shorter'])
    await pane.press({ key: 'edit-0-1' }) // "new"
    await pane.unmount()
    w.files['/w/a.md'] = '# One\n\nalpha\n\nbeta'
    w.mtimes['/w/a.md'] = 3
    pane = await $.ui.mount(PANE)
    expect(await pane.find({ key: 'edit-input' })).toBeUndefined()
    await pane.unmount()
  })

  test('each block has a ✎ that shows on hover; it sends the instruction to Claude with the lines and how they begin', async ($, on) => {
    const w = world({ '/w/a.md': '# One\n\nalpha\n\n# Two\n\nbeta  gamma\ndelta' }, {})
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    for (const key of ['edit-0-0', 'edit-0-1', 'edit-1-0', 'edit-1-1']) expect(await pane.find({ key })).toBeDefined()
    await pane.press({ key: 'edit-1-1' })
    await field(pane).input({ key: 'edit-input', text: 'make it a table' })
    expect(w.prompts).toEqual(['Edit lines 7-8 of `/w/a.md` in the section "Two", which begin "beta gamma": make it a table'])
    expect(await pane.find({ key: 'edit-input' })).toBeUndefined()
    await pane.press({ key: 'edit-0-0' })
    await pane.press({ key: 'edit-cancel' })
    expect(await pane.find({ key: 'edit-input' })).toBeUndefined()
    expect(w.prompts.length).toBe(1)
    await pane.unmount()
  })
})

describe('click modes', () => {
  test('in Warp the pane hands the file to Warp\'s own viewer, and a half-block picture to the default app', async ($, on) => {
    const w = world({ '/w/a.md': '# A\n\n![shot](s.png)', '/w/s.png': { bytes: PNG_640x480 } }, { TERM_PROGRAM: 'WarpTerminal' })
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    await pane.press({ key: 'warp' })
    expect(w.runs.at(-1)).toEqual(['open', 'warp://action/open_file_editor?path=%2Fw%2Fa.md'])
    const original = await pane.find({ type: 'Button', text: '⎿  open the original' })
    await pane.press({ key: String(original?.key) })
    expect(w.runs.at(-1)).toEqual(['open', '/w/s.png'])
    await pane.unmount()
  })

  test('in Warp a click on a path in the conversation opens Warp\'s viewer, at the line it names', async ($, on) => {
    const w = world({ '/w/README.md': '# R' }, { TERM_PROGRAM: 'WarpTerminal' })
    await start($, on, w)
    const ui = await $.ui.mount(reply('See `README.md:3`.'))
    await ui.press({ key: 'r0', link: { href: 'file:///w/README.md#L3' } })
    expect(w.runs.at(-1)).toEqual(['open', 'warp://action/open_file_editor?path=%2Fw%2FREADME.md&line=3'])
    expect(w.opened).toEqual([]) // no pane
    await ui.unmount()
    expect(await $.tool.call({ tool: 'mcp__mdview__show', path: 'README.md' } as never)).toMatchObject({ result: expect.stringContaining('Warp') })
    expect(w.runs.at(-1)).toEqual(['open', 'warp://action/open_file_editor?path=%2Fw%2FREADME.md'])
  })

  test('outside Warp there is no Warp button', async ($, on) => {
    const w = world({ '/w/a.md': '# A' }, { TERM_PROGRAM: 'iTerm.app' })
    await start($, on, w)
    await $.command.run({ command: 'md', args: 'a.md' } as never)
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ key: 'warp' })).toBeUndefined()
    await pane.unmount()
  })

  test('outside Warp, clickOpens: app hands the file to the app macOS opens it with', { options: { clickOpens: 'app' } }, async ($, on) => {
    const w = world({ '/w/README.md': '# R' }, { TERM_PROGRAM: 'iTerm.app' })
    await start($, on, w)
    const ui = await $.ui.mount(reply('See `README.md:3`.'))
    await ui.press({ key: 'r0', link: { href: 'file:///w/README.md#L3' } })
    expect(w.runs.at(-1)).toEqual(['open', '/w/README.md'])
    expect(w.opened).toEqual([]) // no pane
    await ui.unmount()
  })

  test('in Warp, clickOpensInWarp picks the app or the pane instead of Warp\'s viewer', { options: { clickOpensInWarp: 'pane' } }, async ($, on) => {
    const w = world({ '/w/README.md': '# R' }, { TERM_PROGRAM: 'WarpTerminal' })
    await start($, on, w)
    const ui = await $.ui.mount(reply('See `README.md`.'))
    await ui.press({ key: 'r0', link: { href: 'file:///w/README.md' } })
    expect(w.opened).toEqual(['README.md'])
    expect(w.runs).toEqual([])
    await ui.unmount()
  })

  test('clickOpens: app never hands `open` a link named .md that leads to a script or an app', { options: { clickOpens: 'app' } }, async ($, on) => {
    const w = world({ '/w/run.command': 'rm -rf ~', '/w/real.md': '# Real' }, {})
    w.links = { '/w/notes.md': '/w/run.command', '/w/app.md': '/Applications/Evil.app', '/w/ok.md': '/w/real.md' }
    w.dirs = ['/Applications/Evil.app']
    await start($, on, w)
    const ui = await $.ui.mount(reply('See `notes.md`, `app.md` and `ok.md`.'))
    await ui.press({ key: 'r0', link: { href: 'file:///w/notes.md' } })
    await ui.press({ key: 'r0', link: { href: 'file:///w/app.md' } })
    expect(w.runs.filter(r => r[0] === 'open')).toEqual([])
    // a link to a real markdown file still opens in the app, by the path it lands on
    await ui.press({ key: 'r0', link: { href: 'file:///w/ok.md' } })
    expect(w.runs.filter(r => r[0] === 'open')).toEqual([['open', '/w/real.md']])
    await ui.unmount()
  })

  test('when the app cannot open the file, the click opens the pane instead', { options: { clickOpens: 'app' } }, async ($, on) => {
    const w = world({ '/w/notes.mdx': '# N' }, {})
    w.openFails = true
    await start($, on, w)
    const ui = await $.ui.mount(reply('See `notes.mdx`.'))
    await ui.press({ key: 'r0', link: { href: 'file:///w/notes.mdx' } })
    expect(w.runs.at(-1)).toEqual(['open', '/w/notes.mdx'])
    expect(w.opened).toEqual(['notes.mdx'])
    await ui.unmount()
  })

  test('/md mode switches between pane and app outside Warp, through the setting /config sets', async ($, on) => {
    const w = world({ '/w/README.md': '# R' }, {})
    await start($, on, w)
    expect(await $.command.run({ command: 'md', args: 'mode' } as never)).toMatchObject({ text: expect.stringContaining('clickOpens: app') })
    const ui = await $.ui.mount(reply('See `README.md`.'))
    await ui.press({ key: 'r0', link: { href: 'file:///w/README.md' } })
    expect(w.runs.at(-1)).toEqual(['open', '/w/README.md'])
    await ui.unmount()
    expect(await $.command.run({ command: 'md', args: 'mode' } as never)).toMatchObject({ text: expect.stringContaining('clickOpens: pane') })
    expect(await $.command.run({ command: 'md', args: 'mode pane' } as never)).toMatchObject({ text: expect.stringContaining('already') })
    expect(await $.command.run({ command: 'md', args: 'mode warp' } as never)).toMatchObject({ text: 'Usage: /md mode [pane|app]' })
    expect(w.configs).toEqual([['mdview.clickOpens', 'app'], ['mdview.clickOpens', 'pane']]) // no write when nothing changes
  })

  test('/md mode cycles Warp\'s viewer, the pane and the app in Warp', async ($, on) => {
    const w = world({}, { TERM_PROGRAM: 'WarpTerminal' })
    await start($, on, w)
    for (const want of ['pane', 'app', 'warp']) {
      expect(await $.command.run({ command: 'md', args: 'mode' } as never)).toMatchObject({ text: expect.stringContaining(`clickOpensInWarp: ${want}`) })
    }
    expect(w.configs.map(([k, v]) => `${k}=${v}`)).toEqual(['mdview.clickOpensInWarp=pane', 'mdview.clickOpensInWarp=app', 'mdview.clickOpensInWarp=warp'])
  })

  test('/md mode reports a refusal, and the value the setting really took', async ($, on) => {
    const w = world({}, {})
    await start($, on, w)
    w.configAnswer = { deny: 'locked by policy' }
    expect(await $.command.run({ command: 'md', args: 'mode app' } as never)).toMatchObject({ text: 'Could not switch: locked by policy' })
    w.configAnswer = { value: 'pane' }
    expect(await $.command.run({ command: 'md', args: 'mode app' } as never)).toMatchObject({ text: expect.stringContaining('clickOpens: pane') })
  })

  test('the model\'s show tool opens the pane even when clicks go to the app', { options: { clickOpens: 'app' } }, async ($, on) => {
    const w = world({ '/w/README.md': '# R', '/w/run.command': 'echo hi' }, {})
    await start($, on, w)
    expect(await $.tool.call({ tool: 'mcp__mdview__show', path: 'run.command' } as never)).toMatchObject({ result: expect.stringContaining("mdview's pane") })
    expect(w.runs).toEqual([]) // nothing handed to `open`
    expect(w.opened).toEqual(['run.command'])
  })

  test('a reply keeps resolving its relative paths where it was first drawn, after a cd', async ($, on) => {
    const w = world({ '/w/README.md': '# here', '/x/README.md': '# there' }, {})
    await start($, on, w)
    let ui = await $.ui.mount(reply('See `README.md`.', FULL, 'old'))
    expect((await ui.find({ type: 'Markdown', key: 'r0' }))?.props.pressableLinks).toEqual(['file:///w/README.md'])
    await ui.unmount()
    w.cwd = '/x'
    ui = await $.ui.mount(reply('See `README.md`.', FULL, 'old'))
    expect((await ui.find({ type: 'Markdown', key: 'r0' }))?.props.pressableLinks).toEqual(['file:///w/README.md'])
    await ui.unmount()
    ui = await $.ui.mount(reply('See `README.md`.', FULL, 'new'))
    expect((await ui.find({ type: 'Markdown', key: 'r0' }))?.props.pressableLinks).toEqual(['file:///x/README.md'])
    await ui.unmount()
  })

  test('a file named mode opens instead of switching', async ($, on) => {
    const w = world({ '/w/mode': 'plain' }, {})
    await start($, on, w)
    expect(await $.command.run({ command: 'md', args: 'mode' } as never)).toMatchObject({ text: 'Showing /w/mode' })
    expect(w.configs).toEqual([])
  })
})
