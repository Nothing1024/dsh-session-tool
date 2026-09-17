/**
 * Human-facing projection of a plugin mark set. Pure: no filesystem, no
 * Node builtins. Browser UI and Node tests import this file; the jsonl
 * table stays in {@link ./index.ts}.
 *
 * Axes: form / app / instance / child / hidden. Historical aliases
 * (`kind:hidden`, `kind:delegated`, `kind:vibee`, …) are readable and
 * suppressed, not shown as their own chips.
 */

import { MARK_PREFIXES, hasChildMark, hasHiddenMark, isChildToken, isHiddenToken, isTitleHidden } from './tokens.ts'

/** Closed icon keys the UI can render as SVG. Unknown values stay text. */
export type MarkIconKey =
  | 'plugin'
  | 'agent'
  | 'cli'
  | 'script'
  | 'dsh-bot'
  | 'vibee'
  | 'person'
  | 'run'
  | 'group'
  | 'room'
  | 'peer'
  | 'routine'
  | 'child'
  | 'hidden'
  | 'info'

/** How one stored token participates in the projection. */
export type MarkTokenKind = 'axis' | 'alias' | 'free' | 'unprojected'

/** Product instance key (`bot:xiaobei` → `{ key: 'bot', value: 'xiaobei' }`). */
export interface MarksInstance {
  readonly key: string
  readonly value: string
}

/** One projected mark set. Empty strings mean that axis is absent. */
export interface MarksProjection {
  readonly app: string
  readonly appExplicit: boolean
  readonly appAlias: string
  readonly form: string
  readonly formMapped: boolean
  readonly instance: MarksInstance | undefined
  readonly child: boolean
  readonly hidden: boolean
  readonly titleHidden: boolean
  readonly parent: string | undefined
  readonly free: readonly string[]
  readonly unprojected: readonly string[]
  readonly suppressed: readonly string[]
  readonly kind: string
  readonly kindInferred: boolean
  readonly product: string
  readonly name: string
  readonly nameKind: string
}

/** Input for {@link projectMarks}. */
export interface ProjectMarksInput {
  readonly title?: string
  readonly tags?: readonly string[]
}

/** Optional title-prefix list; default matches session-tool-local `hiddenPrefixes`. */
export interface ProjectMarksOptions {
  readonly hiddenPrefixes?: readonly string[]
}

/** One row in the header params inspector. */
export interface MarksInspectorRow {
  readonly axis: 'form' | 'app' | 'name' | 'child' | 'hidden' | 'free'
  readonly label: string
  readonly value: string
  readonly token: string
  readonly icon: MarkIconKey | undefined
  readonly empty: boolean
  readonly raw: string
}

/** Path/circle spec for a 16×16 currentColor glyph. */
export interface MarkIconSpec {
  readonly paths?: readonly string[]
  readonly circles?: readonly { readonly cx: number; readonly cy: number; readonly r: number; readonly fill?: boolean }[]
}

const KIND_APP: Readonly<Record<string, string>> = {
  'kind:vibee': 'vibee',
  'kind:dsh-bot': 'dsh-bot',
}

const INSTANCE_PREFIXES = ['bot:', 'vibee:', 'group-room:', 'group:', 'peer:', 'routine:'] as const

const FORM_LABEL: Readonly<Record<string, string>> = {
  plugin: '插件',
  agent: 'Agent',
  cli: 'CLI',
  script: '脚本',
}

const PRODUCT_LABEL: Readonly<Record<string, string>> = {
  'dsh-bot': 'dsh-bot',
  vibee: 'vibee',
}

const INSTANCE_KIND: Readonly<Record<string, string>> = {
  bot: '人设',
  vibee: '运行',
  group: '群',
  'group-room': '房间',
  peer: '对端',
  routine: '例行',
}

const INSTANCE_NAME: Readonly<Record<string, string>> = {
  xiaobei: '小北',
  'run-1842': 'run-1842',
  'night-shift': '夜班群',
  lobby: '大厅',
  morning: '晨间',
}

const ICON_BY_FORM: Readonly<Record<string, MarkIconKey>> = {
  plugin: 'plugin',
  agent: 'agent',
  cli: 'cli',
  script: 'script',
}

const ICON_BY_PRODUCT: Readonly<Record<string, MarkIconKey>> = {
  'dsh-bot': 'dsh-bot',
  vibee: 'vibee',
}

const ICON_BY_INSTANCE: Readonly<Record<string, MarkIconKey>> = {
  bot: 'person',
  vibee: 'run',
  group: 'group',
  'group-room': 'room',
  peer: 'peer',
  routine: 'routine',
}



