<div align="center">

# mdview

**Markdown,就在你正看着的地方渲染出来。**<br>
单击 Claude 提到的 `.md` 路径，文件就在对话旁边展开：标题、表格、代码、图片一应俱全。想改哪一块，指着它告诉 Claude 就行。

[![Version](https://img.shields.io/badge/version-1.0.1-d77757.svg)](https://github.com/xuanji86/claude-mdview/releases)
[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-c678dd.svg)](https://code.claude.com/docs/en/plugins/mods/overview)
[![Terminals](https://img.shields.io/badge/Ghostty%20·%20iTerm2%20·%20Warp-4a4a4a.svg)](#终端)
[![License: MIT](https://img.shields.io/badge/license-MIT-4eba65.svg)](LICENSE)

[English](README.md) · **中文**

<img src="assets/pane.svg" alt="在 Claude Code 对话旁边的 pane 里渲染出来的 markdown 文件" width="820">

</div>

## 为什么

Claude 常把计划、报告、笔记写成 markdown 文件，再把路径告诉你。以前要读它，得离开会话去开编辑器或浏览器;要改它，得对着一个看不见的文件描述"第几段那句话"。

**mdview** 是一个 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview),把这件事闭环了：路径变成链接，单击就在对话旁边的 pane 里打开文件，用的是 Claude Code 自己的 markdown 渲染器，读起来和它的回复一样顺眼。哪里要改，指着那一块说一句，Claude 动手改，pane 当场刷新。

## 亮点

| | |
| --- | --- |
| **一键就读** | 指向真实文件的 `.md` 路径后面会带上 `↗`,反引号里的、裸写的、markdown 链接、和中文紧贴的都认得。回复里有，`Read` / `Write` / `Edit` 工具行下面和你自己的消息下面也有。`路径:42` 和 `路径#标题` 直接跳到那里 |
| **是阅读器，不是一堆字** | 按标题分节，有目录(`t`)、查找(`f`),长文件分成几部分(`p` `n`),文档之间的链接在 pane 里接着打开，还能返回(`b`) |
| **终端里看图** | 在 Ghostty、kitty、iTerm2 3.7+ 里是终端自己画的清晰原图，其他终端是彩色半格色块。PNG、JPEG、GIF、HEIC 都行 |
| **指哪改哪** | 鼠标停在某一块上，它会高亮，并出现 `✎`。写下要怎么改，回车;Claude 会收到文件、行号和这一块的开头，这一块下面实时显示改到哪了 |
| **实时刷新** | Claude 写的文件立即刷新;外部修改最多 1.5 秒 |
| **每个终端用顺手的查看器** | 单击可以开 mdview 的 pane、Warp 自带的 Markdown 查看器(在会话旁边分栏),或者 macOS 给 `.md` 设定的默认程序。用 `/md mode` 切换 |
| **不止 markdown** | 任何文本文件都按代码高亮显示，带行号。常见 HTML 和放不下的宽表格会转成终端能显示的样子 |
| **Claude 也能主动给你看** | 你让它打开某个文件，它会用 `mcp__mdview__show` 在 pane 里打开(在 Warp 里用 Warp 查看器) |

## 看它怎么用

<table>
<tr>
<td width="62%" valign="top">

**指着一块，说出要改什么**

<img src="assets/edit.svg" alt="悬停高亮的一块和它的输入条，以及发给 Claude 的消息" width="100%">

</td>
<td width="38%" valign="top">

**悬停**在段落、列表、表格、代码块或图片上，它会高亮，右端出现 `✎`。

**点 `✎`** 写下修改，比如"改成清单"。**回车**后它作为你的消息发出，带上文件、行号和这一块的开头。

**Claude 动手改。** 这一块下面会挂一行进度，就像 Claude Code 在自己的条目下挂结果那样：前面还有别的回合在跑时是 `✶ Waiting for Claude…`,轮到它时变成 `✶ Claude is editing…`,结束后 Claude 写了这个文件就显示 `Updated`,没写就是 `No changes made`。pane 原地刷新，这行几秒后消失。连发几处，各自挂各自的进度;消息发不出去会提示原因。

输入条开着时文件变了，它会跟着那一块走;那一块被删了，输入条就关掉。

</td>
</tr>
</table>

## 安装

需要 **Claude Code 2.1.287 或更新**(mod 从这个版本开始提供;在 2.1.300 上测试),并使用 **fullscreen** 界面(`/tui fullscreen`)，只有这个模式下单击才会传给 mod。mod 接口还是抢先体验版，Claude Code 升级后可能变化。

```text
/plugin marketplace add xuanji86/claude-mdview
/plugin install mdview@claude-mdview
```

<details>
<summary>也可以从源码加载</summary>

```sh
git clone https://github.com/xuanji86/claude-mdview ~/Desktop/claude-mdview
```

然后加进 `~/.claude/settings.json`(多个目录用 `:` 分隔):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Desktop/claude-mdview" } }
```

或者只对一个会话加载：`claude --plugin-dir ~/Desktop/claude-mdview`。

</details>

## 用法

| | |
| --- | --- |
| **单击** `↗` 路径 | 按你的设置打开(见[设置](#设置)) |
| `/md <路径>[#标题\|:行号]` | 在 pane 里打开任意文件;只打 `/md` 重新打开上一个 |
| `/md mode [选项]` | 切换当前终端里单击打开什么;不带选项就切到下一个 |
| **Esc** · `q` | 关闭 pane |
| `b` | 回到上一个文档 |
| `t` · `f` | 目录 · 查找(再按回车跳到下一个) |
| `p` · `n` | 长文件的上一部分 · 下一部分(每部分末尾也有) |
| `w` | 在 Warp 里：用 Warp 自带的查看器打开这个文件 |
| **悬停** → `✎` | 让 Claude 改这一块 |

pane 在文件名下面用一行暗色文字列出这些按键，每一个也都能直接点。按键在 pane 拿着键盘时有效：输入框为空时打开 pane,它会自动拿到键盘;点一下 pane 也能把键盘交给它。

## 设置

在 `/config` 里的 **Click opens** 和 **Click opens (Warp)** 两项;`/md mode` 改的也是这两项。

| 设置 | 选项 | 默认 |
| --- | --- | --- |
| `clickOpens` | `pane`:mdview 的 pane · `app`:macOS 为 `.md` 设定的默认程序 | `pane` |
| `clickOpensInWarp` | `warp`:Warp 自带的 Markdown 查看器，在右侧分栏 · `pane` · `app` | `warp` |

默认程序或 Warp 打不开时，会改为打开 pane。默认程序总是从文件开头打开;`:行号` 只在 Warp 查看器和 pane 里有效。要换默认程序，在 Finder 里：显示简介 › 打开方式 › 全部更改。

## 终端

| 终端 | 图片 | 默认单击打开 |
| --- | --- | --- |
| **Ghostty**、**kitty** | 清晰：终端自己画的原图 | mdview 的 pane |
| **iTerm2 3.7+** | 只对 iTerm2 设 `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` 后清晰(见下);不设则是半格色块 | mdview 的 pane |
| **Warp** | pane 里是半格色块;Warp 自带查看器里清晰 | Warp 查看器，右侧分栏 |
| 其他 | 彩色半格色块(`▀`,每格两个像素) | mdview 的 pane |

Claude Code 只在它信得过的终端里画图:kitty 和 Ghostty。iTerm2 3.7 支持同一套 kitty 图片协议，包括 Unicode 占位符，所以可以强制开启。只对 iTerm2 生效的写法，放进 `~/.zshrc`:

```sh
[[ $TERM_PROGRAM == iTerm.app ]] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
```

别对 Warp 开：Warp 还不支持 Unicode 占位符([warpdotdev/Warp#6210](https://github.com/warpdotdev/Warp/issues/6210)),强制开启会把界面搞乱。非 PNG 格式的图片、以及所有半格色块图，都要经过 macOS 自带的 `sips`;没有它就只显示 alt 文字。

## 它能碰到什么

mdview 只读、只画，只在你要求时动手。`claude plugin validate .` 会列出它用到的每一个钩子和调用。

| 它会 | 什么时候 |
| --- | --- |
| 读文件 | 文件路径出现在对话里(确认文件存在)，或者你打开它 |
| 运行 `sips` | 画非 PNG 图片，或任何半格色块图时：转换到 `$TMPDIR` 下的文件(半格色块用的读完即删) |
| 运行 `open` | 你在 `app` 或 `warp` 模式下单击时，且只对 markdown 文件。Claude 的 show 工具从不调用它，所以没法借它运行脚本或启动程序 |
| 发送消息 | 你在 `✎` 输入条里按回车时，只发你写的那句话 |
| 改设置 | 你运行 `/md mode` 时 |

它不发任何网络请求，不跨会话保存任何东西，也不自己调用模型。

## 限制

- **做不到真全屏。** mod 的 pane 只能停靠在对话旁边，对话区有最小宽度;剩下的宽度 mdview 全要了。
- **单击要 fullscreen 界面。** 普通界面下用 `/md`。
- **终端只会画文字。** 数学公式、mermaid、标题字号按原文显示。Warp 自带的查看器能画 mermaid。
- **重画的回复。** 含可点路径的回复是 mdview 重画的，复制时会带上 `⏺`。
- **长度。** 单个 markdown 元素最多 1 万字符，整个 pane 约 10 万，所以长文件要分几部分。
- **抢先体验。** mod 接口可能随 Claude Code 版本变化。

## 开发

```sh
claude plugin validate .
claude plugin test .            # 38 个测试
python3 assets/make_previews.py # 生成 README 里的图
```

保存文件后，所有从这个目录加载它的会话都会自动重新加载。

## 许可证

[MIT](LICENSE) © Anji Xu
