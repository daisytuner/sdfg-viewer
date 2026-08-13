import dagre from 'dagre'
import type {
  ControlFlowNode,
  DataflowGraph,
  DataflowNode,
  Memlet,
  StructuredLoop,
  StructuredSdfg,
} from './types'

export type LaidNodeKind =
  | 'block'
  | 'loop'
  | 'if_else'
  | 'branch'
  | 'assignment'
  | 'terminator'
  | 'access_node'
  | 'tasklet'
  | 'library_node'
  | 'constant_node'

export type LaidNode = {
  id: number
  kind: LaidNodeKind
  x: number
  y: number
  w: number
  h: number
  label: string
  sublabel?: string
  /** Wrapped header lines (present when the label spans multiple lines). */
  lines?: string[]
  depth: number
  /** Region containers that can be selected / heat-annotated. */
  clickable: boolean
  /** Access/constant nodes: data is transient (local) vs argument/external. */
  transient?: boolean
}

export type LaidEdge = {
  id: number
  points: { x: number; y: number }[]
  label?: string
}

export type SdfgLayout = {
  nodes: LaidNode[]
  edges: LaidEdge[]
  width: number
  height: number
}

// All sizes are in layout units (== px at scale 1).
const FONT = 12
const CHAR_W = 7
const HEADER_H = 22
const PAD = 12
const GAP = 16
const BRANCH_GAP = 20
const DF_NODE_H = 30
const DF_NODE_MIN_W = 48

const textW = (s: string) => Math.max(DF_NODE_MIN_W, s.length * CHAR_W + 16)

// Backend symbolic expressions can carry embedded newlines/whitespace; collapse
// them so labels stay on one line and don't inflate measured node widths.
const oneLine = (s: string): string => (s ?? '').replace(/\s+/g, ' ').trim()

// Cap header width; longer labels wrap onto extra lines instead of widening.
const MAX_LABEL_W = 760
const LINE_H = 14

