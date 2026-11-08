// TypeScript model of docc's StructuredSDFG JSON (see docc/sdfg json_serializer).
// Every element carries `element_id`, the same key as RegionPerformance.element_id,
// so runtime overlays map directly without title/geometry matching.

export type DebugInfo = {
  has: boolean
  filename?: string
  function?: string
  start_line?: number
  start_column?: number
  end_line?: number
  end_column?: number
}

/** Runtime annotation for a region: its element id, runtime and bottleneck. */
export type SdfgRegionAnnotation = {
  element_id: number
  runtime_us: number
  bottleneck?: string
}

/** Color scheme of a highlight. */
export type SdfgHighlightTone = 'success' | 'info' | 'warning' | 'danger' | 'muted'

/**
 * An always-visible marker on one element (e.g. which loop nests were optimized), drawn on
 * top of the graph independently of the overlay dropdown.
 */
export type SdfgHighlight = {
  element_id: number
  tone?: SdfgHighlightTone
  /** Short text shown as a pill in the element's bottom-left corner, e.g. "1.8×". */
  label?: string
}

/** Which per-region information to overlay on the SDFG (none = plain graph). */
export type OverlayMode = 'none' | 'runtime' | 'bottleneck'

/** A dataflow node inside a `block`. */
export type DataflowNode =
  | { type: 'access_node'; element_id: number; debug_info?: DebugInfo; data: string }
  | {
      type: 'tasklet'
      element_id: number
      debug_info?: DebugInfo
      code: number | string
      inputs: string[]
      output: string
    }
  | {
      type: 'library_node'
      element_id: number
      debug_info?: DebugInfo
      code: string
      callee_name?: string
      implementation_type?: string
      inputs: string[]
      outputs: string[]
    }
  | {
      type: 'constant_node'
      element_id: number
      debug_info?: DebugInfo
      data: string
      data_type?: unknown
    }

/** A memlet edge; `src`/`dst` reference dataflow node element_ids. */
export type Memlet = {
  element_id: number
  debug_info?: DebugInfo
  src: number
  dst: number
  src_conn: string
  dst_conn: string
  subset: string[]
  base_type?: unknown
}

export type DataflowGraph = {
  type: 'dataflow'
  nodes: DataflowNode[]
  edges: Memlet[]
}

export type Transition = {
  type: 'transition'
  element_id: number
  debug_info?: DebugInfo
  assignments: unknown[]
}

export type Sequence = {
  type: 'sequence'
  element_id: number
  debug_info?: DebugInfo
  children: ControlFlowNode[]
  transitions: Transition[]
}

export type Block = {
  type: 'block'
  element_id: number
  debug_info?: DebugInfo
  dataflow: DataflowGraph
}

export type AssignmentBlock = {
  type: 'assignment_block'
  element_id: number
  debug_info?: DebugInfo
  assignments?: unknown[]
}

export type IfElse = {
  type: 'if_else'
  element_id: number
  debug_info?: DebugInfo
  branches: { condition: string; root: Sequence }[]
}

/** for / map / while / reduce share the structured-loop shape (some fields optional). */
export type StructuredLoop = {
  type: 'for' | 'map' | 'while' | 'reduce'
  element_id: number
  debug_info?: DebugInfo
  root: Sequence
  indvar?: string
  init?: string
  condition?: string
  update?: string
  schedule_type?: { value?: string; category?: number }
}

export type Terminator = {
  type: 'return' | 'break' | 'continue'
  element_id: number
  debug_info?: DebugInfo
  data?: string
  data_type?: unknown
}

export type ControlFlowNode =
  | Sequence
  | Block
  | AssignmentBlock
  | IfElse
  | StructuredLoop
  | Terminator

/** Top-level document returned by the `type=json` full-SDFG cutout. */
export type StructuredSdfg = {
  type: string
  name: string
  arguments?: unknown[]
  containers?: Record<string, unknown>
  externals?: unknown[]
  structures?: unknown[]
  return_type?: unknown
  element_counter?: number
  metadata?: Record<string, unknown>
  root: Sequence
}

/** Narrowing helpers. */
export const isSequence = (n: ControlFlowNode): n is Sequence =>
  n.type === 'sequence'
export const isBlock = (n: ControlFlowNode): n is Block => n.type === 'block'
export const isIfElse = (n: ControlFlowNode): n is IfElse => n.type === 'if_else'
export const isLoop = (n: ControlFlowNode): n is StructuredLoop =>
  n.type === 'for' || n.type === 'map' || n.type === 'while' || n.type === 'reduce'
