<div align="center">

# mdview

**Markdown, rendered right where you are already looking.**<br>
Click a `.md` path Claude mentions and read the file beside the conversation, with headings, tables, code and
pictures. Then point at any block and tell Claude what to change.

[![Version](https://img.shields.io/badge/version-1.0.1-d77757.svg)](https://github.com/xuanji86/claude-mdview/releases)
[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-c678dd.svg)](https://code.claude.com/docs/en/plugins/mods/overview)
[![Terminals](https://img.shields.io/badge/Ghostty%20·%20iTerm2%20·%20Warp-4a4a4a.svg)](#terminals)
[![License: MIT](https://img.shields.io/badge/license-MIT-4eba65.svg)](LICENSE)

**English** · [中文](README.zh-CN.md)

<img src="assets/pane.svg" alt="A markdown file rendered in a pane beside the Claude Code conversation" width="820">

</div>

## Why

Claude writes its plans, reports and notes as markdown files and gives you the path. Reading one used to mean leaving
the session for an editor or a browser, and editing it meant describing a spot in a file you could not see.

**mdview** is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that closes that loop. Paths
become links. A click opens the file in a pane beside the conversation, drawn by Claude Code's own markdown renderer, so
a plan reads like the reply it came from. When something needs to change, you point at the block and say so. Claude
makes the edit, and the pane redraws as it lands.

## Highlights

| | |
| --- | --- |
| **One click to read** | A `.md` path that names a real file gets a `↗`, whether it is in backticks, bare, a markdown link or run into Chinese text. Links appear in replies, under `Read` / `Write` / `Edit` rows and under your own prompts. `path:42` and `path#heading` land on the spot |
| **A reader, not a dump** | Sections with a Contents list (`t`), Find (`f`), long files in parts (`p` `n`), links between files followed in place, and Back (`b`) |
| **Pictures in the terminal** | The terminal's own sharp picture in Ghostty, kitty and iTerm2 3.7+, and colored half blocks anywhere else. PNG, JPEG, GIF and HEIC all work |
| **Point, then edit** | Hover a block and it lights up with a `✎`. Say what to change and press Enter; Claude gets the file, the lines and how they begin, and the block shows how the edit is going |
| **Live** | A file Claude writes redraws at once; one changed elsewhere within 1.5 s |
| **Your viewer, per terminal** | A click opens mdview's pane, Warp's own Markdown viewer split beside the session, or the app macOS opens `.md` with. `/md mode` switches |
| **More than markdown** | Any text file opens as highlighted code with line numbers. Common HTML and too-wide tables are turned into something a terminal can show |
| **Claude can show you** | Ask to see a file and Claude opens it with `mcp__mdview__show`: in the pane, or in Warp's viewer in Warp |

## See it work

<table>
<tr>
<td width="62%" valign="top">

**Point at a block, say the change**

<img src="assets/edit.svg" alt="A hovered block with its edit bar, and the prompt it sent to Claude" width="100%">

</td>
<td width="38%" valign="top">

**Hover** a paragraph, list, table, code block or picture. It lights up, and a `✎` shows at its right end.

**Click `✎`** and type the change, such as *make it a checklist*. **Enter** sends it as your prompt, naming the file,
the lines and how they begin.

**Claude edits.** A line under the block follows the edit, as Claude Code hangs a result under its row:
`✶ Waiting for Claude…` while another turn runs, `✶ Claude is editing…` once its own starts, then `Updated` when Claude
wrote the file, or `No changes made`. The pane redraws in place, and the line goes a few seconds later. Send several and
each keeps its own line; a prompt that cannot be sent says why.

If the file shifts under an open bar, the bar follows its block; if the block is gone, the bar closes.

</td>
</tr>
</table>

## Install

Needs **Claude Code 2.1.287 or later** (the release that brought mods; tested on 2.1.300), in the **fullscreen** layout
(`/tui fullscreen`), the only layout where a click reaches a mod. Mods are early access, and their API may change
between releases.

```text
/plugin marketplace add xuanji86/claude-mdview
/plugin install mdview@claude-mdview
```

<details>
<summary>From a clone instead</summary>

```sh
git clone https://github.com/xuanji86/claude-mdview ~/Desktop/claude-mdview
```

Then add it to `~/.claude/settings.json` (several folders separate with `:`):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Desktop/claude-mdview" } }
```

Or load it for one session only: `claude --plugin-dir ~/Desktop/claude-mdview`.

</details>

## Use

| | |
| --- | --- |
| **Click** a `↗` path | Opens it, where your setting says (see [Configure](#configure)) |
| `/md <path>[#heading\|:line]` | Opens any file in the pane; `/md` alone reopens the last one |
| `/md mode [choice]` | Switches what a click opens in this terminal; alone, moves to the next choice |
| **Esc** · `q` | Closes the pane |
| `b` | Back to the file you came from |
| `t` · `f` | Contents · Find (Enter again for the next match) |
| `p` · `n` | Previous · next part of a long file, also at the foot of each part |
| `w` | In Warp: this file in Warp's own viewer |
| **Hover** → `✎` | Edit that block with Claude |

The pane lists its keys in one dim row under the file's name, each a click away too. They work while the pane holds the
keyboard, which it takes when it opens over an empty prompt; a click on the pane gives the keyboard back to it.

## Configure

In `/config`, the rows **Click opens** and **Click opens (Warp)**. `/md mode` sets the same values.

| Setting | Choices | Default |
| --- | --- | --- |
| `clickOpens` | `pane`: mdview's pane · `app`: the app macOS opens `.md` files with | `pane` |
| `clickOpensInWarp` | `warp`: Warp's Markdown viewer, split to the right · `pane` · `app` | `warp` |

If the app or Warp cannot open a file, the click falls back to the pane. The app always opens at the top of the file;
`:line` works in Warp's viewer and in the pane. To change the app, use Finder: Get Info › Open with › Change All.

## Terminals

| Terminal | Pictures | A click opens, by default |
| --- | --- | --- |
| **Ghostty**, **kitty** | Sharp: the terminal's own picture | mdview's pane |
| **iTerm2 3.7+** | Sharp, with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` set for iTerm2 only (see below). Without it, half blocks | mdview's pane |
| **Warp** | Half blocks in the pane; sharp in Warp's own viewer | Warp's viewer, split to the right |
| Others | Colored half blocks (`▀`, two pixels a cell) | mdview's pane |

Claude Code draws pictures only in terminals it trusts to place them: kitty and Ghostty. iTerm2 3.7 supports the same
kitty graphics protocol, Unicode placeholders included, so it can be switched on there. Put it in `~/.zshrc` for iTerm2
alone:

```sh
[[ $TERM_PROGRAM == iTerm.app ]] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
```

Do not set it for Warp: Warp has no Unicode placeholders yet
([warpdotdev/Warp#6210](https://github.com/warpdotdev/Warp/issues/6210)), and forcing pictures garbles the screen.
Formats other than PNG, and every half-block picture, go through macOS's `sips`; without it you see their alt text.

## What it can reach

mdview reads, draws, and acts only when you ask it to. `claude plugin validate .` prints every hook and call it makes.

| It | When |
| --- | --- |
| reads a file | its path is in the conversation (to see that it exists), or you open it |
| runs `sips` | it draws a picture other than a PNG, or any picture as half blocks: into a file under `$TMPDIR` (a half-block one is removed once read) |
| runs `open` | you click with `app` or `warp` chosen, for markdown files only. The model's show tool never uses it, so it cannot launch a script or an app |
| sends a prompt | you press Enter in a `✎` bar, and only with the text you typed |
| changes a setting | you run `/md mode` |

It makes no network requests, stores nothing across sessions, and calls no model of its own.

## Limits

- **No true fullscreen.** A mod's pane docks beside the transcript, which keeps a minimum width; mdview asks for all the
  rest.
- **Clicks need the fullscreen layout.** On the main screen, use `/md`.
- **A terminal draws text.** Math, mermaid and heading sizes show as written. Warp's own viewer does draw mermaid.
- **Redrawn replies.** A reply with a clickable path is drawn by mdview, so copying it brings its `⏺` along.
- **Size.** One markdown element holds at most 10,000 characters and a pane about 100,000, so long files come in parts.
- **Early access.** The mods API may change between Claude Code releases.

## Develop

```sh
claude plugin validate .
claude plugin test .            # 38 tests
python3 assets/make_previews.py # the README pictures
```

A saved file reloads the mod in every session that loads it from this folder.

## License

[MIT](LICENSE) © Anji Xu