/** Greedily wrap a label to fit maxW (layout units), hard-breaking long words. */
const wrapLabel = (s: string, maxW: number): string[] => {
  const maxChars = Math.max(8, Math.floor((maxW - 16) / CHAR_W))
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

/** Wrapped header lines + the width/height they need. */
const headerBox = (raw: string): { lines: string[]; w: number; h: number } => {
  const w = Math.min(textW(raw), MAX_LABEL_W)
  const lines = wrapLabel(raw, w)
  return { lines, w, h: HEADER_H + (lines.length - 1) * LINE_H }
}

type LayoutCtx = { nonTransient: Set<string> }

// TaskletCode (enum order in docc data_flow/tasklet.h) -> printed operator,
// matching visualizer.cpp's code_to_string. Missing codes render as '?'.
const TASKLET_OP: Record<number, string> = {
  0: '=', // assign (special-cased below)
  2: '+', // fp_add
  3: '-', // fp_sub
  4: '*', // fp_mul
  5: '/', // fp_div
  6: '%', // fp_rem
  7: 'fma', // fp_fma (special-cased below)
  9: 'of!=', // fp_one
  22: '+', // int_add
  23: '-', // int_sub
  24: '*', // int_mul
  25: '/', // int_sdiv
  26: '%', // int_srem
  27: '/', // int_udiv
  28: '%', // int_urem
  35: 'smin',
  36: 'smax',
  38: 'umin',
  39: 'umax',
}

const taskletExpr = (code: number, inputs: string[]): string => {
  const args = inputs ?? []
  if (code === 0) return args[0] ?? ''
  if (code === 7)
    return `${args[0] ?? '?'} * ${args[1] ?? '?'} + ${args[2] ?? '?'}`
  return `${TASKLET_OP[code] ?? '?'}(${args.join(', ')})`
}

const dfLabel = (n: DataflowNode): string => {
  switch (n.type) {
    case 'access_node':
    case 'constant_node':
      return oneLine(n.data)
    case 'tasklet':
      return oneLine(`${n.output} = ${taskletExpr(Number(n.code), n.inputs)}`)
    case 'library_node':
      return oneLine(`${n.callee_name || n.code}(${(n.inputs ?? []).join(', ')})`)
  }
}

const isAccessLike = (n: DataflowNode): boolean =>
  n.type === 'access_node' || n.type === 'constant_node'

const subsetStr = (subset: string[]): string =>
  (subset ?? []).map((e) => `[${oneLine(e)}]`).join('')

/** Reproduces DotVisualizer's memlet label: `<dst> = <src>` with subsets. */
const memletLabel = (e: Memlet, byId: Map<number, DataflowNode>): string => {
  const src = byId.get(e.src)
  const dst = byId.get(e.dst)
  const dstVoid = e.dst_conn === 'void'
  const dstRef = e.dst_conn === 'ref'
  const dstDeref = e.dst_conn === 'deref'
  const srcVoid = e.src_conn === 'void'
  const srcDeref = e.src_conn === 'deref'
  const sub = subsetStr(e.subset)

  let dstPart: string
  if (dst && isAccessLike(dst)) {
    const dstVar = (dst as { data: string }).data
    if (srcDeref && dstVoid) {
      dstPart =
        (e.subset ?? []).length === 1 && e.subset[0] === '0'
          ? `*${dstVar}`
          : dstVar + sub
    } else if (dstVoid) {
      dstPart = dstVar + sub
    } else {
      dstPart = dstVar
    }
  } else {
    dstPart = e.dst_conn
  }

  let srcPart: string
  if (src && isAccessLike(src)) {
    const srcVar = (src as { data: string }).data
    if (srcVoid && dstRef) srcPart = `&${srcVar}${sub}`
    else if (srcVoid && dstDeref) srcPart = `*${srcVar}`
    else if (srcVoid) srcPart = srcVar + sub
    else srcPart = srcVar
  } else {
    srcPart = e.src_conn
  }

  return `${dstPart} = ${srcPart}`
}

/** Lays out one block's dataflow graph with dagre; returns size + a placer. */
const layoutDataflow = (df: DataflowGraph, ctx: LayoutCtx) => {
  const g = new dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 36, marginx: 4, marginy: 4 })
  g.setDefaultEdgeLabel(() => ({}))

  const byId = new Map<number, DataflowNode>()
  for (const n of df.nodes) byId.set(n.element_id, n)

  for (const n of df.nodes) {
    const label = dfLabel(n)
    g.setNode(String(n.element_id), {
      width: textW(label),
      height: DF_NODE_H,
      node: n,
      label,
    })
  }
  const edgeLabels = new Map<string, string>()
  for (const e of df.edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue
    edgeLabels.set(String(e.element_id), memletLabel(e, byId))
    g.setEdge(String(e.src), String(e.dst), {}, String(e.element_id))
  }

  if (df.nodes.length === 0) {
    return {
      w: DF_NODE_MIN_W,
      h: DF_NODE_H,
      place: () => ({ nodes: [] as LaidNode[], edges: [] as LaidEdge[] }),
    }
  }

  dagre.layout(g)
  const gg = g.graph()
  const w = gg.width ?? DF_NODE_MIN_W
  const h = gg.height ?? DF_NODE_H

  const place = (ox: number, oy: number, depth: number) => {
    const nodes: LaidNode[] = []
    const edges: LaidEdge[] = []
    for (const id of g.nodes()) {
      const gn = g.node(id) as dagre.Node & { node: DataflowNode; label: string }
      const n = gn.node
      nodes.push({
        id: n.element_id,
        kind: n.type,
        x: ox + gn.x - gn.width / 2,
        y: oy + gn.y - gn.height / 2,
        w: gn.width,
        h: gn.height,
        label: gn.label,
        depth,
        clickable: true,
        transient: isAccessLike(n)
          ? !ctx.nonTransient.has((n as { data: string }).data)
          : undefined,
      })
    }
    for (const e of g.edges()) {
      const ge = g.edge(e) as { points: { x: number; y: number }[] }
      const name = e.name ?? ''
      edges.push({
        id: Number(name),
        points: (ge.points ?? []).map((p) => ({ x: ox + p.x, y: oy + p.y })),
        label: edgeLabels.get(name),
      })
    }
    return { nodes, edges }
  }

  return { w, h, place }
}

type Measured = {
  w: number
  h: number
  place: (
    ox: number,
    oy: number,
    depth: number,
    out: { nodes: LaidNode[]; edges: LaidEdge[] },
  ) => void
}

const loopBounds = (n: StructuredLoop): string =>
  n.indvar != null
    ? oneLine(`${n.indvar} = ${n.init}; ${n.condition}; ${n.indvar} = ${n.update}`)
    : ''

const loopLabel = (n: StructuredLoop): string => {
  const sched = n.schedule_type?.value
  switch (n.type) {
    case 'for':
      return `for: ${loopBounds(n)}`
    case 'map':
      return `map [${sched ?? ''}]: ${loopBounds(n)}`
    case 'reduce':
      return `reduce [${sched ?? ''}]: ${loopBounds(n)}`
    case 'while':
      return 'while:'
  }
}