/** SVG geometry for mapped axes. Unmapped tokens have no entry. */
export const MARK_ICONS: Readonly<Record<MarkIconKey, MarkIconSpec>> = {
  plugin: {
    paths: ['M6 2.5v3.5M10 2.5v3.5', 'M4.5 6h7v3.2a3.5 3.5 0 0 1-7 0z', 'M8 9.2v4.3'],
  },
  agent: {
    paths: [
      'M8 2.2l1.15 3.2 3.35 1.1-3.35 1.1L8 10.8 6.85 7.6 3.5 6.5l3.35-1.1z',
      'M12.6 10.2l.55 1.5 1.55.55-1.55.55-.55 1.5-.55-1.5-1.55-.55 1.55-.55z',
    ],
  },
  cli: {
    paths: ['M2.5 3.5h11v9h-11z', 'M5 6.4l2 1.8-2 1.8', 'M8.2 10.4H11'],
  },
  script: {
    paths: ['M5 2.5h5.2L13 5.3v8.2H5z', 'M10.2 2.5v2.8H13', 'M6.6 8.4h4', 'M6.6 10.6h2.8'],
  },
  'dsh-bot': {
    paths: ['M8 2.2v1.8', 'M4.2 5h7.6v7.2H4.2z', 'M6.2 11h3.6'],
    circles: [
      { cx: 6.4, cy: 8.1, r: 0.7, fill: true },
      { cx: 9.6, cy: 8.1, r: 0.7, fill: true },
    ],
  },
  vibee: {
    paths: ['M8 2.3l4.6 2.65v5.3L8 13.6 3.4 10.95v-5.3z', 'M8 5.8v4.4'],
  },
  person: {
    paths: ['M8 3.3a2 2 0 1 1 0 4 2 2 0 1 1 0-4z', 'M3.6 13.2c.2-2.6 2-4 4.4-4s4.2 1.4 4.4 4'],
  },
  run: {
    paths: ['M6 3.6l6.4 4.4L6 12.4z'],
  },
  group: {
    paths: [
      'M6.2 3.4a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 1 1 0-3.4z',
      'M2.6 12.6c.15-2.1 1.6-3.2 3.6-3.2s3.45 1.1 3.6 3.2',
      'M10.6 4.2a1.5 1.5 0 1 1 0 2.8',
      'M11.2 9.4c1.5.2 2.5 1.2 2.6 3.2',
    ],
  },
  room: {
    paths: ['M3 13V7.2L8 3.4l5 3.8V13H9.6V9.4H6.4V13z'],
  },
  peer: {
    paths: ['M6.4 8h3.2'],
    circles: [
      { cx: 4.2, cy: 8, r: 2 },
      { cx: 11.8, cy: 8, r: 2 },
    ],
  },
  routine: {
    paths: ['M8 3.2a4.8 4.8 0 1 1-4.2 2.5', 'M3.2 3.3v2.6h2.6', 'M8 6.2V8.4l1.8 1.2'],
  },
  child: {
    paths: ['M4.6 3.2v9.6', 'M4.6 8.2c3.2 0 3.4-2.4 5.6-2.4'],
    circles: [
      { cx: 4.6, cy: 3.4, r: 1.15, fill: true },
      { cx: 4.6, cy: 12.6, r: 1.15, fill: true },
      { cx: 11.4, cy: 5.8, r: 1.15, fill: true },
    ],
  },
  hidden: {
    paths: [
      'M2.2 8c2.3-3.6 9.3-3.6 11.6 0-2.3 3.6-9.3 3.6-11.6 0z',
      'M8 6.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 1 1 0-3.2z',
      'M3.2 12.8 12.8 3.2',
    ],
  },
  info: {
    paths: ['M8 7.4v4.1', 'M8 5.05v.15'],
    circles: [{ cx: 8, cy: 8, r: 5.35 }],
  },
}

function firstPrefix(tags: readonly string[], prefix: string): string | undefined {
  const hit = tags.find(tag => tag.startsWith(prefix))
  return hit === undefined || hit.length === prefix.length ? undefined : hit.slice(prefix.length)
}

/** Classify one stored token for inspector / debug coloring. */
export function tokenKind(tag: string): MarkTokenKind {
  if (tag === 'hidden' || tag === 'child') return 'axis'
  if ((isHiddenToken(tag) || isChildToken(tag)) && tag !== 'hidden' && tag !== 'child') return 'alias'
  if (
    tag.startsWith(MARK_PREFIXES.app)
    || tag.startsWith(MARK_PREFIXES.form)
    || tag.startsWith(MARK_PREFIXES.parent)
  ) return 'axis'
  if (KIND_APP[tag] !== undefined) return 'alias'
  if (INSTANCE_PREFIXES.some(prefix => tag.startsWith(prefix))) return 'axis'
  if (!tag.includes(':')) return 'free'
  return 'unprojected'
}

