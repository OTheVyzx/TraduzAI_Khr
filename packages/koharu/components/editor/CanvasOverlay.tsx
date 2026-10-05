'use client'

import { useMemo, useRef } from 'react'

import { SelectionControls } from '@/components/editor/SelectionControls'
import { effectiveLayerVisibility, expandLayerSelection, isTextLayer } from '@/lib/document'
import { controlFrame, cssFrame, selectableLayer, type Camera } from '@/lib/geometry'
import type { ResizeMode } from '@/lib/store'
import type {
  EntityId,
  Frame,
  Geometry,
  Page,
  Point,
  TransformFrame,
} from '@koharu/bridge/protocol'

interface CanvasOverlayProps {
  page: Page
  camera: Camera
  selected: EntityId[]
  hovered: EntityId | null
  frames: Readonly<Record<EntityId, Frame>>
  previews: Readonly<Record<EntityId, Frame>>
  fontSizes: Readonly<Record<EntityId, number>>
  resizeMode: ResizeMode
  draft: Frame | null
  polygonDraft: { points: ReadonlyArray<Point>; cursor: Point } | null
  cursor: Point | null
  brushSize: number
  brushHardness: number
  showBrushCursor: boolean
  showSelectionControls: boolean
  onTransformStart: (elements: TransformFrame[]) => void
  onTransformFrame: (elements: TransformFrame[]) => void
  onTransformEnd: (resize?: { element: EntityId; size: number }) => void
  onShearStart: (element: EntityId, frame: Frame, axis: 'x' | 'y') => void
  onShearPreview: (element: EntityId, frame: Frame, axis: 'x' | 'y', shear: number) => void
  onShearEnd: (element: EntityId, axis: 'x' | 'y', shear: number) => void
}

export function CanvasOverlay({
  page,
  camera,
  selected,
  hovered,
  frames,
  previews,
  fontSizes,
  resizeMode,
  draft,
  polygonDraft,
  cursor,
  brushSize,
  brushHardness,
  showBrushCursor,
  showSelectionControls,
  onTransformStart,
  onTransformFrame,
  onTransformEnd,
  onShearStart,
  onShearPreview,
  onShearEnd,
}: CanvasOverlayProps) {
  const root = useRef<HTMLDivElement>(null)
  const expandedSelection = useMemo(
    () => expandLayerSelection(page.layers, selected),
    [page.layers, selected],
  )
  const selectedIds = useMemo(() => new Set(expandedSelection), [expandedSelection])
  const multipleSelected = expandedSelection.length > 1
  const layers = useMemo(
    () =>
      page.layers.flatMap((layer) => {
        const visibility = effectiveLayerVisibility(page.layers, layer)
        if (!visibility.visible || visibility.opacity <= 0) return []
        const frame = previews[layer.id] ?? controlFrame(layer, frames)
        return frame ? [{ layer, frame, opacity: visibility.opacity }] : []
      }),
    [page.layers, previews, frames],
  )
  const selectedLayer =
    expandedSelection.length === 1
      ? page.layers.find((layer) => layer.id === expandedSelection[0])
      : undefined
  const selectedTextLayer = selectedLayer && isTextLayer(selectedLayer) ? selectedLayer : undefined
  const automaticRegion = selectedTextLayer?.automatic_region
    ? page.regions.find((region) => region.id === selectedTextLayer.automatic_region)
    : undefined
  const selectionControl = multipleSelected
    ? undefined
    : layers.find(({ layer }) => selectedIds.has(layer.id) && selectableLayer(layer))
  const scale = camera.zoom / window.devicePixelRatio

  return (
    <div
      ref={root}
      data-testid='canvas-overlay'
      className='pointer-events-none absolute inset-0 overflow-hidden'
      aria-hidden
    >
      {automaticRegion && (
        <AutomaticRegionOverlay geometry={automaticRegion.geometry} camera={camera} />
      )}
      {layers.map(({ layer, frame, opacity }) => {
        const position = cssFrame(frame, camera)
        const selected = selectedIds.has(layer.id) && selectableLayer(layer)
        const highlighted = !selected && hovered === layer.id
        return (
          <div
            key={layer.id}
            data-element={layer.id}
            className='absolute box-border bg-transparent'
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              height: position.height,
              transform: `rotate(${position.angle}deg)`,
              transformOrigin: '50% 50%',
              border:
                highlighted || (selected && multipleSelected)
                  ? '1px solid var(--canvas-selection)'
                  : undefined,
              opacity,
              willChange: selected ? 'left, top, width, height, transform' : undefined,
            }}
          />
        )
      })}

      {draft && <DraftOverlay frame={draft} camera={camera} />}
      {polygonDraft && <PolygonDraftOverlay draft={polygonDraft} camera={camera} />}
      {showBrushCursor && cursor && (
        <div
          className='absolute rounded-full border border-white/95 shadow-[0_0_0_1px_rgb(0_0_0/0.9),0_1px_3px_rgb(0_0_0/0.45)]'
          style={{
            left: cursor.x / window.devicePixelRatio - (brushSize * scale) / 2,
            top: cursor.y / window.devicePixelRatio - (brushSize * scale) / 2,
            width: brushSize * scale,
            height: brushSize * scale,
          }}
        >
          {brushHardness < 100 && (
            <span
              className='pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/75'
              style={{
                width: `${brushHardness}%`,
                height: `${brushHardness}%`,
                minWidth: brushHardness === 0 ? 0 : undefined,
                minHeight: brushHardness === 0 ? 0 : undefined,
              }}
            />
          )}
        </div>
      )}

      {showSelectionControls && selectionControl && (
        <SelectionControls
          container={root}
          element={selectionControl.layer.id}
          frame={selectionControl.frame}
          camera={camera}
          edgesOnly={Boolean(selectedTextLayer)}
          fontSize={selectedTextLayer ? fontSizes[selectedTextLayer.id] : undefined}
          resizeMode={resizeMode}
          shearX={selectedTextLayer?.typography?.shear_x ?? 0}
          shearY={selectedTextLayer?.typography?.shear_y ?? 0}
          onShearStart={
            selectedTextLayer
              ? (axis) => onShearStart(selectedTextLayer.id, selectionControl.frame, axis)
              : undefined
          }
          onShearPreview={
            selectedTextLayer
              ? (axis, shear) =>
                  onShearPreview(selectedTextLayer.id, selectionControl.frame, axis, shear)
              : undefined
          }
          onShearEnd={
            selectedTextLayer
              ? (axis, shear) => onShearEnd(selectedTextLayer.id, axis, shear)
              : undefined
          }
          onTransformStart={onTransformStart}
          onTransformFrame={onTransformFrame}
          onTransformEnd={onTransformEnd}
        />
      )}
    </div>
  )
}

