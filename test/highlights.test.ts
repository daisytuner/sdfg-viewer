import { describe, it, expect } from 'vitest'
import { HIGHLIGHT_STYLES, resolveHighlights } from '../src/highlights'

describe('resolveHighlights', () => {
  it('keys highlights by element id with their tone style, defaulting to info', () => {
    const byId = resolveHighlights([
      { element_id: 4, tone: 'success', label: '1.8×' },
      { element_id: 9 },
    ])
    expect(byId.get(4)).toMatchObject({ label: '1.8×', style: HIGHLIGHT_STYLES.success })
    expect(byId.get(9)?.style).toBe(HIGHLIGHT_STYLES.info)
    expect(byId.has(1)).toBe(false)
  })

  it('lets later highlights of the same element win and tolerates no highlights', () => {
    const byId = resolveHighlights([
      { element_id: 4, tone: 'muted' },
      { element_id: 4, tone: 'danger' },
    ])
    expect(byId.get(4)?.style).toBe(HIGHLIGHT_STYLES.danger)
    expect(resolveHighlights(undefined).size).toBe(0)
  })
})
