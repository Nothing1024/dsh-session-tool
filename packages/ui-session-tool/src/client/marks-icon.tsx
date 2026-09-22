import { MARK_ICONS, type MarkIconKey } from 'session-marks/project'

export function MarkIcon({ name }: { name: MarkIconKey }) {
  const spec = MARK_ICONS[name]
  return <svg className="st-ico" viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true" focusable="false">
    {(spec.paths ?? []).map(d =>
      <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />)}
    {(spec.circles ?? []).map(circle =>
      <circle
        key={`${circle.cx}-${circle.cy}-${circle.r}`}
        cx={circle.cx}
        cy={circle.cy}
        r={circle.r}
        fill={circle.fill ? 'currentColor' : 'none'}
        stroke={circle.fill ? 'none' : 'currentColor'}
        strokeWidth={circle.fill ? 0 : 1.4}
      />)}
  </svg>
}
