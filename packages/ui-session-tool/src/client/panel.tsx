import { useEffect, useRef, useState } from 'react'
import { projectMarks } from '../../../session-marks/src/project.ts'
import type { SessionToolListRow, SessionToolMessageRow } from 'session-tool'
import type { SidebarApi, SidebarCall } from '../contract.ts'
import { MarksChips } from './marks-chips.tsx'
import { badgeStyles, styles } from './styles.ts'

export interface PanelProps {
  call: SidebarCall
  openSession: (id: string) => Promise<void>
  onReset: (listener: () => void) => () => void
}

const statusLabels: Record<string, string> = {
  idle: '空闲', running: '运行中', completed: '已完成', failed: '失败', aborted: '已停止', 'max-tokens': '达到输出上限',
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试'

export function SessionPanel({ call, openSession, onReset }: PanelProps) {
  const [query, setQuery] = useState<SidebarApi['list']['input']>({})
  const [search, setSearch] = useState('')
  const [revision, setRevision] = useState(0)
  const [rows, setRows] = useState<readonly SessionToolListRow[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [selected, setSelected] = useState<SessionToolListRow>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refresh = () => { setQuery(q => { const { cursor: _, ...filter } = q; return filter }); setRevision(n => n + 1) }

  function filter(patch: { [K in keyof SidebarApi['list']['input']]?: SidebarApi['list']['input'][K] | undefined }) {
    setQuery(q => Object.fromEntries(Object.entries({ ...q, ...patch }).filter(([key, value]) => key !== 'cursor' && value !== undefined)) as SidebarApi['list']['input'])
  }
  useEffect(() => { const timer = setTimeout(() => filter({ title: search }), 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => onReset(() => { setQuery(q => { const { cursor: _, ...filter } = q; return filter }); setRevision(n => n + 1) }), [onReset])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void call('list', query, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setRows(old => query.cursor ? [...old, ...result.sessions.filter(row => !old.some(existing => existing.sessionId === row.sessionId))] : result.sessions)
      setNextCursor(result.nextCursor)
      setSelected(old => old ? result.sessions.find(row => row.sessionId === old.sessionId) ?? old : undefined)
    }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [call, query, revision])

  return <section className="st-panel" aria-label="会话协作">
    <style>{styles}{badgeStyles}</style>
    <header><div><h1>会话协作</h1><p>浏览持久会话，查看插件标记，继续处理任务。</p></div><button onClick={refresh} disabled={loading}>刷新</button></header>
    <div className="st-filters">
      <input aria-label="搜索会话标题" placeholder="搜索会话标题" value={search} onChange={event => setSearch(event.target.value)} />
      <select aria-label="会话范围" value={query.origin ?? ''} onChange={event => filter({ origin: event.target.value ? 'delegated' : undefined })}>
        <option value="">全部会话</option><option value="delegated">委派会话</option>
      </select>
      <select aria-label="运行状态" value={query.status ?? ''} onChange={event => filter({ status: (event.target.value || undefined) as SidebarApi['list']['input']['status'] })}>
        <option value="">全部状态</option>{['running', 'completed', 'failed', 'aborted'].map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}
      </select>
      <label><input type="checkbox" checked={query.includeHidden ?? false} onChange={event => filter({ includeHidden: event.target.checked })} />包含隐藏</label>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="st-columns">
      <nav className="st-list" aria-label="协作会话列表" aria-busy={loading}>
        {loading && <p role="status">正在加载…</p>}
        {!loading && !error && rows.length === 0 && <p>没有符合条件的会话。</p>}
        {rows.map(row => <button className="st-row" key={row.sessionId} aria-pressed={selected?.sessionId === row.sessionId} onClick={() => setSelected(row)}>
          <strong>{row.title || '未命名会话'}</strong>
          <span>{row.delegationStatus ? statusLabels[row.delegationStatus] : '执行状态未知'} · {row.status === 'live' ? '已驻留' : '未驻留'}{row.archived ? ' · 已归档' : ''}</span>
          <span className="st-tags"><MarksChips projection={projectMarks({ ...row.title === undefined ? {} : { title: row.title }, tags: row.tags })} /></span>
          <code>{row.sessionId}</code>
        </button>)}
        {nextCursor && <button disabled={loading} onClick={() => setQuery(q => ({ ...q, cursor: nextCursor }))}>加载更多会话</button>}
      </nav>
      {selected ? <SessionDetail key={selected.sessionId} listRevision={revision} row={selected} call={call} openSession={openSession} changed={refresh} /> : <div className="st-empty">选择会话查看消息和操作。</div>}
    </div>
  </section>
}

function SessionDetail({ row, call, openSession, changed, listRevision }: {
  row: SessionToolListRow; call: SidebarCall; openSession: PanelProps['openSession']; changed: () => void; listRevision: number
}) {
  const [detail, setDetail] = useState<SidebarApi['read']['output']>()
  const [title, setTitle] = useState(row.title ?? '')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const locked = useRef(false)
  const readController = useRef<AbortController>()
  useEffect(() => {
    const controller = new AbortController()
    readController.current = controller
    setLoading(true); setError('')
    void call('read', { sessionId: row.sessionId }, controller.signal).then(result => {
      if (!controller.signal.aborted) { setDetail(result); setMore(result.messages.length > 0) }
    }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [call, row.sessionId, revision, listRevision])

  async function act(action: () => Promise<unknown>, message: string, refreshList = false) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    try { await action(); setNotice(message); if (refreshList) changed() }
    catch (error) { setError(errorText(error)) }
    finally { locked.current = false; setBusy(false) }
  }

  return <article className="st-detail" aria-label="会话详情">
    <h2>{row.title || '未命名会话'}</h2><code>{row.sessionId}</code>
    <div className="st-actions">
      <button disabled={busy} onClick={() => void act(() => openSession(row.sessionId), '')}>在对话中打开</button>
      <button disabled={busy || loading} onClick={changed}>刷新消息</button>
      <button disabled={busy || (detail ? detail.delegationStatus : row.delegationStatus) !== 'running'} onClick={() => void act(() => call('cancel', { sessionId: row.sessionId }), '已请求停止当前轮次。', true)}>停止当前轮次</button>
      <button disabled={busy || !detail} onClick={() => void act(async () => {
        const method = detail?.visibility.isHidden ? 'unhide' : 'hide'
        await call(method, { sessionId: row.sessionId }); setRevision(n => n + 1)
      }, detail?.visibility.isHidden ? '已取消隐藏，会话会回到官方侧栏。' : '已隐藏会话（官方侧栏不再显示）。', true)}>{detail?.visibility.isHidden ? '取消隐藏' : '隐藏会话'}</button>
    </div>
    <p className="st-note">隐藏会打 hidden 标记，并从官方侧栏归档。取消隐藏会把会话放回侧栏。</p>
    <form className="st-rename" onSubmit={event => { event.preventDefault(); void act(() => call('rename', { sessionId: row.sessionId, title: title.trim() }), '标题已保存。', true) }}>
      <input aria-label="会话标题" value={title} onChange={event => setTitle(event.target.value)} maxLength={4096} />
      <button disabled={busy || !title.trim()}>保存标题</button>
    </form>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="st-messages" aria-busy={loading}>
      {loading && <p role="status">正在读取消息…</p>}
      {detail?.messages.length === 0 && <p>会话还没有消息。</p>}
      {detail?.messages.map(message => <Message key={message.seq} message={message} />)}
      {more && <button disabled={busy || loading} onClick={() => void act(async () => {
        const last = detail?.messages.at(-1)
        const signal = readController.current?.signal
        if (!last || !signal || signal.aborted) return
        try {
          const result = await call('read', { sessionId: row.sessionId, sinceSeq: last.seq + 1 }, signal)
          if (signal.aborted) return
          setDetail(old => old ? { ...result, messages: [...old.messages, ...result.messages] } : result)
          setMore(result.messages.length > 0)
        } catch (error) { if (!signal.aborted) throw error }
      }, '')}>加载后续消息</button>}
    </div>
    <form className="st-compose" onSubmit={event => { event.preventDefault(); void act(async () => {
      await call('write', { sessionId: row.sessionId, content: draft.trim() }); setDraft('')
    }, '消息已接收；可刷新消息或在对话中查看执行状态。', true) }}>
      <textarea aria-label="续写内容" placeholder="向此会话发送后续指令…" value={draft} onChange={event => setDraft(event.target.value)} maxLength={100000} disabled={busy} />
      <button disabled={busy || !draft.trim()}>发送续写</button>
    </form>
  </article>
}

function Message({ message }: { message: SessionToolMessageRow }) {
  return <section className="st-message"><strong>{({ user: '用户', assistant: '助手', tool: '工具' })[message.role]}</strong>
    {message.blocks.map((block, index) => <pre key={index}>{'text' in block && typeof block.text === 'string' ? block.text : `[${block.type}]`}</pre>)}
  </section>
}
