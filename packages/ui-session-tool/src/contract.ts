import type {
  SessionToolListFilter, SessionToolListResult, SessionToolReadResult, SessionVisibility,
} from 'session-tool'

export interface SidebarApi {
  list: {
    input: Pick<SessionToolListFilter, 'title' | 'origin' | 'includeHidden' | 'cursor' | 'status'>
    output: SessionToolListResult
  }
  read: {
    input: { sessionId: string; sinceSeq?: number }
    output: SessionToolReadResult & { visibility: SessionVisibility }
  }
  write: { input: { sessionId: string; content: string }; output: unknown }
  cancel: { input: { sessionId: string }; output: unknown }
  rename: { input: { sessionId: string; title: string }; output: unknown }
  hide: { input: { sessionId: string }; output: unknown }
  unhide: { input: { sessionId: string }; output: unknown }
}

export type SidebarCall = <K extends keyof SidebarApi>(
  method: K, input: SidebarApi[K]['input'], signal?: AbortSignal,
) => Promise<SidebarApi[K]['output']>

export const endpoints = ['list', 'read', 'write', 'cancel', 'rename', 'hide', 'unhide'] as const
export const prefix = 'session-tool/'
