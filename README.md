# @daisytuner/sdfg-viewer

Interactive canvas renderer for **docc Structured SDFG JSON**. Extracted from the
Daisytuner dashboard so the same viewer can be embedded in the docs site,
marketing pages, or any other React surface — one source of truth.

## Install

Not published to a registry yet. Consume it locally via a path dependency:

```jsonc
// package.json
{
  "dependencies": {
    "@daisytuner/sdfg-viewer": "file:../sdfg-viewer"
  }
}
```

Then build the package once (`npm run build`) so `dist/` exists before installing
in the consumer.

## Usage

```tsx
import { SdfgCanvas } from '@daisytuner/sdfg-viewer'
import type { StructuredSdfg } from '@daisytuner/sdfg-viewer'

export function Demo({ doc }: { doc: StructuredSdfg }) {
  return (
    <div style={{ height: 480 }}>
      <SdfgCanvas doc={doc} controls />
    </div>
  )
}
```

The parent must have a resolved height — the canvas fills its container.

### Props

| Prop                | Type                                          | Description                                              |
| ------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `doc`               | `StructuredSdfg`                              | docc structured JSON (must have a top-level `root`).     |
| `regions`           | `SdfgRegionAnnotation[]`                      | Per-region runtime/bottleneck data, keyed by element_id. |
| `selectedElementId` | `number`                                      | Highlighted element.                                     |
| `onSelectRegion`    | `(elementId: number) => void`                | Fired when a region container is clicked.                |
| `onSelectElement`   | `(elementId: number, kind: string) => void`  | Fired when any element is clicked.                       |
| `onDeselect`        | `() => void`                                  | Fired when empty canvas is clicked.                      |
| `controls`          | `boolean` (default `true`)                    | Show overlay dropdown, search, minimap and zoom.         |

## Styling

The canvas graph is drawn with the 2D canvas API (self-contained colors). The
overlay chrome uses **Tailwind** utility classes, so a Tailwind v4 consumer must
scan this package's source. Add to your global stylesheet:

```css
@source "../node_modules/@daisytuner/sdfg-viewer/dist";
```

## Astro / Starlight

Render as a React island. The component uses `window`/`canvas`, so use
`client:only="react"`:

```astro
---
import { SdfgCanvas } from '@daisytuner/sdfg-viewer'
import doc from './sample.json'
---
<div style="height: 480px">
  <SdfgCanvas doc={doc} client:only="react" />
</div>
```
