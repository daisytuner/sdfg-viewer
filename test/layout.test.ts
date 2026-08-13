import { describe, it, expect } from 'vitest'
import { layoutSdfg } from '../src/layout'
import { isSequence, isBlock, isIfElse, isLoop } from '../src/types'
import type { StructuredSdfg, ControlFlowNode } from '../src/types'

/** A minimal saxpy kernel: `for i: y[i] = a * x[i] + y[i]` with a transient `t`. */
const saxpy: StructuredSdfg = {
  type: 'StructuredSDFG',
  name: 'saxpy',
  arguments: ['x', 'y', 'a', 'N'],
  externals: [],
  root: {
    type: 'sequence',
    element_id: 0,
    transitions: [],
    children: [
      {
        type: 'for',
        element_id: 1,
        indvar: 'i',
        init: '0',
        condition: 'i < N',
        update: 'i + 1',
        root: {
          type: 'sequence',
          element_id: 2,
          transitions: [],
          children: [
            {
              type: 'block',
              element_id: 3,
              dataflow: {
                type: 'dataflow',
                nodes: [
                  { type: 'access_node', element_id: 4, data: 'x' },
                  { type: 'access_node', element_id: 5, data: 'y' },
                  { type: 'constant_node', element_id: 6, data: 'a' },
                  { type: 'tasklet', element_id: 7, code: 4, inputs: ['a', 'x'], output: 't' },
                  { type: 'access_node', element_id: 8, data: 't' },
                  { type: 'tasklet', element_id: 9, code: 2, inputs: ['t', 'y'], output: 'y' },
                  { type: 'access_node', element_id: 10, data: 'y' },
                ],
                edges: [
                  { element_id: 20, src: 6, dst: 7, src_conn: 'void', dst_conn: 'a', subset: [] },
                  { element_id: 21, src: 4, dst: 7, src_conn: 'void', dst_conn: 'x', subset: ['i'] },
                  { element_id: 22, src: 7, dst: 8, src_conn: 't', dst_conn: 'void', subset: ['i'] },
                  { element_id: 23, src: 8, dst: 9, src_conn: 'void', dst_conn: 't', subset: ['i'] },
                  { element_id: 24, src: 5, dst: 9, src_conn: 'void', dst_conn: 'y', subset: ['i'] },
                  { element_id: 25, src: 9, dst: 10, src_conn: 'y', dst_conn: 'void', subset: ['i'] },
                ],
              },
            },
          ],
        },
      },
    ],
  },
}

describe('layoutSdfg', () => {
  it('produces a laid-out graph with positive extent', () => {
    const l = layoutSdfg(saxpy)
    expect(l.width).toBeGreaterThan(0)
    expect(l.height).toBeGreaterThan(0)
    expect(l.nodes.length).toBeGreaterThan(0)
    expect(l.edges.length).toBeGreaterThan(0)
  })

  it('emits loop and block containers and dataflow leaves, preserving element_ids', () => {
    const l = layoutSdfg(saxpy)
    const kinds = new Set(l.nodes.map((n) => n.kind))
    expect(kinds.has('loop')).toBe(true)
    expect(kinds.has('block')).toBe(true)
    expect(kinds.has('tasklet')).toBe(true)
    expect(kinds.has('access_node')).toBe(true)

    // element_ids from the source graph survive into the layout (used by overlays).
    expect(l.nodes.some((n) => n.id === 1)).toBe(true) // the for loop
    expect(l.nodes.some((n) => n.id === 7)).toBe(true) // the `t = a * x` tasklet
  })

  it('renders the loop header from its bounds', () => {
    const l = layoutSdfg(saxpy)
    const loop = l.nodes.find((n) => n.kind === 'loop')
    expect(loop?.label).toContain('for:')
    expect(loop?.label).toContain('i < N')
  })

  it('flags transient temporaries but not arguments/constants', () => {
    const l = layoutSdfg(saxpy)
    const t = l.nodes.find((n) => n.kind === 'access_node' && n.label === 't')
    const x = l.nodes.find((n) => n.kind === 'access_node' && n.label === 'x')
    const a = l.nodes.find((n) => n.kind === 'constant_node' && n.label === 'a')
    expect(t?.transient).toBe(true)
    expect(x?.transient).toBe(false)
    expect(a?.transient).toBe(false)
  })

  it('labels memlet edges', () => {
    const l = layoutSdfg(saxpy)
    expect(l.edges.some((e) => (e.label ?? '').includes('x[i]'))).toBe(true)
  })

  it('does not throw on an empty root sequence', () => {
    const empty: StructuredSdfg = {
      ...saxpy,
      root: { type: 'sequence', element_id: 0, transitions: [], children: [] },
    }
    expect(() => layoutSdfg(empty)).not.toThrow()
  })
})

describe('control-flow type guards', () => {
  const forLoop = saxpy.root.children[0] as ControlFlowNode
  const block = (saxpy.root.children[0] as { root: { children: ControlFlowNode[] } })
    .root.children[0]

  it('narrows each control-flow kind', () => {
    expect(isSequence(saxpy.root)).toBe(true)
    expect(isLoop(forLoop)).toBe(true)
    expect(isBlock(block)).toBe(true)
    expect(isIfElse(forLoop)).toBe(false)
  })
})
