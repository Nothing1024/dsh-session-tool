import { badgeChips, type MarksProjection } from '../../../session-marks/src/project.ts'
import { MarkIcon } from './marks-icon.tsx'

export function MarksChips({ projection }: { projection: MarksProjection }) {
  return <span className="st-chips">
    {badgeChips(projection).map(chip =>
      <span
        key={`${chip.axis}:${chip.value}`}
        className={chip.icon === undefined ? 'st-chip' : 'st-chip has-ico'}
        data-axis={chip.axis}
        data-app={chip.app}
        title={chip.hint}
      >
        {chip.icon === undefined ? null : <MarkIcon name={chip.icon} />}
        {chip.icon === undefined && chip.axis !== 'free' && chip.category !== chip.name
          ? <span className="k">{chip.category}</span>
          : null}
        <span className="v">{chip.name}</span>
      </span>)}
  </span>
}
