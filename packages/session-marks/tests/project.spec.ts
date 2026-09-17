import { describe, expect, it } from 'vitest'
import {
  badgeChips,
  compactName,
  hasProjectedBadge,
  projectMarks,
  resolveIcon,
  tokenKind,
} from '../src/project.ts'

describe('projectMarks', () => {
  it('infers 插件 from app: without form:', () => {
    const inferred = projectMarks({ title: 'x', tags: ['app:dsh-bot'] })
    expect(inferred.kind).toBe('插件')
    expect(inferred.kindInferred).toBe(true)
    expect(resolveIcon('form', inferred.kind, { form: inferred.form })).toBe('plugin')
  })

  it('keeps unknown form/app as text without an icon', () => {
    const unknown = projectMarks({ title: 'x', tags: ['app:acme', 'form:notebook'] })
    expect(unknown.kind).toBe('notebook')
    expect(unknown.product).toBe('acme')
    expect(unknown.kindInferred).toBe(false)
    expect(resolveIcon('form', 'notebook', { form: 'notebook' })).toBeUndefined()
  })

  it('classifies axis vs alias vs unprojected tokens', () => {
    expect(tokenKind('parent:session-main')).toBe('axis')
    expect(tokenKind('hidden')).toBe('axis')
    expect(tokenKind('kind:hidden')).toBe('alias')
    expect(tokenKind('child')).toBe('axis')
    expect(tokenKind('delegated')).toBe('alias')
    expect(tokenKind('kind:dsh-bot-chat')).toBe('unprojected')
    expect(tokenKind('ui:aux')).toBe('unprojected')
    expect(tokenKind('plan')).toBe('free')
  })

  it('treats title ~ as orthogonal to hidden marks', () => {
    const tilde = projectMarks({ title: '~ 草稿', tags: ['form:agent'] })
    expect(tilde.titleHidden).toBe(true)
    expect(tilde.hidden).toBe(false)
    expect(tilde.kind).toBe('Agent')
  })

  it('reads legacy kind + orphan child without inventing parent', () => {
    const orphan = projectMarks({ title: 'x', tags: ['kind:vibee', 'delegated'] })
    expect(orphan.app).toBe('vibee')
    expect(orphan.appExplicit).toBe(false)
    expect(orphan.child).toBe(true)
    expect(orphan.parent).toBeUndefined()
  })

  it('prefers group-room over group and leaves chat tokens unprojected', () => {
    const room = projectMarks({ title: 'x', tags: ['group-room:lobby', 'group:night-shift'] })
    expect(room.instance).toEqual({ key: 'group-room', value: 'lobby' })
    const chat = projectMarks({
      title: 'x',
      tags: ['app:dsh-bot', 'form:plugin', 'bot:xiaobei', 'kind:dsh-bot-chat', 'ui:aux'],
    })
    expect(chat.unprojected).toEqual(['kind:dsh-bot-chat', 'ui:aux'])
    expect(chat.name).toBe('小北')
    expect(compactName(chat)).toBe('小北')
  })

  it('hides the header when there is nothing to project', () => {
    expect(hasProjectedBadge(projectMarks({ title: '旧会话', tags: [] }))).toBe(false)
    expect(hasProjectedBadge(projectMarks({ title: 'x', tags: ['app:dsh-bot'] }))).toBe(true)
  })

  it('emits form chip first then present axes', () => {
    const chips = badgeChips(projectMarks({
      title: '~dsh-bot: 小北',
      tags: ['app:dsh-bot', 'kind:dsh-bot', 'form:plugin', 'bot:xiaobei', 'hidden', 'kind:hidden'],
    }))
    expect(chips.map(chip => chip.axis)).toEqual(['form', 'app', 'name', 'hidden'])
    expect(chips[0]?.icon).toBe('plugin')
    expect(chips[2]?.name).toBe('小北')
  })
})
