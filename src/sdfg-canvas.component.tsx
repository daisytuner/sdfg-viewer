import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Map as MapIcon,
  Minus,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { layoutSdfg, FONT } from './layout'
import type { LaidNode, LaidNodeKind, SdfgLayout } from './layout'
import type { OverlayMode, SdfgHighlight, SdfgRegionAnnotation, StructuredSdfg } from './types'
import { resolveHighlights } from './highlights'

const MIN_SCALE = 0.05
const MAX_SCALE = 8

// Minimap box (CSS px). Filled independently on each axis so tall graphs still
// get a large, usable minimap instead of a thin sliver.
const MM_W = 200
const MM_H = 320

// Vertical spacing between wrapped header lines; must match layout's LINE_H.
const HEADER_LINE_H = 14
const fmtUs = (us: number): string => {
  if (us < 1e3) return `${Math.round(us)} µs`
  if (us < 1e6) return `${(us / 1e3).toFixed(1)} ms`
  return `${(us / 1e6).toFixed(2)} s`
}

type Style = { fill: string; stroke: string; text: string; dash?: number[] }

const STYLES: Record<LaidNodeKind, Style> = {
  block: { fill: '#ffffff', stroke: '#cbd5e1', text: '#334155' },
  loop: { fill: '#eef2ff', stroke: '#a5b4fc', text: '#4338ca' },
  if_else: { fill: '#fffbeb', stroke: '#fcd34d', text: '#b45309' },
  branch: { fill: '#f8fafc', stroke: '#cbd5e1', text: '#64748b', dash: [4, 3] },
  assignment: { fill: '#f1f5f9', stroke: '#cbd5e1', text: '#475569' },
  terminator: { fill: '#fff1f2', stroke: '#fda4af', text: '#be123c' },
  access_node: { fill: '#f0fdfa', stroke: '#5eead4', text: '#0f766e' },
  tasklet: { fill: '#f8fafc', stroke: '#94a3b8', text: '#334155' },
  library_node: { fill: '#f5f3ff', stroke: '#c4b5fd', text: '#6d28d9' },
  constant_node: { fill: '#f9fafb', stroke: '#d1d5db', text: '#4b5563' },
}

const HEADER_KINDS = new Set<LaidNodeKind>(['loop', 'if_else', 'branch'])
const LEAF_KINDS = new Set<LaidNodeKind>([
  'access_node',
  'tasklet',
  'library_node',
  'constant_node',
])

type View = { scale: number; x: number; y: number }