function AutomaticRegionOverlay({ geometry, camera }: { geometry: Geometry; camera: Camera }) {
  const dpr = window.devicePixelRatio
  const points = geometry.points
    .map(
      (point) =>
        `${(point.x * camera.zoom + camera.translation[0]) / dpr},${(point.y * camera.zoom + camera.translation[1]) / dpr}`,
    )
    .join(' ')
  if (!points) return null

  return (
    <svg className='absolute inset-0 size-full overflow-hidden' data-testid='text-fit-region'>
      <polygon
        points={points}
        fill='none'
        stroke='var(--canvas-region-contrast)'
        strokeWidth='7'
        strokeDasharray='10 6'
        strokeLinecap='round'
        strokeLinejoin='round'
        vectorEffect='non-scaling-stroke'
      />
      <polygon
        points={points}
        fill='none'
        stroke='var(--canvas-region-stroke)'
        strokeWidth='3'
        strokeDasharray='10 6'
        strokeLinecap='round'
        strokeLinejoin='round'
        vectorEffect='non-scaling-stroke'
      />
    </svg>
  )
}

function DraftOverlay({ frame, camera }: { frame: Frame; camera: Camera }) {
  const position = cssFrame(frame, camera)
  return (
    <div
      className='absolute border border-dashed border-primary bg-primary/5'
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        height: position.height,
        transform: `rotate(${position.angle}deg)`,
      }}
    />
  )
}

function PolygonDraftOverlay({
  draft,
  camera,
}: {
  draft: { points: ReadonlyArray<Point>; cursor: Point }
  camera: Camera
}) {
  const dpr = window.devicePixelRatio
  const screen = (point: Point) => ({
    x: (point.x * camera.zoom + camera.translation[0]) / dpr,
    y: (point.y * camera.zoom + camera.translation[1]) / dpr,
  })
  const vertices = draft.points.map(screen)
  const cursor = screen(draft.cursor)
  const outline = [...vertices, cursor].map(({ x, y }) => `${x},${y}`).join(' ')

  return (
    <div data-testid='polygon-draft' className='absolute inset-0'>
      <svg className='absolute inset-0 size-full overflow-hidden'>
        {vertices.length >= 2 && (
          <polygon points={outline} fill='var(--canvas-selection)' fillOpacity='0.12' />
        )}
        <polyline
          points={outline}
          fill='none'
          stroke='var(--canvas-selection)'
          strokeWidth='2'
          strokeDasharray='6 4'
        />
        {vertices.map(({ x, y }, index) => (
          <circle
            key={index}
            cx={x}
            cy={y}
            r={index === 0 ? 6 : 4}
            fill='var(--surface-canvas)'
            stroke='var(--canvas-selection)'
            strokeWidth='2'
          />
        ))}
      </svg>
      <div className='absolute inset-x-0 bottom-3 mx-auto w-fit rounded-md bg-background/90 px-2 py-1 text-xs text-foreground shadow-sm'>
        Clique nos vértices · Enter para concluir · Esc para cancelar
      </div>
    </div>
  )
}
