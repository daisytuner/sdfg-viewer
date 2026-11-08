export { SdfgCanvas } from './sdfg-canvas.component'
export { layoutSdfg, FONT } from './layout'
export { HIGHLIGHT_STYLES, resolveHighlights } from './highlights'
export type { HighlightStyle } from './highlights'
export type { SdfgLayout, LaidNode, LaidEdge, LaidNodeKind } from './layout'
export type {
  StructuredSdfg,
  SdfgRegionAnnotation,
  SdfgHighlight,
  SdfgHighlightTone,
  OverlayMode,
  ControlFlowNode,
  Sequence,
  Block,
  IfElse,
  StructuredLoop,
  DataflowNode,
  Memlet,
} from './types'
export { isSequence, isBlock, isIfElse, isLoop } from './types'