export const SdfgCanvas = ({
  doc,
  regions,
  highlights,
  selectedElementId,
  focusSelected = false,
  onSelectRegion,
  onSelectElement,
  onDeselect,
  controls = true,
}: {
  doc: StructuredSdfg
  regions?: SdfgRegionAnnotation[]
  /** Always-visible element markers (tone + label), independent of the overlay dropdown. */
  highlights?: SdfgHighlight[]
  selectedElementId?: number
  /** Pan and zoom to `selectedElementId` whenever it changes. */
  focusSelected?: boolean
  onSelectRegion?: (elementId: number) => void
  onSelectElement?: (elementId: number, kind: string) => void
  onDeselect?: () => void
  /** Show the overlay dropdown + minimap. Off for small region cutouts. */
  controls?: boolean
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<OverlayMode>('none')
  const [minimapOpen, setMinimapOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(
    null,
  )
  const mmDrag = useRef<{ ox: number; oy: number } | null>(null)

  const layout: SdfgLayout | null = useMemo(() => {
    if (!doc?.root) return null
    try {
      return layoutSdfg(doc)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[SdfgCanvas] layout failed', e)
      return null
    }
  }, [doc])

  // element_id -> laid node, for overlays and hit-testing.
  const byId = useMemo(() => {
    const m = new Map<number, LaidNode>()
    layout?.nodes.forEach((n) => m.set(n.id, n))
    return m
  }, [layout])

  // Thin device bar across the top: green for CUDA, red for ROCm, purple when
  // the SDFG only expects device-resident arguments (no explicit backend).
  const deviceBar = useMemo<{ label: string; className: string } | null>(() => {
    const md = doc?.metadata
    if (!md) return null
    const resident = String(md.device_resident) === '1'
    const backend = md.device_backend
    const t =
      backend != null && String(backend).trim() !== ''
        ? String(backend).toLowerCase()
        : ''
    const suffix = resident ? ' · device resident' : ''
    if (t.includes('cuda')) {
      return {
        label: `CUDA${suffix}`,
        className: 'bg-emerald-500 text-white',
      }
    }
    if (t.includes('rocm')) {
      return { label: `ROCm${suffix}`, className: 'bg-red-500 text-white' }
    }
    if (t) {
      return {
        label: `${backend}${suffix}`,
        className: 'bg-slate-500 text-white',
      }
    }
    if (resident) {
      return { label: 'device resident', className: 'bg-violet-500 text-white' }
    }
    return null
  }, [doc])

  // Nodes whose label text matches the search query (case-insensitive).
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || !layout) return []
    return layout.nodes.filter((n) => nodeText(n).includes(q))
  }, [search, layout])
  const matchIds = useMemo(() => new Set(matches.map((m) => m.id)), [matches])
  const currentMatch = matches[matchIndex]

  // Reset to the first hit whenever the query changes.
  useEffect(() => {
    setMatchIndex(0)
  }, [search])

  const annById = useMemo(() => {
    const m = new Map<number, SdfgRegionAnnotation>()
    regions?.forEach((r) => m.set(r.element_id, r))
    return m
  }, [regions])
  const maxUs = useMemo(
    () => Math.max(1, ...(regions ?? []).map((r) => r.runtime_us)),
    [regions],
  )
  const highlightById = useMemo(() => resolveHighlights(highlights), [highlights])

  // Minimap axis scales (independent so the box is always fully filled).
  const minimap = useMemo(() => {
    if (!layout) return null
    return { sx: MM_W / layout.width, sy: MM_H / layout.height, w: MM_W, h: MM_H }
  }, [layout])

  const fit = useCallback(() => {
    const el = containerRef.current
    if (!el || !layout) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    const scale = Math.min(cw / layout.width, ch / layout.height) * 0.95
    setView({
      scale,
      x: (cw - layout.width * scale) / 2,
      y: (ch - layout.height * scale) / 2,
    })
  }, [layout])

  // Default: zoom into the top of the graph so the first elements fill ~half the
  // width. The whole-graph "fit" view lives in the minimap instead.
  const initialView = useCallback(() => {
    const el = containerRef.current
    if (!el || !layout) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    const fitScale = Math.min(cw / layout.width, ch / layout.height) * 0.95
    const scale = Math.min(
      MAX_SCALE,
      Math.max(fitScale, (cw * 0.8) / layout.width),
    )
    setView({ scale, x: (cw - layout.width * scale) / 2, y: 16 })
  }, [layout])

  useEffect(() => {
    initialView()
  }, [initialView])

  // Center the view on a node and zoom it to a comfortable, readable size.
  const focusNode = useCallback((n: LaidNode) => {
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    const scale = Math.min(
      MAX_SCALE,
      Math.max(0.6, Math.min(cw / (n.w + 240), ch / (n.h + 240))),
    )
    const cx = n.x + n.w / 2
    const cy = n.y + n.h / 2
    setView({ scale, x: cw / 2 - cx * scale, y: ch / 2 - cy * scale })
  }, [])

  // Optionally follow the selection, e.g. when it is driven from a list next to the canvas.
  useEffect(() => {
    if (!focusSelected || selectedElementId == null) return
    const n = byId.get(selectedElementId)
    if (n) focusNode(n)
  }, [focusSelected, selectedElementId, byId, focusNode])

  // Jump to the current search hit whenever it changes.
  useEffect(() => {
    if (currentMatch) focusNode(currentMatch)
  }, [currentMatch, focusNode])

  // Step through search hits, wrapping around.
  const gotoMatch = useCallback(
    (delta: number) => {
      setMatchIndex((i) =>
        matches.length ? (i + delta + matches.length) % matches.length : 0,
      )
    },
    [matches.length],
  )


  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const el = containerRef.current
    if (!canvas || !el || !layout) return
    const dpr = window.devicePixelRatio || 1
    const cw = el.clientWidth
    const ch = el.clientHeight
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr
      canvas.height = ch * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { scale, x: vx, y: vy } = view

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, vx * dpr, vy * dpr)

    // Visible world rect for culling.
    const vw = { x: -vx / scale, y: -vy / scale, w: cw / scale, h: ch / scale }
    const visible = (n: LaidNode) =>
      n.x + n.w >= vw.x &&
      n.x <= vw.x + vw.w &&
      n.y + n.h >= vw.y &&
      n.y <= vw.y + vw.h

    const lw = 1 / scale
    ctx.lineWidth = lw
    ctx.textBaseline = 'middle'
    ctx.font = `${FONT}px ui-monospace, monospace`

    const structural = layout.nodes.filter((n) => !LEAF_KINDS.has(n.kind))
    const leaves = layout.nodes.filter((n) => LEAF_KINDS.has(n.kind))

    // 1) Structural containers, shallow-to-deep.
    for (const n of [...structural].sort((a, b) => a.depth - b.depth)) {
      if (!visible(n)) continue
      const s = STYLES[n.kind]
      ctx.fillStyle = s.fill
      ctx.strokeStyle = s.stroke
      ctx.setLineDash(s.dash ? s.dash.map((d) => d / scale) : [])
      roundRect(ctx, n.x, n.y, n.w, n.h, 6)
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
      if (HEADER_KINDS.has(n.kind) && (n.lines?.length || n.label)) {
        ctx.fillStyle = s.text
        const lines = n.lines ?? [n.label]
        lines.forEach((ln, i) => {
          ctx.fillText(clip(ln, n.w - 12), n.x + 6, n.y + 11 + i * HEADER_LINE_H)
        })
      }
    }

    // 2) Region overlays (runtime heat / bottleneck category), when enabled.
    if (overlay !== 'none') {
      for (const n of structural) {
        const a = annById.get(n.id)
        if (!a || !visible(n)) continue
        const mem = a.bottleneck?.startsWith('memory')
        if (overlay === 'runtime') {
          const rgb = mem ? '217, 119, 6' : '13, 148, 136'
          ctx.fillStyle = `rgba(${rgb}, ${0.12 + 0.4 * (a.runtime_us / maxUs)})`
        } else {
          const rgb = a.bottleneck
            ? mem
              ? '217, 119, 6'
              : '13, 148, 136'
            : '148, 163, 184'
          ctx.fillStyle = `rgba(${rgb}, 0.35)`
        }
        roundRect(ctx, n.x, n.y, n.w, n.h, 6)
        ctx.fill()
        const label = overlay === 'runtime' ? fmtUs(a.runtime_us) : a.bottleneck ?? '—'
        ctx.fillStyle = mem ? '#b45309' : a.bottleneck ? '#0f766e' : '#64748b'
        ctx.font = `bold ${FONT}px ui-monospace, monospace`
        ctx.fillText(label, n.x + 6, n.y + n.h - 9)
        ctx.font = `${FONT}px ui-monospace, monospace`
      }
    }

    // 2b) Highlights: tinted fill + outline + corner label, always on.
    if (highlightById.size) {
      ctx.font = `bold ${FONT}px ui-monospace, monospace`
      for (const n of layout.nodes) {
        const h = highlightById.get(n.id)
        if (!h || !visible(n)) continue
        ctx.fillStyle = h.style.fill
        ctx.strokeStyle = h.style.stroke
        ctx.lineWidth = 2 / scale
        roundRect(ctx, n.x, n.y, n.w, n.h, 6)
        ctx.fill()
        ctx.stroke()
        if (h.label) {
          // Filled pill in the bottom-left corner: wide loops often extend past the viewport's
          // right edge, while their left edge stays visible.
          const text = clip(h.label, n.w - 20)
          const tw = ctx.measureText(text).width
          const ph = FONT + 6
          const py = n.y + n.h - ph - 4
          ctx.fillStyle = h.style.stroke
          roundRect(ctx, n.x + 4, py, tw + 10, ph, ph / 2)
          ctx.fill()
          ctx.fillStyle = '#ffffff'
          ctx.fillText(text, n.x + 9, py + ph / 2)
        }
      }
      ctx.font = `${FONT}px ui-monospace, monospace`
    }

    // 3) Memlet edges.
    ctx.strokeStyle = '#94a3b8'
    ctx.lineWidth = lw
    for (const e of layout.edges) {
      if (e.points.length < 2) continue
      ctx.beginPath()
      ctx.moveTo(e.points[0].x, e.points[0].y)
      for (let i = 1; i < e.points.length; i++)
        ctx.lineTo(e.points[i].x, e.points[i].y)
      ctx.stroke()
    }

    // 4) Dataflow leaf nodes on top.
    for (const n of leaves) {
      if (!visible(n)) continue
      const s = STYLES[n.kind]
      ctx.fillStyle = s.fill
      ctx.strokeStyle = s.stroke
      // Access/constant nodes get a thick border, dashed when transient (local).
      const accessLike = n.kind === 'access_node' || n.kind === 'constant_node'
      ctx.lineWidth = (accessLike ? 2.5 : 1) / scale
      ctx.setLineDash(accessLike && n.transient ? [6 / scale, 4 / scale] : [])
      if (n.kind === 'access_node') roundRect(ctx, n.x, n.y, n.w, n.h, n.h / 2)
      else roundRect(ctx, n.x, n.y, n.w, n.h, 4)
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
      ctx.lineWidth = lw
      ctx.fillStyle = s.text
      ctx.textAlign = 'center'
      ctx.fillText(clip(n.label, n.w - 8), n.x + n.w / 2, n.y + n.h / 2)
      ctx.textAlign = 'left'
    }

    // 4b) Memlet subset labels near edge midpoints (only when readable).
    if (scale > 0.4) {
      ctx.font = `${FONT * 0.85}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const e of layout.edges) {
        if (!e.label || e.points.length < 2) continue
        const mid = e.points[Math.floor(e.points.length / 2)]
        if (
          mid.x < vw.x ||
          mid.x > vw.x + vw.w ||
          mid.y < vw.y ||
          mid.y > vw.y + vw.h
        )
          continue
        // Wrap long subsets onto multiple lines instead of cropping them.
        const lines = wrapText(e.label, 34)
        const lh = FONT * 1.1
        const tw = Math.max(...lines.map((ln) => ctx.measureText(ln).width))
        const boxH = lines.length * lh
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.fillRect(mid.x - tw / 2 - 2, mid.y - boxH / 2, tw + 4, boxH)
        ctx.fillStyle = '#475569'
        lines.forEach((ln, i) => ctx.fillText(ln, mid.x, mid.y - boxH / 2 + lh * (i + 0.5)))
      }
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      ctx.font = `${FONT}px ui-monospace, monospace`
    }

    // 5) Selection + hover highlight.
    for (const id of [hoverId, selectedElementId]) {
      if (id == null) continue
      const n = byId.get(id)
      if (!n) continue
      ctx.strokeStyle = id === selectedElementId ? '#ef4444' : '#0ea5e9'
      ctx.lineWidth = (id === selectedElementId ? 3 : 2) / scale
      roundRect(ctx, n.x, n.y, n.w, n.h, 6)
      ctx.stroke()
    }

    // 6) Search matches: tint all hits, outline the current one strongly.
    if (matchIds.size) {
      for (const n of layout.nodes) {
        if (!matchIds.has(n.id) || !visible(n)) continue
        const isCurrent = n.id === currentMatch?.id
        ctx.fillStyle = isCurrent
          ? 'rgba(245, 158, 11, 0.25)'
          : 'rgba(251, 191, 36, 0.18)'
        ctx.strokeStyle = isCurrent ? '#f59e0b' : '#fbbf24'
        ctx.lineWidth = (isCurrent ? 3 : 1.5) / scale
        roundRect(ctx, n.x, n.y, n.w, n.h, 6)
        ctx.fill()
        ctx.stroke()
      }
    }
  }, [layout, view, byId, annById, maxUs, highlightById, hoverId, selectedElementId, overlay, matchIds, currentMatch])

  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [draw])

  const drawMinimap = useCallback(() => {
    const canvas = minimapRef.current
    const el = containerRef.current
    if (!canvas || !el || !layout || !minimap) return
    const dpr = window.devicePixelRatio || 1
    const { w: mmW, h: mmH, sx, sy } = minimap
    if (canvas.width !== mmW * dpr || canvas.height !== mmH * dpr) {
      canvas.width = mmW * dpr
      canvas.height = mmH * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, mmW, mmH)
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, mmW, mmH)

    ctx.save()
    ctx.scale(sx, sy)
    for (const n of layout.nodes) {
      ctx.fillStyle = STYLES[n.kind].fill
      ctx.fillRect(n.x, n.y, n.w, n.h)
    }
    // Runtime heat so hot regions are findable at a glance (when overlaid).
    if (overlay !== 'none') {
      for (const n of layout.nodes) {
        const a = annById.get(n.id)
        if (!a) continue
        const mem = a.bottleneck?.startsWith('memory')
        const rgb = mem ? '217, 119, 6' : '13, 148, 136'
        const alpha =
          overlay === 'runtime' ? 0.2 + 0.5 * (a.runtime_us / maxUs) : 0.4
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`
        ctx.fillRect(n.x, n.y, n.w, n.h)
      }
    }
    for (const n of layout.nodes) {
      const h = highlightById.get(n.id)
      if (!h) continue
      ctx.fillStyle = h.style.stroke
      ctx.globalAlpha = 0.6
      ctx.fillRect(n.x, n.y, n.w, n.h)
      ctx.globalAlpha = 1
    }
    ctx.restore()

    // Current viewport rectangle.
    const vwx = -view.x / view.scale
    const vwy = -view.y / view.scale
    const vww = el.clientWidth / view.scale
    const vwh = el.clientHeight / view.scale
    ctx.fillStyle = 'rgba(15, 23, 42, 0.08)'
    ctx.fillRect(vwx * sx, vwy * sy, vww * sx, vwh * sy)
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 1.5
    ctx.strokeRect(vwx * sx, vwy * sy, vww * sx, vwh * sy)
  }, [layout, minimap, view, annById, maxUs, overlay, highlightById])
  useEffect(() => {
    const id = requestAnimationFrame(drawMinimap)
    return () => cancelAnimationFrame(id)
  }, [drawMinimap, minimapOpen])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [draw])

  // Deepest clickable node under a world point.
  const hitTest = useCallback(
    (wx: number, wy: number): LaidNode | null => {
      if (!layout) return null
      let best: LaidNode | null = null
      for (const n of layout.nodes) {
        if (!n.clickable) continue
        if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
          if (!best || n.depth > best.depth) best = n
        }
      }
      return best
    },
    [layout],
  )

  const toWorld = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - view.x) / view.scale,
      y: (e.clientY - rect.top - view.y) / view.scale,
    }
  }

  // Wheel zoom around cursor (native listener for preventDefault).
  useEffect(() => {
    const el = containerRef.current
    if (!el || !layout) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
        const k = scale / v.scale
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [layout])

  const onPointerDown = (e: React.PointerEvent) => {
    containerRef.current?.focus()
    drag.current = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y, moved: false }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d) {
      const dx = e.clientX - d.px
      const dy = e.clientY - d.py
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
      return
    }
    const w = toWorld(e)
    const hit = hitTest(w.x, w.y)
    setHoverId(hit?.id ?? null)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved) {
      const w = toWorld(e)
      const hit = hitTest(w.x, w.y)
      if (hit) {
        onSelectRegion?.(hit.id)
        onSelectElement?.(hit.id, hit.kind)
      } else onDeselect?.()
    }
  }

  // Center the main view on the clicked/dragged minimap point.
  const minimapWorld = (e: React.PointerEvent) => {
    const canvas = minimapRef.current
    if (!canvas || !minimap) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / minimap.sx,
      y: (e.clientY - rect.top) / minimap.sy,
    }
  }
  // Move the main view so the viewport center sits at (cx, cy) world coords.
  const centerViewOn = (cx: number, cy: number) => {
    const el = containerRef.current
    if (!el) return
    setView((v) => ({
      ...v,
      x: el.clientWidth / 2 - cx * v.scale,
      y: el.clientHeight / 2 - cy * v.scale,
    }))
  }
  const onMinimapDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const el = containerRef.current
    const w = minimapWorld(e)
    if (!el || !w) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const vwx = -view.x / view.scale
    const vwy = -view.y / view.scale
    const vww = el.clientWidth / view.scale
    const vwh = el.clientHeight / view.scale
    const inside =
      w.x >= vwx && w.x <= vwx + vww && w.y >= vwy && w.y <= vwy + vwh
    // Grab the window where clicked; jump-center when clicking outside it.
    const off = inside
      ? { ox: w.x - (vwx + vww / 2), oy: w.y - (vwy + vwh / 2) }
      : { ox: 0, oy: 0 }
    mmDrag.current = off
    centerViewOn(w.x - off.ox, w.y - off.oy)
  }
  const onMinimapMove = (e: React.PointerEvent) => {
    const off = mmDrag.current
    if (!off) return
    e.stopPropagation()
    const w = minimapWorld(e)
    if (!w) return
    centerViewOn(w.x - off.ox, w.y - off.oy)
  }
  const onMinimapUp = (e: React.PointerEvent) => {
    mmDrag.current = null
    e.stopPropagation()
  }

  // Arrow keys pan the view (Shift = larger step); Escape clears selection.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (controls && (e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    if (e.key === 'Escape') {
      onDeselect?.()
      return
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomBy(1.2)
      return
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      zoomBy(1 / 1.2)
      return
    }
    const step = e.shiftKey ? 120 : 40
    let dx = 0
    let dy = 0
    if (e.key === 'ArrowLeft') dx = step
    else if (e.key === 'ArrowRight') dx = -step
    else if (e.key === 'ArrowUp') dy = step
    else if (e.key === 'ArrowDown') dy = -step
    else return
    e.preventDefault()
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }

  // Zoom around the canvas center by a scale factor.
  const zoomBy = (factor: number) => {
    const el = containerRef.current
    if (!el) return
    const px = el.clientWidth / 2
    const py = el.clientHeight / 2
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      const k = scale / v.scale
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  }

  if (!layout) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Could not render SDFG.
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="relative h-full w-full touch-none overflow-hidden outline-none"
      style={{ cursor: drag.current ? 'grabbing' : hoverId != null ? 'pointer' : 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        drag.current = null
        setHoverId(null)
      }}
      onKeyDown={onKeyDown}
      onDoubleClick={fit}
    >
      <canvas ref={canvasRef} className="absolute left-0 top-0 h-full w-full" />
      {deviceBar && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex h-6 items-center justify-center text-[11px] font-semibold tracking-wide ${deviceBar.className}`}
        >
          {deviceBar.label}
        </div>
      )}
      {controls && (
        <div
          className={`absolute left-2 z-10 flex flex-col items-start gap-2 ${deviceBar ? 'top-8' : 'top-2'}`}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <select
            value={overlay}
            onChange={(e) => setOverlay(e.target.value as OverlayMode)}
            className="h-8 rounded-md border border-slate-200 bg-white/90 px-2 text-xs text-slate-700 shadow-sm outline-none"
          >
            <option value="none">No overlay</option>
            <option value="runtime">Runtime</option>
            <option value="bottleneck">Bottleneck</option>
          </select>
        </div>
      )}
      {controls && (
        <div
          className={`absolute left-1/2 z-10 -translate-x-1/2 ${deviceBar ? 'top-8' : 'top-2'}`}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white/90 px-1.5 py-1 shadow-sm">
            <Search className="size-3.5 shrink-0 text-slate-400" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  gotoMatch(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setSearch('')
                  searchInputRef.current?.blur()
                }
              }}
              placeholder="Search nodes…"
              className="h-6 w-36 bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400"
            />
            {search && (
              <>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                  {matches.length ? `${matchIndex + 1}/${matches.length}` : '0/0'}
                </span>
                <button
                  onClick={() => gotoMatch(-1)}
                  disabled={!matches.length}
                  aria-label="Previous match"
                  title="Previous match (Shift+Enter)"
                  className="rounded p-0.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <button
                  onClick={() => gotoMatch(1)}
                  disabled={!matches.length}
                  aria-label="Next match"
                  title="Next match (Enter)"
                  className="rounded p-0.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
                >
                  <ChevronDown className="size-3.5" />
                </button>
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  title="Clear search"
                  className="rounded p-0.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                >
                  <X className="size-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {controls && minimap && (
        minimapOpen ? (
          <div
            className={`absolute right-2 z-10 ${deviceBar ? 'top-8' : 'top-2'}`}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <canvas
              ref={minimapRef}
              onPointerDown={onMinimapDown}
              onPointerMove={onMinimapMove}
              onPointerUp={onMinimapUp}
              style={{ width: minimap.w, height: minimap.h }}
              className="cursor-grab touch-none rounded-md border border-slate-200 bg-white/90 shadow-sm active:cursor-grabbing"
            />
            <button
              onClick={() => setMinimapOpen(false)}
              aria-label="Collapse minimap"
              title="Collapse minimap"
              className="absolute right-1 top-1 rounded border border-slate-200 bg-white/90 p-0.5 text-slate-500 shadow-sm transition hover:text-slate-900"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setMinimapOpen(true)}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Show minimap"
            title="Show minimap"
            className={`absolute right-2 z-10 flex items-center gap-1 rounded-lg border border-slate-200 bg-white/90 px-2 py-1 text-xs font-medium text-slate-600 shadow-sm transition hover:text-slate-900 ${deviceBar ? 'top-8' : 'top-2'}`}
          >
            <MapIcon className="size-4" />
            Minimap
          </button>
        )
      )}
      <div
        className="absolute bottom-2 right-2 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white/90 shadow-sm"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => zoomBy(1.2)}
          aria-label="Zoom in"
          title="Zoom in"
          className="p-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
        >
          <Plus className="size-4" />
        </button>
        <button
          onClick={() => zoomBy(1 / 1.2)}
          aria-label="Zoom out"
          title="Zoom out"
          className="border-t border-slate-200 p-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
        >
          <Minus className="size-4" />
        </button>
        <button
          onClick={fit}
          title="Fit"
          className="border-t border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
        >
          Fit
        </button>
      </div>
      {regions && regions.length > 0 && (
        <div className="absolute bottom-2 left-2 rounded-lg border border-slate-200 bg-white/90 px-2 py-1 text-[11px] text-slate-500 shadow-sm">
          {regions.filter((r) => byId.has(r.element_id)).length}/{regions.length}{' '}
          regions on graph
        </div>
      )}
    </div>
  )
}

const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

const clip = (s: string, maxW: number): string => {
  const maxChars = Math.max(1, Math.floor(maxW / 7))
  return s.length > maxChars ? s.slice(0, Math.max(1, maxChars - 1)) + '…' : s
}

// Searchable text for a node: its label, sublabel and any wrapped header lines.
const nodeText = (n: LaidNode): string =>
  [n.label, n.sublabel, ...(n.lines ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

// Greedily wrap into lines of <= maxChars, hard-breaking overlong tokens (memlet subsets).
const wrapText = (s: string, maxChars: number): string[] => {
  if (s.length <= maxChars) return [s]
  const lines: string[] = []
  let cur = ''
  for (const word of s.split(' ')) {
    if (!cur) cur = word
    else if (cur.length + 1 + word.length <= maxChars) cur += ' ' + word
    else {
      lines.push(cur)
      cur = word
    }
  }
  if (cur) lines.push(cur)
  const out: string[] = []
  for (const ln of lines) {
    if (ln.length <= maxChars) out.push(ln)
    else for (let i = 0; i < ln.length; i += maxChars) out.push(ln.slice(i, i + maxChars))
  }
  return out
}
