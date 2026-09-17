// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SidebarCall } from '../src/contract.ts'
import { SessionMarksBadge } from '../src/client/header-badge.tsx'

describe('session header marks badge', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders projected chips and opens the inspector from 详情', async () => {
    const call = vi.fn(async () => ({
      sessionId: 'session-1',
      tags: ['app:dsh-bot', 'form:plugin', 'bot:xiaobei', 'kind:dsh-bot-chat'],
      hiddenPrefixes: ['~'],
    })) as unknown as SidebarCall
    await act(async () => root.render(createElement(SessionMarksBadge, {
      sessionId: SessionId('session-1'),
      useSessions: selector => selector({ byId: { 'session-1': { title: '值班' } } }),
      call,
    })))
    expect(call).toHaveBeenCalledWith('marks', { sessionId: 'session-1' }, expect.any(AbortSignal))
    const detail = container.querySelector<HTMLButtonElement>('.st-badge-detail')
    expect(detail?.textContent).toContain('详情')
    expect(detail?.getAttribute('aria-label')).toBe('会话标记详情：小北')
    expect(container.querySelector('.st-chips')?.textContent).toContain('插件')
    expect(container.querySelector('[role=dialog]')).toBeNull()
    await act(async () => detail!.click())
    expect(container.querySelector('[role=dialog]')?.textContent).toContain('人设 · bot:xiaobei')
    expect(container.querySelector('[role=dialog]')?.textContent).toContain('kind:dsh-bot-chat')
  })

  it('renders nothing when the session has no projected marks', async () => {
    const call = vi.fn(async () => ({
      sessionId: 'session-1',
      tags: [],
      hiddenPrefixes: ['~'],
    })) as unknown as SidebarCall
    await act(async () => root.render(createElement(SessionMarksBadge, {
      sessionId: SessionId('session-1'),
      useSessions: selector => selector({ byId: { 'session-1': { title: '旧会话' } } }),
      call,
    })))
    expect(container.querySelector('.st-badge')).toBeNull()
  })
})