/**
 * Project a title + mark set onto the five human axes.
 * Unknown `form:` / `app:` values stay as their raw names (text fallback).
 */
export function projectMarks(
  input: ProjectMarksInput,
  options: ProjectMarksOptions = {},
): MarksProjection {
  const tags = input.tags ?? []
  const hidden = hasHiddenMark(tags)
  const child = hasChildMark(tags)
  const titleHidden = isTitleHidden(input.title, options.hiddenPrefixes ?? ['~'])
  const appExplicit = firstPrefix(tags, MARK_PREFIXES.app)
  let appAlias = ''
  let appFromKind = ''
  for (const tag of tags) {
    const mapped = KIND_APP[tag]
    if (mapped !== undefined) {
      appAlias = tag
      appFromKind = mapped
      break
    }
  }
  const app = appExplicit ?? appFromKind
  const form = firstPrefix(tags, MARK_PREFIXES.form) ?? ''
  const parent = firstPrefix(tags, MARK_PREFIXES.parent)
  let instance: MarksInstance | undefined
  for (const prefix of INSTANCE_PREFIXES) {
    const value = firstPrefix(tags, prefix)
    if (value !== undefined) {
      instance = { key: prefix.slice(0, -1), value }
      break
    }
  }
  const free: string[] = []
  const unprojected: string[] = []
  const suppressed: string[] = []
  for (const tag of tags) {
    const kind = tokenKind(tag)
    if (kind === 'free') free.push(tag)
    else if (kind === 'unprojected') unprojected.push(tag)
    else if (kind === 'alias') suppressed.push(tag)
  }
  const formMapped = form !== '' && FORM_LABEL[form] !== undefined
  const kind = form !== ''
    ? (FORM_LABEL[form] ?? form)
    : (app !== undefined && app !== '' ? '插件' : '')
  const product = app !== undefined && app !== '' ? (PRODUCT_LABEL[app] ?? app) : ''
  const name = instance === undefined ? '' : (INSTANCE_NAME[instance.value] ?? instance.value)
  const nameKind = instance === undefined ? '' : (INSTANCE_KIND[instance.key] ?? instance.key)
  return {
    app: app ?? '',
    appExplicit: Boolean(appExplicit),
    appAlias,
    form,
    formMapped,
    instance,
    child,
    hidden,
    titleHidden,
    parent,
    free,
    unprojected,
    suppressed,
    kind,
    kindInferred: form === '' && Boolean(app),
    product,
    name,
    nameKind,
  }
}

/** Compact label for a corner/chip trigger. */
export function compactName(projection: MarksProjection): string {
  return projection.name || projection.product || projection.kind || '无归属'
}

/** Whether the header should render anything for this projection. */
export function hasProjectedBadge(projection: MarksProjection): boolean {
  return projection.kind !== ''
    || projection.product !== ''
    || projection.name !== ''
    || projection.child
    || projection.hidden
    || projection.titleHidden
    || projection.free.length > 0
}

export function resolveIcon(
  axis: string,
  value: string,
  extra?: { readonly form?: string; readonly instanceKey?: string },
): MarkIconKey | undefined {
  if (axis === 'form') {
    const form = extra?.form
    if (form !== undefined && form !== '' && ICON_BY_FORM[form] !== undefined) return ICON_BY_FORM[form]
    if ((form === undefined || form === '') && value === '插件') return 'plugin'
    return undefined
  }
  if (axis === 'app') return ICON_BY_PRODUCT[value]
  if (axis === 'name') {
    const key = extra?.instanceKey
    return key === undefined ? undefined : ICON_BY_INSTANCE[key]
  }
  if (axis === 'child') return 'child'
  if (axis === 'hidden') return 'hidden'
  return undefined
}

export function formHint(projection: MarksProjection): string {
  if (projection.form !== '') {
    return projection.formMapped
      ? `form:${projection.form}`
      : `未知形态 form:${projection.form}（无图标）`
  }
  if (projection.app !== '') {
    return projection.appExplicit
      ? `无 form:，由 app:${projection.app} 推断为插件`
      : `无 form:，由 ${projection.appAlias} 推断为插件`
  }
  return '无类别'
}

export function appHint(projection: MarksProjection): string {
  if (projection.app === '') return '无产品'
  if (projection.appExplicit) return `app:${projection.app}`
  return `未写 app:，由 ${projection.appAlias} 推断`
}

export function visibilityValue(projection: MarksProjection): string {
  if (projection.hidden) return '隐藏'
  if (projection.titleHidden) return '标题~'
  return '可见'
}

export function visibilityHint(projection: MarksProjection): string {
  if (projection.hidden && projection.titleHidden) return 'hidden 标记 + 标题 hiddenPrefix（正交）'
  if (projection.hidden) return 'hidden ≡ kind:hidden'
  if (projection.titleHidden) return '仅标题 ~，无 hidden 标记'
  return '官方栏可见'
}

