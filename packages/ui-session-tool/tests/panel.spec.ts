// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SidebarCall } from '../src/contract.ts'
import { SessionPanel } from '../src/client/panel.tsx'

const rows = [
  { sessionId: SessionId('session-a'), title: '任务 A', tags: ['kind:delegated'], status: 'live', delegationStatus: 'idle', createdAt: 1 },
  { sessionId: SessionId('session-b'), title: '任务 B', tags: [], status: 'live', delegationStatus: 'running', createdAt: 2 },
]
const emptyDetail = { sessionId: 'session-a', messages: [], delegationStatus: 'idle', visibility: { hasHiddenMark: false, archived: false, isHidden: false } }

describe('collaboration panel behavior', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })
  const button = (label: string) => {
    const found = [...container.querySelectorAll('button')].find(button => button.textContent === label)
    if (!found) throw new Error(`Missing button: ${label}`)
    return found
  }
  const click = async (element: HTMLElement) => { await act(async () => element.click()) }
  async function mount(call: SidebarCall, openSession = vi.fn().mockResolvedValue(undefined)) {
    await act(async () => root.render(createElement(SessionPanel, { call, openSession, onReset: () => () => {} })))
    return openSession
  }
  async function select(index = 0) { await click(container.querySelectorAll<HTMLButtonElement>('.st-row')[index]!) }

  it('opens the native conversation and does not mistake resident sessions for running turns', async () => {
    const call = vi.fn(async (method, input) => method === 'list' ? { sessions: rows }
      : { ...emptyDetail, delegationStatus: rows.find(row => row.sessionId === input.sessionId)?.delegationStatus }) as unknown as SidebarCall
    const open = await mount(call)
    await select()
    expect(button('停止当前轮次').disabled).toBe(true)
    await click(button('在对话中打开'))
    expect(open).toHaveBeenCalledWith('session-a')
    await select(1)
    expect(button('停止当前轮次').disabled).toBe(false)
    await click(button('停止当前轮次'))
    expect(call).toHaveBeenCalledWith('cancel', { sessionId: 'session-b' })
  })

  it('keeps an unsent prompt after failure, clears it only on acceptance, and renders transcript text safely', async () => {
    let rejected = true
    const call = vi.fn(async (method: string) => {
      if (method === 'list') return { sessions: rows }
      if (method === 'write') { if (rejected) throw new Error('agent busy'); return {} }
      return { ...emptyDetail, messages: [{ seq: 1, role: 'assistant', blocks: [{ type: 'text', text: '<script>unsafe()</script>' }] }] }
    }) as unknown as SidebarCall
    await mount(call); await select()
    expect(container.querySelector('script')).toBeNull()
    const input = container.querySelector('textarea')!
    await act(async () => { input.value = '继续任务'; Simulate.change(input) })
    await act(async () => Simulate.submit(input.closest('form')!))
    expect(container.querySelector('[role=alert]')?.textContent).toContain('agent busy')
    expect(input.value).toBe('继续任务')
    rejected = false
    await act(async () => Simulate.submit(input.closest('form')!))
    expect(input.value).toBe('')
    expect(container.textContent).toContain('消息已接收')
  })

  it('ignores late detail responses after switching sessions', async () => {
    let resolveFirst: (result: unknown) => void = () => {}
    const call = vi.fn(async (method: string, input: { sessionId?: string }) => {
      if (method === 'list') return { sessions: rows }
      if (input.sessionId === 'session-a') return new Promise(resolve => { resolveFirst = resolve })
      return { ...emptyDetail, sessionId: 'session-b', messages: [{ seq: 2, role: 'user', blocks: [{ type: 'text', text: 'B 的消息' }] }] }
    }) as unknown as SidebarCall
    await mount(call); await select(); await select(1)
    await act(async () => resolveFirst({ ...emptyDetail, messages: [{ seq: 1, role: 'user', blocks: [{ type: 'text', text: 'A 的旧消息' }] }] }))
    expect(container.querySelector('.st-messages')?.textContent).toContain('B 的消息')
    expect(container.querySelector('.st-messages')?.textContent).not.toContain('A 的旧消息')
  })

  it.each([false, true])('refreshes turn state after writes and cancellation, including delayed admission: %s', async delayed => {
    let status = 'idle'
    let accepted = false
    const call = vi.fn(async (method: string) => {
      if (method === 'list') return { sessions: accepted ? [] : [rows[0]] }
      if (method === 'write') { accepted = true; if (!delayed) status = 'running'; return {} }
      if (method === 'cancel') { status = 'aborted'; return {} }
      return { ...emptyDetail, delegationStatus: status }
    }) as unknown as SidebarCall
    await mount(call); await select()
    const input = container.querySelector('textarea')!
    await act(async () => { input.value = '继续任务'; Simulate.change(input) })
    await act(async () => Simulate.submit(input.closest('form')!))
    expect(call).toHaveBeenCalledWith('write', { sessionId: 'session-a', content: '继续任务' })
    if (delayed) {
      expect(button('停止当前轮次').disabled).toBe(true)
      status = 'running'
      await click(button('刷新消息'))
    }
    expect(container.querySelectorAll('.st-row')).toHaveLength(0)
    expect(button('停止当前轮次').disabled).toBe(false)
    await click(button('停止当前轮次'))
    expect(call).toHaveBeenCalledWith('cancel', { sessionId: 'session-a' })
    expect(button('停止当前轮次').disabled).toBe(true)
  })

  it.each(['refresh', 'reset', 'switch'] as const)('invalidates pending pagination on %s and resumes without skipping pages', async trigger => {
    let reset = () => {}
    let resolvePage: (result: unknown) => void = () => {}
    let pageSignal: AbortSignal | undefined
    let delayPage = true
    const page = (seq: number) => ({ ...emptyDetail, messages: [{ seq, role: 'user', blocks: [{ type: 'text', text: `message-${seq}` }] }] })
    const call = vi.fn(async (method: string, input: { sinceSeq?: number }, signal?: AbortSignal) => {
      if (method === 'list') return { sessions: rows }
      const seq = input.sinceSeq ?? 1
      if (seq === 3 && delayPage) {
        pageSignal = signal
        return new Promise(resolve => { resolvePage = resolve })
      }
      return page(seq)
    }) as unknown as SidebarCall
    await act(async () => root.render(createElement(SessionPanel, {
      call, openSession: vi.fn(), onReset: listener => { reset = listener; return () => {} },
    })))
    await select()
    await click(button('加载后续消息'))
    await click(button('加载后续消息'))
    if (trigger === 'refresh') await click(button('刷新'))
    else if (trigger === 'reset') await act(async () => reset())
    else await select(1)
    expect(pageSignal?.aborted).toBe(true)
    await act(async () => resolvePage(page(3)))
    const messages = () => [...container.querySelectorAll('.st-message pre')].map(element => element.textContent)
    expect(messages()).toEqual(['message-1'])
    delayPage = false
    await click(button('加载后续消息'))
    await click(button('加载后续消息'))
    expect(messages()).toEqual(['message-1', 'message-2', 'message-3'])
    expect(container.querySelector('[role=alert]')).toBeNull()
  })

  it('does not display a pagination abort as an operation failure', async () => {
    const call = vi.fn(async (method: string, input: { sinceSeq?: number }, signal?: AbortSignal) => {
      if (method === 'list') return { sessions: rows }
      if (input.sinceSeq) return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
      })
      return { ...emptyDetail, messages: [{ seq: 1, role: 'user', blocks: [{ type: 'text', text: 'first' }] }] }
    }) as unknown as SidebarCall
    await mount(call); await select()
    await click(button('加载后续消息'))
    await click(button('刷新'))
    expect(container.querySelector('[role=alert]')).toBeNull()
    expect(button('加载后续消息').disabled).toBe(false)
  })

  it('continues message pagination when the provider caps pages below 100 rows', async () => {
    const call = vi.fn(async (method: string, input: { sinceSeq?: number }) => {
      if (method === 'list') return { sessions: rows }
      const seq = input.sinceSeq ?? 1
      return { ...emptyDetail, messages: seq < 3 ? [{ seq, role: 'user', blocks: [{ type: 'text', text: `message-${seq}` }] }] : [] }
    }) as unknown as SidebarCall
    await mount(call); await select()
    await click(button('加载后续消息'))
    expect(container.querySelectorAll('.st-message')).toHaveLength(2)
    await click(button('加载后续消息'))
    expect(container.querySelectorAll('.st-message')).toHaveLength(2)
    expect(container.querySelector('.st-messages')?.textContent).not.toContain('加载后续消息')
  })

  it('uses the server cursor, resets pagination on filters, and preserves a draft on refresh', async () => {
    const call = vi.fn(async (method: string, input: { cursor?: string }) => {
      if (method !== 'list') return emptyDetail
      return input.cursor ? { sessions: [rows[1]] } : { sessions: [rows[0]], nextCursor: 'next' }
    }) as unknown as SidebarCall
    await mount(call)
    await click(button('加载更多会话'))
    expect(container.querySelectorAll('.st-row')).toHaveLength(2)
    await select()
    const input = container.querySelector('textarea')!
    await act(async () => { input.value = '草稿'; Simulate.change(input) })
    await click(button('刷新'))
    expect(container.querySelectorAll('.st-row')).toHaveLength(1)
    expect(container.querySelector('textarea')?.value).toBe('草稿')
    const checkbox = container.querySelector<HTMLInputElement>('input[type=checkbox]')!
    await click(checkbox)
    expect(call).toHaveBeenCalledWith('list', expect.objectContaining({ includeHidden: true }), expect.any(AbortSignal))
  })
})
