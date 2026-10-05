'use client'

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

import {
  cssFrame,
  pagePoint,
  resizeFontScale,
  resizeFrame,
  rotateFrame,
  type Camera,
  type ResizeHandle,
} from '@/lib/geometry'
import type { ResizeMode } from '@/lib/store'
import type { EntityId, Frame, Point, TransformFrame } from '@koharu/bridge/protocol'

interface SelectionControlsProps {
  container: RefObject<HTMLDivElement | null>
  element: EntityId
  frame: Frame
  camera: Camera
  edgesOnly: boolean
  fontSize?: number
  resizeMode: ResizeMode
  shearX?: number
  shearY?: number
  onShearStart?: (axis: ShearAxis) => void
  onShearPreview?: (axis: ShearAxis, shear: number) => void
  onShearEnd?: (axis: ShearAxis, shear: number) => void
  onTransformStart: (elements: TransformFrame[]) => void
  onTransformFrame: (elements: TransformFrame[]) => void
  onTransformEnd: (resize?: { element: EntityId; size: number }) => void
}

type ControlGesture =
  | { kind: 'resize'; pointer: number; original: Frame; latest: Frame; handle: ResizeHandle }
  | { kind: 'rotate'; pointer: number; original: Frame; start: Point }
  | {
      kind: 'shear'
      axis: ShearAxis
      pointer: number
      start: Point
      original: number
      latest: number
    }

type ShearAxis = 'x' | 'y'

