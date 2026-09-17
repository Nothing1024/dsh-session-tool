import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  compactName,
  hasProjectedBadge,
  inspectorRows,
  projectMarks,
  type MarksProjection,
} from '../../../session-marks/src/project.ts'
import type { SidebarCall } from '../contract.ts'
import { MarkIcon } from './marks-icon.tsx'
import { MarksChips } from './marks-chips.tsx'
import { badgeStyles } from './styles.ts'

interface SessionListSnapshot {
  readonly byId: Readonly<Record<string, { readonly title?: string } | undefined>>
}

export interface SessionMarksBadgeProps {
  readonly sessionId: SessionId
  readonly useSessions: <T>(selector: (state: SessionListSnapshot) => T) => T
  readonly call: SidebarCall
}

export function SessionMarksBadge({ sessionId, useSessions, call }: SessionMarksBadgeProps) {
  const title = useSessions(state => state.byId[sessionId]?.title)
  const [projection, setProjection] = useState<MarksProjection>()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    setProjection(undefined)
    setOpen(false)
    void call('marks', { sessionId }, controller.signal).then(view => {
      if (!controller.signal.aborted) {
        setProjection(projectMarks({
          ...title === undefined ? {} : { title },
          tags: view.tags,
        }, { hiddenPrefixes: view.hiddenPrefixes }))
      }
    }).catch(() => {
      if (!controller.signal.aborted) setProjection(undefined)
    })
    return () => controller.abort()
  }, [call, sessionId, title])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (projection === undefined || !hasProjectedBadge(projection)) return null
  return <div ref={rootRef} className="st-badge">
    <style>{badgeStyles}</style>
    <MarksChips projection={projection} />
    <button
      type="button"
      className={open ? 'st-badge-detail is-on' : 'st-badge-detail'}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls="session-marks-params"
      aria-label={`会话标记详情：${compactName(projection)}`}
      onClick={() => setOpen(current => !current)}
    >
      <MarkIcon name="info" />
      详情
    </button>
    {open
      ? <div className="st-badge-pop" id="session-marks-params" role="dialog" aria-label="会话标记">
          {inspectorRows(projection).map(row =>
            <div key={row.axis} className={row.empty ? 'st-badge-row is-empty' : 'st-badge-row'} data-axis={row.axis}>
              <span className="k">{row.label}</span>
              <span className="val">{row.icon === undefined ? null : <MarkIcon name={row.icon} />}{row.value}</span>
              <span className="token">{row.token}</span>
            </div>)}
          {projection.unprojected.length > 0
            ? <div className="st-badge-unprojected">
                <span className="k">未投影</span>
                {projection.unprojected.map(tag => <code key={tag}>{tag}</code>)}
              </div>
            : null}
        </div>
      : null}
  </div>
}
