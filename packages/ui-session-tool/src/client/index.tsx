import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SidebarApi, SidebarCall } from '../contract.ts'
import { prefix } from '../contract.ts'
import { SessionPanel } from './panel.tsx'
import { SessionMarksBadge } from './header-badge.tsx'

export const inject = ['slots', 'connection', 'sessions', 'layout', 'uiWorkspace']
export const panelId = 'session-tool'

/** Main-view navigation. `sessions.open` was removed in 0.1.6-alpha.2. */
interface MainViewNavigation {
  openSession(target: SessionId): void
}

function PanelIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="2" />
    <rect x="14" y="14" width="7" height="7" rx="2" />
    <path d="M7 10v7h7M10 7h7v7" />
  </svg>
}

export function apply(ctx: Context): void {
  const sessions = ctx.sessions as unknown as ISessions
  const connection = ctx.connection as unknown as ConnectionHandle
  const call: SidebarCall = async <K extends keyof SidebarApi>(method: K, input: SidebarApi[K]['input'], signal?: AbortSignal) => {
    const result = await connection.rpc.call('/api', prefix + method, input, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as SidebarApi[K]['output']
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId,
    inject: () => ({
      call,
      onReset: (listener: () => void) => {
        const dispose = ctx.on('connection/reset', listener)
        return () => { void dispose() }
      },
      openSession: async (id: string) => {
        const navigation = ctx.layout.beginNavigation()
        await sessions.refresh()
        if (navigation.aborted) return
        const uiWorkspace = ctx.get('uiWorkspace') as MainViewNavigation
        uiWorkspace.openSession(id as SessionId)
      },
    }),
  }, SessionPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, label: '会话协作', order: 50,
  }, PanelIcon))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'session-marks-badge',
    order: 5,
    inject: () => ({ call }),
  }, SessionMarksBadge))
}