const handles: Array<{
  handle: ResizeHandle
  left: string
  top: string
  cursor: string
}> = [
  { handle: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { handle: 'n', left: '50%', top: '0%', cursor: 'ns-resize' },
  { handle: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { handle: 'e', left: '100%', top: '50%', cursor: 'ew-resize' },
  { handle: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { handle: 's', left: '50%', top: '100%', cursor: 'ns-resize' },
  { handle: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { handle: 'w', left: '0%', top: '50%', cursor: 'ew-resize' },
]

export function SelectionControls({
  container,
  element,
  frame,
  camera,
  edgesOnly,
  fontSize,
  resizeMode,
  shearX,
  shearY,
  onShearStart,
  onShearPreview,
  onShearEnd,
  onTransformStart,
  onTransformFrame,
  onTransformEnd,
}: SelectionControlsProps) {
  const gesture = useRef<ControlGesture | null>(null)
  const [previewShear, setPreviewShear] = useState<{ axis: ShearAxis; value: number } | null>(null)
  const position = cssFrame(frame, camera)

  const eventPoint = (event: ReactPointerEvent<HTMLDivElement>): Point | null => {
    const bounds = container.current?.getBoundingClientRect()
    return bounds ? pagePoint(event.clientX, event.clientY, bounds, camera) : null
  }

  const capture = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const startResize = (handle: ResizeHandle) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gesture.current) return
    capture(event)
    gesture.current = {
      kind: 'resize',
      pointer: event.pointerId,
      original: frame,
      latest: frame,
      handle,
    }
    onTransformStart([{ element, frame }])
  }

  const startRotate = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gesture.current) return
    const start = eventPoint(event)
    if (!start) return
    capture(event)
    gesture.current = { kind: 'rotate', pointer: event.pointerId, original: frame, start }
    onTransformStart([{ element, frame }])
  }

  const startShear = (axis: ShearAxis) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gesture.current || !onShearEnd) return
    const start = eventPoint(event)
    if (!start) return
    capture(event)
    gesture.current = {
      kind: 'shear',
      axis,
      pointer: event.pointerId,
      start,
      original: axis === 'x' ? (shearX ?? 0) : (shearY ?? 0),
      latest: axis === 'x' ? (shearX ?? 0) : (shearY ?? 0),
    }
    onShearStart?.(axis)
  }

  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const point = eventPoint(event)
    if (!point) return
    if (current.kind === 'shear') {
      const angle = (frame.angle_degrees * Math.PI) / 180
      const localX =
        (point.x - current.start.x) * Math.cos(angle) +
        (point.y - current.start.y) * Math.sin(angle)
      const localY =
        -(point.x - current.start.x) * Math.sin(angle) +
        (point.y - current.start.y) * Math.cos(angle)
      const delta = current.axis === 'x' ? localX / frame.height : localY / frame.width
      current.latest = Math.max(-4, Math.min(4, current.original + delta))
      setPreviewShear({ axis: current.axis, value: current.latest })
      onShearPreview?.(current.axis, current.latest)
      return
    }
    const next =
      current.kind === 'resize'
        ? resizeFrame(
            current.original,
            current.handle,
            point,
            window.devicePixelRatio / camera.zoom,
          )
        : rotateFrame(current.original, current.start, point)
    if (current.kind === 'resize') current.latest = next
    onTransformFrame([{ element, frame: next }])
  }

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (current.kind === 'shear') {
      setPreviewShear(null)
      onShearEnd?.(current.axis, current.latest)
      return
    }
    const resize =
      current.kind === 'resize' && resizeMode === 'scale' && fontSize && fontSize > 0
        ? {
            element,
            size: Math.max(
              0.5,
              Math.min(
                300,
                fontSize * resizeFontScale(current.original, current.latest, current.handle),
              ),
            ),
          }
        : undefined
    onTransformEnd(resize)
  }

  const lostCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    gesture.current = null
    if (current.kind === 'shear') {
      setPreviewShear(null)
      onShearEnd?.(current.axis, current.latest)
      return
    }
    onTransformEnd()
  }

  const pointerEvents = {
    onPointerMove: update,
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: lostCapture,
  }

  return (
    <div
      data-testid='selection-controls'
      className='pointer-events-none absolute box-border border border-[var(--canvas-selection)]'
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        height: position.height,
        transform: `rotate(${position.angle}deg) skewX(${(Math.atan(previewShear?.axis === 'x' ? previewShear.value : (shearX ?? 0)) * 180) / Math.PI}deg) skewY(${(Math.atan(previewShear?.axis === 'y' ? previewShear.value : (shearY ?? 0)) * 180) / Math.PI}deg)`,
        transformOrigin: '50% 50%',
      }}
    >
      {handles.map(({ handle, left, top, cursor }) => (
        <div
          key={handle}
          data-canvas-control
          data-resize-handle={handle}
          className='pointer-events-auto absolute grid size-3.5 -translate-x-1/2 -translate-y-1/2 touch-none place-items-center'
          style={{
            left,
            top,
            cursor,
            width:
              edgesOnly && (handle === 'n' || handle === 's')
                ? 'max(14px, calc(100% - 14px))'
                : undefined,
            height:
              edgesOnly && (handle === 'e' || handle === 'w')
                ? 'max(14px, calc(100% - 14px))'
                : undefined,
          }}
          onPointerDown={startResize(handle)}
          {...pointerEvents}
        >
          {!edgesOnly && (
            <span className='size-1.5 rounded-[1px] border border-primary-foreground bg-[var(--canvas-selection)] shadow-[0_0_0_1px_rgb(0_0_0/0.12)]' />
          )}
        </div>
      ))}

      {onShearEnd && (
        <div
          data-canvas-control
          data-shear-handle
          aria-label='Cisalhar texto horizontalmente'
          className='pointer-events-auto absolute top-0 left-1/2 h-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none border-t-2 border-[var(--canvas-selection)]'
          style={{ width: 'max(14px, calc(100% - 28px))' }}
          onPointerDown={startShear('x')}
          {...pointerEvents}
        />
      )}
      {onShearEnd && (
        <div
          data-canvas-control
          data-shear-y-handle
          aria-label='Cisalhar texto verticalmente'
          className='pointer-events-auto absolute top-1/2 left-0 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize touch-none border-l-2 border-[var(--canvas-selection)]'
          style={{ height: 'max(14px, calc(100% - 28px))' }}
          onPointerDown={startShear('y')}
          {...pointerEvents}
        />
      )}
      <span className='pointer-events-none absolute top-0 left-1/2 h-2 w-px -translate-x-1/2 -translate-y-full bg-[var(--canvas-selection)]' />
      <div
        data-canvas-control
        data-rotate-handle
        className='pointer-events-auto absolute top-[-16px] left-1/2 grid size-3.5 -translate-x-1/2 -translate-y-1/2 cursor-alias touch-none place-items-center'
        onPointerDown={startRotate}
        {...pointerEvents}
      >
        <span className='size-1.5 rounded-[1px] border border-primary-foreground bg-[var(--canvas-selection)] shadow-[0_0_0_1px_rgb(0_0_0/0.12)]' />
      </div>
    </div>
  )
}