const measure = (node: ControlFlowNode, ctx: LayoutCtx): Measured => {
  switch (node.type) {
    case 'sequence': {
      const kids = node.children.map((c) => measure(c, ctx))
      const w = kids.reduce((m, k) => Math.max(m, k.w), 0)
      const h =
        kids.reduce((a, k) => a + k.h, 0) + GAP * Math.max(0, kids.length - 1)
      return {
        w,
        h,
        place: (ox, oy, depth, out) => {
          let y = oy
          for (const k of kids) {
            k.place(ox, y, depth, out)
            y += k.h + GAP
          }
        },
      }
    }
    case 'block': {
      const df = layoutDataflow(node.dataflow, ctx)
      const w = df.w + PAD * 2
      const h = df.h + PAD * 2
      return {
        w,
        h,
        place: (ox, oy, depth, out) => {
          out.nodes.push({
            id: node.element_id,
            kind: 'block',
            x: ox,
            y: oy,
            w,
            h,
            label: '',
            depth,
            clickable: true,
          })
          const placed = df.place(ox + PAD, oy + PAD, depth + 1)
          out.nodes.push(...placed.nodes)
          out.edges.push(...placed.edges)
        },
      }
    }
    case 'if_else': {
      const cols = node.branches.map((b) => {
        const cond = oneLine(b.condition)
        return { cond, hdr: headerBox(cond), m: measure(b.root, ctx) }
      })
      const colW = cols.map((c) => Math.max(c.m.w, c.hdr.w) + PAD * 2)
      const colH = cols.map((c) => c.hdr.h + c.m.h + PAD * 2)
      const innerW =
        colW.reduce((a, b) => a + b, 0) + BRANCH_GAP * Math.max(0, cols.length - 1)
      const innerH = colH.reduce((m, v) => Math.max(m, v), 0)
      const w = innerW + PAD * 2
      const h = HEADER_H + innerH + PAD * 2
      return {
        w,
        h,
        place: (ox, oy, depth, out) => {
          out.nodes.push({
            id: node.element_id,
            kind: 'if_else',
            x: ox,
            y: oy,
            w,
            h,
            label: node.branches.length > 1 ? 'if / else' : 'if',
            depth,
            clickable: true,
          })
          let x = ox + PAD
          const y = oy + HEADER_H + PAD
          cols.forEach((c, i) => {
            out.nodes.push({
              id: node.branches[i].root.element_id,
              kind: 'branch',
              x,
              y,
              w: colW[i],
              h: colH[i],
              label: c.cond,
              lines: c.hdr.lines,
              depth: depth + 1,
              clickable: false,
            })
            c.m.place(x + PAD, y + c.hdr.h + PAD, depth + 2, out)
            x += colW[i] + BRANCH_GAP
          })
        },
      }
    }
    case 'for':
    case 'map':
    case 'while':
    case 'reduce': {
      const inner = measure(node.root, ctx)
      const label = loopLabel(node)
      const hdr = headerBox(label)
      const w = Math.max(inner.w, hdr.w) + PAD * 2
      const h = hdr.h + inner.h + PAD * 2
      return {
        w,
        h,
        place: (ox, oy, depth, out) => {
          out.nodes.push({
            id: node.element_id,
            kind: 'loop',
            x: ox,
            y: oy,
            w,
            h,
            label,
            lines: hdr.lines,
            depth,
            clickable: true,
          })
          inner.place(ox + PAD, oy + hdr.h + PAD, depth + 1, out)
        },
      }
    }
    case 'assignment_block':
    case 'return':
    case 'break':
    case 'continue': {
      const label = node.type === 'assignment_block' ? 'assign' : node.type
      const w = textW(label)
      const h = HEADER_H + 8
      const kind: LaidNodeKind =
        node.type === 'assignment_block' ? 'assignment' : 'terminator'
      return {
        w,
        h,
        place: (ox, oy, depth, out) => {
          out.nodes.push({
            id: node.element_id,
            kind,
            x: ox,
            y: oy,
            w,
            h,
            label,
            depth,
            clickable: true,
          })
        },
      }
    }
  }
}

/** Computes an absolute-positioned layout of a docc StructuredSDFG. */
export const layoutSdfg = (doc: StructuredSdfg): SdfgLayout => {
  // A container is transient unless it's an argument or an external symbol.
  const nonTransient = new Set<string>()
  for (const a of doc.arguments ?? [])
    if (typeof a === 'string') nonTransient.add(a)
  for (const e of doc.externals ?? []) {
    const name = typeof e === 'string' ? e : (e as { name?: string })?.name
    if (name) nonTransient.add(name)
  }

  const root = measure(doc.root, { nonTransient })
  const out = { nodes: [] as LaidNode[], edges: [] as LaidEdge[] }
  root.place(PAD, PAD, 0, out)
  return {
    nodes: out.nodes,
    edges: out.edges,
    width: root.w + PAD * 2,
    height: root.h + PAD * 2,
  }
}

export { FONT }
