// The file the pane shows, the page of it on screen, the element last brought into view (null: the top),
// and the files Back returns to (latest last).
export type MdviewDoc = { path: string; page: number; target: string | null; back: string[] }

// The find bar: open or not, what was last looked for, and which hit is shown.
export type MdviewFind = { query: string; at: number; hits: number }

// The block whose ✎ was pressed, by the line it began on and a fingerprint of its text (found again if the file
// changes above it): its edit bar is open.
export type MdviewEdit = { path: string; line: number; hash: string }

// An edit sent to Claude from a block's ✎: the block, the prompt as sent, the turn that runs it (null until it starts),
// whether that turn wrote the file, and when the turn ended (null while it runs). The pane shows it under its block
// until a few seconds after.
// `text`: how the edit's prompt begins, matched in the turn that runs it; `isFilled`: put in the prompt box, not sent yet
export type MdviewPending = { id: string; path: string; line: number; hash: string; text: string; isFilled: boolean; turn: string | null; changed: boolean; done: number | null }

declare module 'claude-code' {
  // `edit` and `pending` are Shaped: each atom names a shape, bumped whenever its type changes, so a reload declines
  // an old value
  interface PluginState {
    // `cwds`: the working directories the session has had, latest first, kept across reloads of the mod
    mdview: { doc: MdviewDoc | null; rev: number; toc: boolean; find: MdviewFind | null; edit: Shaped<MdviewEdit | null>; cwds: string[]; pending: Shaped<MdviewPending[]> }
  }
}