/** Content chips: form always, then present axes, then free tags. */
export function badgeChips(projection: MarksProjection): readonly {
  readonly axis: string
  readonly value: string
  readonly category: string
  readonly name: string
  readonly icon: MarkIconKey | undefined
  readonly hint: string
  readonly app: string
}[] {
  const chips: {
    readonly axis: string
    readonly value: string
    readonly category: string
    readonly name: string
    readonly icon: MarkIconKey | undefined
    readonly hint: string
    readonly app: string
  }[] = [{
    axis: 'form',
    value: projection.kind || 'none',
    category: '类别',
    name: projection.kind || '无',
    icon: resolveIcon('form', projection.kind, { form: projection.form }),
    hint: formHint(projection),
    app: projection.app,
  }]
  if (projection.product !== '') {
    chips.push({
      axis: 'app',
      value: projection.product,
      category: '产品',
      name: projection.product,
      icon: resolveIcon('app', projection.product),
      hint: appHint(projection),
      app: projection.app,
    })
  }
  if (projection.instance !== undefined && projection.name !== '') {
    chips.push({
      axis: 'name',
      value: projection.instance.value,
      category: projection.nameKind || '名字',
      name: projection.name,
      icon: resolveIcon('name', projection.instance.value, { instanceKey: projection.instance.key }),
      hint: `${projection.instance.key}:${projection.instance.value}`,
      app: projection.app,
    })
  }
  if (projection.child) {
    chips.push({
      axis: 'child',
      value: '1',
      category: '关系',
      name: '子会话',
      icon: 'child',
      hint: projection.parent === undefined ? 'child（无 parent:）' : `parent:${projection.parent}`,
      app: projection.app,
    })
  }
  if (projection.hidden) {
    chips.push({
      axis: 'hidden',
      value: '1',
      category: '可见',
      name: '隐藏',
      icon: 'hidden',
      hint: visibilityHint(projection),
      app: projection.app,
    })
  } else if (projection.titleHidden) {
    chips.push({
      axis: 'hidden',
      value: 'tilde',
      category: '可见',
      name: '标题~',
      icon: 'hidden',
      hint: visibilityHint(projection),
      app: projection.app,
    })
  }
  for (const tag of projection.free) {
    chips.push({
      axis: 'free',
      value: tag,
      category: '标签',
      name: tag,
      icon: undefined,
      hint: tag,
      app: projection.app,
    })
  }
  return chips
}

export function inspectorRows(projection: MarksProjection): readonly MarksInspectorRow[] {
  return [
    {
      axis: 'form',
      label: '类别',
      value: projection.kind || '—',
      token: formHint(projection),
      icon: resolveIcon('form', projection.kind, { form: projection.form }),
      empty: projection.kind === '',
      raw: projection.form || projection.kind,
    },
    {
      axis: 'app',
      label: '产品',
      value: projection.product || '—',
      token: appHint(projection),
      icon: projection.product === '' ? undefined : resolveIcon('app', projection.product),
      empty: projection.app === '',
      raw: projection.app,
    },
    {
      axis: 'name',
      label: '名字',
      value: projection.name || '—',
      token: projection.instance === undefined
        ? '无实例键'
        : `${projection.nameKind} · ${projection.instance.key}:${projection.instance.value}`,
      icon: projection.instance === undefined
        ? undefined
        : resolveIcon('name', projection.instance.value, { instanceKey: projection.instance.key }),
      empty: projection.instance === undefined,
      raw: projection.instance?.value ?? '',
    },
    {
      axis: 'child',
      label: '关系',
      value: projection.child ? '子会话' : '根会话',
      token: projection.parent === undefined
        ? (projection.child ? '有 child，无 parent:（不完整）' : '无父')
        : `parent:${projection.parent}`,
      icon: projection.child ? 'child' : undefined,
      empty: !projection.child,
      raw: '1',
    },
    {
      axis: 'hidden',
      label: '可见',
      value: visibilityValue(projection),
      token: visibilityHint(projection),
      icon: (projection.hidden || projection.titleHidden) ? 'hidden' : undefined,
      empty: !projection.hidden && !projection.titleHidden,
      raw: projection.hidden ? '1' : (projection.titleHidden ? 'tilde' : ''),
    },
    {
      axis: 'free',
      label: '自由',
      value: projection.free.length > 0 ? projection.free.join(', ') : '—',
      token: projection.free.length > 0 ? '无冒号，无图标映射' : '无自由标签',
      icon: undefined,
      empty: projection.free.length === 0,
      raw: projection.free[0] ?? '',
    },
  ]
}
