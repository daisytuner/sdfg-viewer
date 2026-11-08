import type { SdfgHighlight, SdfgHighlightTone } from './types'

export type HighlightStyle = { fill: string; stroke: string; text: string }

export const HIGHLIGHT_STYLES: Record<SdfgHighlightTone, HighlightStyle> = {
  success: { fill: 'rgba(16, 185, 129, 0.16)', stroke: '#10b981', text: '#047857' },
  info: { fill: 'rgba(14, 165, 233, 0.14)', stroke: '#0ea5e9', text: '#0369a1' },
  warning: { fill: 'rgba(245, 158, 11, 0.16)', stroke: '#f59e0b', text: '#b45309' },
  danger: { fill: 'rgba(239, 68, 68, 0.14)', stroke: '#ef4444', text: '#b91c1c' },
  muted: { fill: 'rgba(148, 163, 184, 0.16)', stroke: '#94a3b8', text: '#475569' },
}

/** Highlights keyed by element id with their resolved style; later entries win. */
export const resolveHighlights = (
  highlights: SdfgHighlight[] | undefined,
): Map<number, SdfgHighlight & { style: HighlightStyle }> => {
  const byId = new Map<number, SdfgHighlight & { style: HighlightStyle }>()
  for (const h of highlights ?? []) {
    byId.set(h.element_id, { ...h, style: HIGHLIGHT_STYLES[h.tone ?? 'info'] })
  }
  return byId
}
