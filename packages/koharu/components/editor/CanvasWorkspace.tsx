'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useColorSampling } from '@/components/controls/ColorSampling'
import { CanvasCommandBar } from '@/components/editor/CanvasCommandBar'
import { CanvasOverlay } from '@/components/editor/CanvasOverlay'
import { StatusBar } from '@/components/editor/StatusBar'
import { ToolBar } from '@/components/editor/ToolBar'
import { useCanvas } from '@/components/editor/useCanvas'
import { call } from '@/lib/backend'
import { expandLayerSelection, isTextLayer } from '@/lib/document'
import {
  controlFrame,
  draftFrame,
  hitTestLayers,
  pagePoint,
  physicalPoint,
  selectableLayer,
  translateFrames,
} from '@/lib/geometry'
import {
  pageKey,
  pagesKey,
  preparedPageKey,
  projectKey,
  queryClient,
  refresh,
  usePage,
  usePages,
} from '@/lib/queries'
import {
  isBrushTool,
  maxBrushDiameter,
  MIN_BRUSH_DIAMETER,
  receiveError,
  useKoharuStore,
  type CanvasTool,
} from '@/lib/store'
import { defaultTypography } from '@/lib/typography'
import { prefetchCanvasPages, workspaceColor, type CanvasColor } from '@koharu/bridge/canvas'
import {
  commands,
  type EntityId,
  type Frame,
  type Point,
  type TransformFrame,
  type Typography,
} from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'

const BRUSH_DIAMETER_STEP = 4

const canvasCursors = {
  select: undefined,
  text: 'text',
  ocr_region: 'crosshair',
  draw: 'none',
  eraser: 'none',
  restore_region: 'crosshair',
  inpaint_region: 'crosshair',
  color_picker: 'crosshair',
  remove: 'none',
  pan: 'grab',
} as const satisfies Record<CanvasTool, string | undefined>

type Gesture =
  | {
      kind: 'pan'
      pointer: number
      start: Point
      translation: [number, number]
    }
  | { kind: 'move'; pointer: number; start: Point; originals: TransformFrame[] }
  | { kind: 'text'; pointer: number; start: Point; frame: Frame }
  | StrokeGesture

interface PolygonDraft {
  action: 'ocr' | 'restore' | 'inpaint'
  page: EntityId
  revision: number
  points: Point[]
  cursor: Point
}

interface StrokeGesture {
  kind: 'paint' | 'erase' | 'inpaint'
  pointer: number
  page: EntityId
  revision: number
  layer: string | null
  points: Point[]
  diameter: number
  hardness: number
  color?: CanvasColor
}

interface CanvasView {
  zoom: number
  translation: [number, number]
}

interface StrokeUpdate {
  kind: 'paint' | 'erase' | 'inpaint'
  points: Point[]
}

interface CopiedTextLayer {
  sourceText: string
  translationText: string | null
  typography: Typography
  layout: 'point' | 'paragraph'
  frame: Frame
}

export function CanvasWorkspace() {
  const { t } = useTranslation()
  const surface = useRef<HTMLDivElement>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const polygon = useRef<PolygonDraft | null>(null)
  const previousPageIndex = useRef<number | null>(null)
  const spaceHeld = useRef(false)
  const transformActive = useRef(false)
  const transformRevision = useRef<number | null>(null)
  const transformPage = useRef<EntityId | null>(null)
  const transformFinal = useRef<TransformFrame[]>([])
  const shearGesture = useRef<{
    element: string
    frame: Frame
    axis: 'x' | 'y'
    original: { x: number; y: number }
  } | null>(null)
  const commitPending = useRef(false)
  const commandQueue = useRef<Promise<void>>(Promise.resolve())
  const textClipboard = useRef<CopiedTextLayer[] | null>(null)
  const [previews, setPreviews] = useState<Record<string, Frame>>({})
  const [draft, setDraft] = useState<Frame | null>(null)
  const [polygonDraft, setPolygonDraft] = useState<PolygonDraft | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)
  const [snapGuides, setSnapGuides] = useState({ x: false, y: false })
  const colorSampling = useColorSampling()

  const page = usePage().data
  const pages = usePages().data
  const camera = useKoharuStore((state) => state.camera)
  const canvasPage = useKoharuStore((state) => state.canvasPage)
  const canvasRevision = useKoharuStore((state) => state.canvasRevision)
  const canvasGeneration = useKoharuStore((state) => state.canvasGeneration)
  const canvasSize = useKoharuStore((state) => state.canvasSize)
  const fitCanvasRequest = useKoharuStore((state) => state.fitCanvasRequest)
  const layerFrames = useKoharuStore((state) => state.layerFrames)
  const fontSizes = useKoharuStore((state) => state.fontSizes)
  const resizeMode = useKoharuStore((state) => state.resizeMode)
  const defaultFontSize = useKoharuStore((state) => state.defaultFontSize)
  const ocrRegionAngle = useKoharuStore((state) => state.ocrRegionAngle)
  const tool = useKoharuStore((state) => state.tool)
  const snapToCenter = useKoharuStore((state) => state.snapToCenter)
  const brush = useKoharuStore((state) => state.brush)
  const selected = useKoharuStore((state) => state.selectedLayers)
  const selectLayers = useKoharuStore((state) => state.selectLayers)
  const setTool = useKoharuStore((state) => state.setTool)
  const setBrush = useKoharuStore((state) => state.setBrush)
  const requestCanvasFit = useKoharuStore((state) => state.requestCanvasFit)
  const canvasState = useCanvas(canvasElement, canvasRevision, canvasGeneration, page?.id ?? null)
  const canvas = canvasState.canvas
  const pageId = page?.id
  const canvasActiveRevision = canvasState.activeRevision
  const pageWidth = canvasSize[0] || page?.size.width
  const pageHeight = canvasSize[1] || page?.size.height
  const canvasInteractive =
    Boolean(page) &&
    canvasState.activePage === page?.id &&
    canvasState.activeRevision !== null &&
    canvasState.hasFrame &&
    (canvasState.status === 'ready' || canvasState.status === 'switching')
  const activeRaster =
    selected.length === 1
      ? page?.layers.find((layer) => layer.id === selected[0] && layer.type === 'raster')
      : undefined

  const enqueue = useCallback(<Result,>(operation: () => Promise<Result>): Promise<Result> => {
    const pending = commandQueue.current.then(operation)
    commandQueue.current = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }, [])

  const pasteCopiedText = useCallback((): boolean => {
    const copied = textClipboard.current
    if (!page || !copied?.length) return false
    if (commitPending.current) return true
    commitPending.current = true
    void enqueue(async () => {
      const created: TransformFrame[] = []
      try {
        const offset = (12 * window.devicePixelRatio) / camera.zoom
        for (const item of copied) {
          const frame = {
            ...item.frame,
            x: clamp(item.frame.x + offset, 0, Math.max(0, page.size.width - item.frame.width)),
            y: clamp(item.frame.y + offset, 0, Math.max(0, page.size.height - item.frame.height)),
          }
          const result =
            item.layout === 'point'
              ? await call(commands.addPointText, { x: frame.x, y: frame.y })
              : await call(commands.addTextBox, frame)
          created.push({ element: result.layer, frame })
          await call(commands.setSourceText, result.layer, item.sourceText)
          await call(commands.setTranslation, result.layer, item.translationText)
          await call(commands.setTypography, [{ layer: result.layer, typography: item.typography }])
        }
        const project = await call(commands.getProject)
        if (project && page) await call(commands.commitTransform, project.revision, page.id, created)
        selectLayers(created.map(({ element }) => element))
        await refresh(projectKey, pagesKey, pageKey)
      } catch (error) {
        if (created.length) {
          await call(
            commands.deleteLayers,
            created.map(({ element }) => element),
          ).catch(() => undefined)
          await refresh(projectKey, pagesKey, pageKey).catch(() => undefined)
        }
        throw error
      }
    })
      .catch((error: unknown) => receiveError(errorMessage(error)))
      .finally(() => (commitPending.current = false))
    return true
  }, [camera.zoom, enqueue, page, selectLayers])

  const transformUpdates = useFrameCommand((elements: TransformFrame[]) => {
    try {
      canvas?.updateTransform(elements)
    } catch {
      // A frame swap can discard the local preview; the durable transform still commits on release.
    }
  })
  const strokeUpdates = useFrameCommand(
    ({ points }: StrokeUpdate) => {
      try {
        canvas?.extendStroke(points)
      } catch {
        // Stroke points are retained in the gesture and committed even if its preview was replaced.
      }
    },
    mergeStrokeUpdates,
  )

  const beginTransform = useCallback(
    (elements: TransformFrame[]) => {
      if (
        !canvas ||
        canvasActiveRevision === null ||
        !canvasInteractive ||
        !elements.length ||
        transformActive.current ||
        commitPending.current
      )
        return
      transformUpdates.clear()
      transformActive.current = true
      transformRevision.current = canvasActiveRevision
      transformPage.current = page?.id ?? null
      transformFinal.current = elements
      setPreviews(Object.fromEntries(elements.map(({ element, frame }) => [element, frame])))
      try {
        canvas.beginTransform(elements)
      } catch {
        canvas.cancelTransform()
      }
    },
    [canvas, canvasActiveRevision, canvasInteractive, page, transformUpdates],
  )

  const updateTransform = useCallback(
    (elements: TransformFrame[]) => {
      if (!transformActive.current) return
      transformFinal.current = elements
      setPreviews(Object.fromEntries(elements.map(({ element, frame }) => [element, frame])))
      transformUpdates.schedule(elements)
    },
    [transformUpdates],
  )

  const finishTransform = useCallback(
    (resize?: { element: string; size: number }) => {
      if (!transformActive.current) return
      transformUpdates.commit()
      transformActive.current = false
      const revision = transformRevision.current
      const pageId = transformPage.current
      const elements = transformFinal.current
      transformRevision.current = null
      transformPage.current = null
      try {
        canvas?.finishTransform()
      } catch {
        canvas?.cancelTransform()
      }
      if (revision === null || pageId === null) {
        canvas?.cancelTransform()
        setPreviews({})
        return
      }
      commitPending.current = true
      void enqueue(async () => {
        const next = await call(commands.commitTransform, revision, pageId, elements)
        if (next === null) return
        if (resize) {
          const layer = page?.layers.find((candidate) => candidate.id === resize.element)
          if (layer?.type === 'text') {
            await call(commands.setTypography, [
              {
                layer: resize.element,
                typography: {
                  ...(layer.typography ?? defaultTypography),
                  size: resize.size,
                  auto_fit: false,
                },
              },
            ])
          }
        }
        await refresh(projectKey, pagesKey, pageKey)
      })
        .catch(() => canvas?.cancelTransform())
        .finally(() => {
          commitPending.current = false
          setPreviews({})
        })
    },
    [canvas, enqueue, page, transformUpdates],
  )

  const beginShear = useCallback(
    (element: string, frame: Frame, axis: 'x' | 'y') => {
      if (!canvas || shearGesture.current || transformActive.current || commitPending.current)
        return
      const layer = page?.layers.find((candidate) => candidate.id === element)
      if (layer?.type !== 'text') return
      const original = {
        x: layer.typography?.shear_x ?? 0,
        y: layer.typography?.shear_y ?? 0,
      }
      shearGesture.current = { element, frame, axis, original }
      try {
        canvas.beginTransform([{ element, frame }], original)
      } catch {
        canvas.cancelTransform()
      }
    },
    [canvas, page],
  )

  const previewShear = useCallback(
    (element: string, frame: Frame, axis: 'x' | 'y', shear: number) => {
      const current = shearGesture.current
      if (!current || current.element !== element || current.axis !== axis) return
      try {
        canvas?.updateTransform([{ element, frame }], {
          ...current.original,
          [axis]: shear,
        })
      } catch {
        canvas?.cancelTransform()
      }
    },
    [canvas],
  )

  const finishShear = useCallback(
    (element: string, axis: 'x' | 'y', shear: number) => {
      if (shearGesture.current?.element !== element || shearGesture.current.axis !== axis) return
      shearGesture.current = null
      try {
        canvas?.finishTransform()
      } catch (error) {
        canvas?.cancelTransform()
        receiveError(errorMessage(error))
      }
      const layer = page?.layers.find((candidate) => candidate.id === element)
      if (layer?.type !== 'text') return
      void enqueue(async () => {
        await call(commands.setTypography, [
          {
            layer: element,
            typography: {
              ...(layer.typography ?? defaultTypography),
              [axis === 'x' ? 'shear_x' : 'shear_y']: shear,
            },
          },
        ])
        await refresh(projectKey, pageKey)
      }).catch(() => undefined)
    },
    [canvas, enqueue, page],
  )

  const finishPolygon = useCallback(() => {
    const selection = polygon.current
    if (!selection || selection.points.length < 3) return
    polygon.current = null
    setPolygonDraft(null)
    commitPending.current = true
    const operation =
      selection.action === 'ocr'
        ? () =>
            call(
              commands.recognizeSelectedRegion,
              selection.revision,
              selection.page,
              selection.points,
              defaultFontSize,
              ocrRegionAngle,
            ).then((result) => {
              selectLayers([result.layer])
              return refresh(projectKey, pagesKey, pageKey)
            })
        : selection.action === 'restore'
          ? () =>
            call(
              commands.restoreOriginalRegion,
              selection.revision,
              selection.page,
              selection.points,
            ).then(() => refresh(projectKey, pagesKey, pageKey))
          : () =>
              call(
                commands.commitInpaintRegion,
                selection.revision,
                selection.page,
                selection.points,
              ).then(() => undefined)
    void enqueue(operation)
      .catch((error) => receiveError(errorMessage(error)))
      .finally(() => (commitPending.current = false))
  }, [defaultFontSize, enqueue, ocrRegionAngle, selectLayers])

  const cancelGesture = useCallback(() => {
    const current = gesture.current
    gesture.current = null
    if (current?.kind === 'paint' || current?.kind === 'erase' || current?.kind === 'inpaint') {
      strokeUpdates.clear()
      canvas?.cancelStroke()
    }
    if (transformActive.current) {
      transformUpdates.clear()
      transformActive.current = false
      transformRevision.current = null
      transformPage.current = null
      canvas?.cancelTransform()
    }
    if (shearGesture.current) {
      shearGesture.current = null
      canvas?.cancelTransform()
    }
    polygon.current = null
    setPolygonDraft(null)
    setDraft(null)
    setPreviews({})
    setSnapGuides({ x: false, y: false })
  }, [canvas, strokeUpdates, transformUpdates])

  const fitCanvas = useCallback(() => {
    const element = surface.current
    if (!element || !pageId || pageWidth === undefined || pageHeight === undefined) return
    const bounds = element.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    const next = containCamera(bounds.width * dpr, bounds.height * dpr, pageWidth, pageHeight)
    useKoharuStore.setState({ camera: { ...next, fitted: true } })
  }, [pageHeight, pageId, pageWidth])

  const report = useCallback(() => {
    const element = surface.current
    if (!element || !canvas) return
    const bounds = element.getBoundingClientRect()
    canvas.resize(bounds.width, bounds.height, window.devicePixelRatio, workspaceColor())
    if (useKoharuStore.getState().camera.fitted) fitCanvas()
  }, [canvas, fitCanvas])

  const setZoom = useCallback((zoom: number) => {
    const element = surface.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    const current = useKoharuStore.getState().camera
    const center = {
      x: bounds.width * dpr * 0.5,
      y: bounds.height * dpr * 0.5,
    }
    const pageX = (center.x - current.translation[0]) / current.zoom
    const pageY = (center.y - current.translation[1]) / current.zoom
    useKoharuStore.setState({
      camera: {
        zoom,
        translation: [center.x - pageX * zoom, center.y - pageY * zoom],
        fitted: false,
      },
    })
  }, [])

  useEffect(() => {
    const element = surface.current
    if (!element) return
    report()
    const resize = new ResizeObserver(report)
    const theme = new MutationObserver(report)
    resize.observe(element)
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    window.addEventListener('resize', report)
    window.visualViewport?.addEventListener('resize', report)
    return () => {
      resize.disconnect()
      theme.disconnect()
      window.removeEventListener('resize', report)
      window.visualViewport?.removeEventListener('resize', report)
    }
  }, [report])

  useEffect(() => {
    canvas?.setView(camera.zoom, camera.translation)
  }, [canvas, camera])

  useEffect(() => {
    if (
      !pageId ||
      canvasPage !== pageId ||
      canvasState.generation !== canvasGeneration ||
      canvasState.status !== 'ready' ||
      !pages?.length
    )
      return
    const index = pages.findIndex((candidate) => candidate.id === pageId)
    if (index < 0) return
    const previous = previousPageIndex.current
    previousPageIndex.current = index
    const direction = previous !== null && index < previous ? -1 : 1
    const adjacent = pages[index + direction]?.id ?? pages[index - direction]?.id
    if (adjacent) {
      void prefetchCanvasPages([adjacent])
        .then((prepared) => {
          for (const page of prepared) {
            queryClient.setQueryData(preparedPageKey(page.page.id), page)
          }
        })
        .catch(() => undefined)
    }
  }, [canvasGeneration, canvasPage, canvasState.generation, canvasState.status, pageId, pages])

  useEffect(() => {
    fitCanvas()
  }, [fitCanvas, fitCanvasRequest])

  useEffect(() => {
    if (!canvasInteractive) cancelGesture()
  }, [cancelGesture, canvasInteractive, page?.id, tool])

  useEffect(() => {
    const editable = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)

    const down = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        event.preventDefault()
        return
      }
      if (editable(event.target)) return
      if (polygon.current && event.key === 'Enter') {
        event.preventDefault()
        finishPolygon()
        return
      }
      if (polygon.current && event.key === 'Backspace') {
        event.preventDefault()
        const points = polygon.current.points.slice(0, -1)
        polygon.current = points.length ? { ...polygon.current, points } : null
        setPolygonDraft(polygon.current)
        return
      }
      const state = useKoharuStore.getState()
      if (event.code === 'Space') {
        spaceHeld.current = true
        event.preventDefault()
        return
      }
      const command = event.ctrlKey || event.metaKey
      if (command && event.key.toLowerCase() === 'c' && page && !polygon.current) {
        const copied = expandLayerSelection(page.layers, state.selectedLayers).flatMap((id) => {
          const layer = page.layers.find((candidate) => candidate.id === id)
          if (!layer || !isTextLayer(layer)) return []
          const frame = controlFrame(layer, layerFrames)
          return frame
            ? [
                {
                  sourceText: layer.content.source?.text ?? '',
                  translationText: layer.content.translation?.text ?? null,
                  typography: structuredClone(layer.typography ?? defaultTypography),
                  layout: layer.layout,
                  frame,
                },
              ]
            : []
        })
        if (copied.length) {
          event.preventDefault()
          textClipboard.current = copied
        }
        return
      }
      if (command && event.key.toLowerCase() === 'v' && !polygon.current && pasteCopiedText()) {
        event.preventDefault()
        return
      }
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void call(event.shiftKey ? commands.redo : commands.undo)
          .then(() => refresh(projectKey, pagesKey, pageKey))
          .catch(() => undefined)
        return
      }
      if (command && event.key.toLowerCase() === 'a' && page) {
        event.preventDefault()
        selectLayers(page.layers.filter(selectableLayer).map((layer) => layer.id))
        return
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        state.selectedLayers.length > 0
      ) {
        event.preventDefault()
        void call(commands.deleteLayers, state.selectedLayers)
          .then(() => refresh(projectKey, pagesKey, pageKey))
          .catch(() => undefined)
        return
      }
      if (event.key.toLowerCase() === state.shortcuts.fit) {
        requestCanvasFit()
        return
      }
      if (event.key === 'Escape') {
        cancelGesture()
        colorSampling?.cancel()
        selectLayers([])
        return
      }
      const next = (
        [
          'select',
          'text',
          'ocr_region',
          'inpaint_region',
          'draw',
          'eraser',
          'restore_region',
          'color_picker',
          'remove',
          'pan',
        ] as const
      ).find((action) => state.shortcuts[action] === event.key.toLowerCase())
      if (next) setTool(next)
    }

    const up = (event: KeyboardEvent) => {
      if (event.key === 'Alt') event.preventDefault()
      if (event.code === 'Space') spaceHeld.current = false
    }
    const blur = () => {
      spaceHeld.current = false
      cancelGesture()
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [
    cancelGesture,
    colorSampling,
    finishPolygon,
    layerFrames,
    page,
    pasteCopiedText,
    requestCanvasFit,
    selectLayers,
    setTool,
  ])

  const clientPagePoint = (clientX: number, clientY: number) =>
    pagePoint(
      clientX,
      clientY,
      surface.current!.getBoundingClientRect(),
      useKoharuStore.getState().camera,
    )

  const clientPhysicalPoint = (clientX: number, clientY: number) =>
    physicalPoint(clientX, clientY, surface.current!.getBoundingClientRect())

  const framesFor = (layers: string[]): TransformFrame[] =>
    expandLayerSelection(page?.layers ?? [], layers).flatMap((id) => {
      const layer = page?.layers.find((candidate) => candidate.id === id)
      const frame = layer && selectableLayer(layer) ? controlFrame(layer, layerFrames) : null
      return frame ? [{ element: id, frame }] : []
    })

  const moveGesture = (
    pointer: number,
    samples: ReadonlyArray<{ clientX: number; clientY: number }>,
  ) => {
    const current = gesture.current
    const sample = samples.at(-1)
    if (!page || !sample) return
    const physical = clientPhysicalPoint(sample.clientX, sample.clientY)
    setCursor(physical)
    if (polygon.current) {
      const pagePoint = clientPagePoint(sample.clientX, sample.clientY)
      polygon.current = {
        ...polygon.current,
        cursor: {
          x: clamp(pagePoint.x, 0, page.size.width),
          y: clamp(pagePoint.y, 0, page.size.height),
        },
      }
      setPolygonDraft(polygon.current)
    }
    if (!current || current.pointer !== pointer) {
      if (tool === 'select') {
        setHovered(
          hitTestLayers(page.layers, clientPagePoint(sample.clientX, sample.clientY), layerFrames)
            ?.id ?? null,
        )
      }
      return
    }

    if (current.kind === 'pan') {
      const bounds = surface.current!.getBoundingClientRect()
      const dpr = window.devicePixelRatio
      let translation: [number, number] = [
        current.translation[0] + physical.x - current.start.x,
        current.translation[1] + physical.y - current.start.y,
      ]
      translation = clampCameraTranslation(
        translation,
        camera.zoom,
        pageWidth ?? page.size.width,
        pageHeight ?? page.size.height,
        bounds.width * dpr,
        bounds.height * dpr,
        dpr,
      )
      useKoharuStore.setState({
        camera: { zoom: camera.zoom, translation, fitted: false },
      })
      return
    }

    const points = samples.map((value) => clientPagePoint(value.clientX, value.clientY))
    const point = points.at(-1)!
    if (current.kind === 'move') {
      const moved = translateFrames(current.originals, {
        x: point.x - current.start.x,
        y: point.y - current.start.y,
      })
      if (snapToCenter) {
        const center = framesBoundsCenter(moved)
        const tolerance = (8 * window.devicePixelRatio) / camera.zoom
        const difference = {
          x: page.size.width * 0.5 - center.x,
          y: page.size.height * 0.5 - center.y,
        }
        const snapX = Math.abs(difference.x) <= tolerance
        const snapY = Math.abs(difference.y) <= tolerance
        setSnapGuides({ x: snapX, y: snapY })
        updateTransform(
          translateFrames(moved, {
            x: snapX ? difference.x : 0,
            y: snapY ? difference.y : 0,
          }),
        )
      } else {
        setSnapGuides({ x: false, y: false })
        updateTransform(moved)
      }
    } else if (current.kind === 'text') {
      current.frame = draftFrame(current.start, point)
      setDraft(current.frame)
    } else if (current.kind === 'paint' || current.kind === 'erase' || current.kind === 'inpaint') {
      current.points.push(...points)
      strokeUpdates.schedule({ kind: current.kind, points })
    }
  }

  const finishGesture = () => {
    const current = gesture.current
    gesture.current = null
    if (!current || !page) return
    if (current.kind === 'move') {
      setSnapGuides({ x: false, y: false })
      finishTransform()
    } else if (current.kind === 'text') {
      const pointText =
        current.frame.width < 4 / camera.zoom && current.frame.height < 4 / camera.zoom
      setDraft(null)
      void (
        pointText
          ? call(commands.addPointText, current.start)
          : call(commands.addTextBox, current.frame)
      )
        .then(async (result) => {
          if (defaultFontSize !== null) {
            await call(commands.setTypography, [
              {
                layer: result.layer,
                typography: {
                  ...defaultTypography,
                  size: defaultFontSize,
                  auto_fit: false,
                },
              },
            ])
          }
          selectLayers([result.layer])
          return refresh(projectKey, pagesKey, pageKey)
        })
        .catch(() => undefined)
    } else if (current.kind === 'paint' || current.kind === 'erase' || current.kind === 'inpaint') {
      strokeUpdates.commit()
      try {
        canvas?.finishStroke()
      } catch {
        canvas?.cancelStroke()
      }
      const operation =
        current.kind === 'paint'
          ? enqueue(() =>
              call(commands.commitPaint, current.revision, current.page, current.layer, current.points, {
                diameter: current.diameter,
                hardness: current.hardness,
                color: current.color!,
              }),
            ).then((result) => {
              selectLayers([result.layer])
              return refresh(projectKey, pagesKey, pageKey)
            })
          : current.kind === 'erase'
            ? enqueue(() =>
                call(
                  commands.commitErase,
                  current.revision,
                  current.page,
                  current.layer!,
                  current.points,
                  current.diameter,
                  current.hardness,
                ),
              ).then((result) => {
                selectLayers([result.layer])
                return refresh(projectKey, pagesKey, pageKey)
              })
            : enqueue(() =>
              call(
                commands.commitInpaint,
                current.revision,
                current.page,
                current.points,
                current.diameter,
              ),
              )
      commitPending.current = true
      void operation
        .catch(() => canvas?.cancelStroke())
        .finally(() => (commitPending.current = false))
    }
  }

  return (
    <main className='relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-tl-2xl bg-[var(--surface-canvas)]'>
      <CanvasCommandBar />
      <div className='relative flex min-h-0 min-w-0 flex-1'>
        <ToolBar />
        <div
          ref={surface}
          tabIndex={0}
          aria-label={t('canvas.surface')}
          aria-busy={page ? !canvasInteractive : undefined}
          className='relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden bg-[var(--surface-canvas)] outline-none'
          style={{
            cursor: page && canvasInteractive ? canvasCursors[tool] : undefined,
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (
              !page ||
              !canvas ||
              !canvasInteractive ||
              canvasActiveRevision === null ||
              commitPending.current ||
              event.button > 1
            )
              return
            if (event.target instanceof Element && event.target.closest('[data-canvas-control]'))
              return
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            const physical = clientPhysicalPoint(event.clientX, event.clientY)
            const point = clientPagePoint(event.clientX, event.clientY)
            setCursor(physical)

            if (
              event.button === 0 &&
              !spaceHeld.current &&
              (tool === 'ocr_region' || tool === 'restore_region' || tool === 'inpaint_region')
            ) {
              const vertex = {
                x: clamp(point.x, 0, page.size.width),
                y: clamp(point.y, 0, page.size.height),
              }
              const action =
                tool === 'ocr_region' ? 'ocr' : tool === 'restore_region' ? 'restore' : 'inpaint'
              const current = polygon.current
              if (current && current.action === action) {
                const closeDistance = (8 * window.devicePixelRatio) / camera.zoom
                const distance = (a: Point) => Math.hypot(a.x - vertex.x, a.y - vertex.y)
                if (
                  current.points.length >= 3 &&
                  (distance(current.points[0]) <= closeDistance ||
                    distance(current.points[current.points.length - 1]) <= closeDistance)
                ) {
                  finishPolygon()
                } else if (current.points.length >= 256) {
                  receiveError('O polígono pode ter no máximo 256 vértices.')
                } else if (distance(current.points[current.points.length - 1]) > 0.5) {
                  polygon.current = {
                    ...current,
                    points: [...current.points, vertex],
                    cursor: vertex,
                  }
                  setPolygonDraft(polygon.current)
                }
              } else {
                polygon.current = {
                  action,
                  page: page.id,
                  revision: canvasActiveRevision!,
                  points: [vertex],
                  cursor: vertex,
                }
                setPolygonDraft(polygon.current)
              }
              event.preventDefault()
              return
            }

            if (event.button === 1 || tool === 'pan' || spaceHeld.current) {
              gesture.current = {
                kind: 'pan',
                pointer: event.pointerId,
                start: physical,
                translation: camera.translation,
              }
            } else if (tool === 'select') {
              const target = hitTestLayers(page.layers, point, layerFrames)
              const additive = event.shiftKey || event.ctrlKey || event.metaKey
              if (!target) {
                if (!additive) selectLayers([])
                return
              }
              const next = additive
                ? selected.includes(target.id)
                  ? selected.filter((id) => id !== target.id)
                  : [...selected, target.id]
                : selected.includes(target.id)
                  ? selected
                  : [target.id]
              selectLayers(next)
              if (!next.includes(target.id)) return
              const originals = framesFor(next)
              if (!originals.length) return
              gesture.current = {
                kind: 'move',
                pointer: event.pointerId,
                start: point,
                originals,
              }
              beginTransform(originals)
            } else if (tool === 'text') {
              const frame = draftFrame(point, point)
              gesture.current = {
                kind: 'text',
                pointer: event.pointerId,
                start: point,
                frame,
              }
              setDraft(frame)
            } else if (tool === 'draw') {
              strokeUpdates.clear()
              const color = hexToRgba(brush.color)
              gesture.current = {
                kind: 'paint',
                pointer: event.pointerId,
                page: page.id,
                revision: canvasActiveRevision!,
                layer: activeRaster?.id ?? null,
                points: [point],
                diameter: brush.diameter,
                hardness: brush.hardness,
                color,
              }
              try {
                canvas.beginStroke({
                  kind: 'paint',
                  layer: activeRaster?.id ?? null,
                  point,
                  diameter: brush.diameter,
                  hardness: brush.hardness,
                  color,
                })
              } catch {
                canvas.cancelStroke()
              }
            } else if (tool === 'eraser') {
              if (!activeRaster) {
                receiveError('Select a paint or cleanup layer before using the Eraser.')
                return
              }
              strokeUpdates.clear()
              gesture.current = {
                kind: 'erase',
                pointer: event.pointerId,
                page: page.id,
                revision: canvasActiveRevision!,
                layer: activeRaster.id,
                points: [point],
                diameter: brush.diameter,
                hardness: brush.hardness,
              }
              try {
                canvas.beginStroke({
                  kind: 'erase',
                  layer: activeRaster.id,
                  point,
                  diameter: brush.diameter,
                  hardness: brush.hardness,
                })
              } catch {
                canvas.cancelStroke()
              }
            } else if (tool === 'remove') {
              strokeUpdates.clear()
              gesture.current = {
                kind: 'inpaint',
                pointer: event.pointerId,
                page: page.id,
                revision: canvasActiveRevision!,
                layer: null,
                points: [point],
                diameter: brush.diameter,
                hardness: 100,
              }
              try {
                canvas.beginStroke({
                  kind: 'inpaint',
                  layer: null,
                  point,
                  diameter: brush.diameter,
                  hardness: 100,
                })
              } catch {
                canvas.cancelStroke()
              }
            } else if (tool === 'color_picker') {
              void canvas
                .sampleColor(physical)
                .then((color) => {
                  const hex = rgbaToHex(color)
                  if (!colorSampling?.complete(hex)) setBrush({ ...brush, color: hex })
                })
                .catch((error: unknown) => receiveError(errorMessage(error)))
            }
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            if (!page) return
            const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
            moveGesture(event.pointerId, coalesced.length ? coalesced : [event.nativeEvent])
          }}
          onPointerUp={(event) => {
            moveGesture(event.pointerId, [event.nativeEvent])
            finishGesture()
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          onPointerCancel={() => cancelGesture()}
          onPointerLeave={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
              setHovered(null)
              setCursor(null)
            }
          }}
          onWheel={(event) => {
            if (!page) return
            event.preventDefault()
            if (event.altKey && isBrushTool(tool)) {
              if (event.deltaY !== 0) {
                const currentBrush = useKoharuStore.getState().brush
                const delta = event.deltaY < 0 ? BRUSH_DIAMETER_STEP : -BRUSH_DIAMETER_STEP
                const nextDiameter = clamp(
                  currentBrush.diameter + delta,
                  MIN_BRUSH_DIAMETER,
                  maxBrushDiameter(page.size),
                )
                if (nextDiameter !== currentBrush.diameter) {
                  setBrush({ ...currentBrush, diameter: nextDiameter })
                }
              }
              return
            }
            const point = clientPhysicalPoint(event.clientX, event.clientY)
            const current = useKoharuStore.getState().camera
            let zoom = current.zoom
            let translation = current.translation
            if (event.ctrlKey) {
              zoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), 0.02, 16)
              const pageX = (point.x - current.translation[0]) / current.zoom
              const pageY = (point.y - current.translation[1]) / current.zoom
              translation = [point.x - pageX * zoom, point.y - pageY * zoom]
            } else {
              const dpr = window.devicePixelRatio
              let deltaX = event.deltaX
              let deltaY = event.deltaY
              if (event.shiftKey && deltaX === 0) {
                deltaX = deltaY
                deltaY = 0
              }
              translation = [
                current.translation[0] - deltaX * dpr,
                current.translation[1] - deltaY * dpr,
              ]
            }
            const bounds = event.currentTarget.getBoundingClientRect()
            const dpr = window.devicePixelRatio
            translation = clampCameraTranslation(
              translation,
              zoom,
              pageWidth ?? page.size.width,
              pageHeight ?? page.size.height,
              bounds.width * dpr,
              bounds.height * dpr,
              dpr,
            )
            useKoharuStore.setState({
              camera: { zoom, translation, fitted: false },
            })
          }}
        >
          <canvas
            ref={setCanvasElement}
            data-testid='webgpu-canvas'
            aria-hidden
            className='pointer-events-none absolute inset-0 block size-full'
          />
          {page && canvasInteractive && (
            <CanvasOverlay
              page={page}
              camera={camera}
              selected={selected}
              hovered={hovered}
              frames={layerFrames}
              previews={previews}
              fontSizes={fontSizes}
              resizeMode={resizeMode}
              draft={draft}
              polygonDraft={polygonDraft}
              cursor={cursor}
              brushSize={brush.diameter}
              brushHardness={brush.hardness}
              showBrushCursor={isBrushTool(tool)}
              showSelectionControls={tool === 'select'}
              onTransformStart={beginTransform}
              onTransformFrame={updateTransform}
              onTransformEnd={finishTransform}
              onShearStart={beginShear}
              onShearPreview={previewShear}
              onShearEnd={finishShear}
            />
          )}
          {page && snapGuides.x && (
            <div
              aria-hidden
              className='pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-fuchsia-400/90 shadow-[0_0_5px_rgba(232,121,249,0.8)]'
              style={{
                left: `${(camera.translation[0] + (page.size.width * camera.zoom) / 2) / window.devicePixelRatio}px`,
              }}
            />
          )}
          {page && snapGuides.y && (
            <div
              aria-hidden
              className='pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-fuchsia-400/90 shadow-[0_0_5px_rgba(232,121,249,0.8)]'
              style={{
                top: `${(camera.translation[1] + (page.size.height * camera.zoom) / 2) / window.devicePixelRatio}px`,
              }}
            />
          )}
          {page && canvasState.status === 'error' && (
            <div
              role='alert'
              className={
                canvasState.hasFrame
                  ? 'absolute inset-x-0 top-3 z-20 flex justify-center px-3'
                  : 'absolute inset-0 z-20 grid place-items-center bg-[var(--surface-canvas)]/90 p-6'
              }
            >
              <div
                className={
                  canvasState.hasFrame
                    ? 'flex max-w-sm flex-col items-center gap-2 rounded-md border border-border bg-popover/95 p-3 text-center shadow-sm'
                    : 'flex max-w-sm flex-col items-center gap-2 text-center'
                }
              >
                <p className='text-sm font-medium text-foreground'>{t('canvas.unavailable')}</p>
                {canvasState.error && (
                  <p className='text-xs leading-relaxed text-muted-foreground'>
                    {canvasState.error.message}
                  </p>
                )}
                <Button
                  data-canvas-control
                  size='sm'
                  variant='outline'
                  className='mt-1'
                  onClick={canvasState.retry}
                >
                  {t('errors.tryAgain')}
                </Button>
              </div>
            </div>
          )}
          {!page && (
            <div className='pointer-events-none absolute inset-0 grid place-items-center'>
              <p className='text-[12px] text-muted-foreground'>{t('canvas.empty')}</p>
            </div>
          )}
        </div>
      </div>
      <StatusBar onZoomChange={setZoom} />
    </main>
  )
}

function hexToRgba(hex: string): [number, number, number, number] {
  const value = hex.replace('#', '')
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255,
  ]
}

function rgbaToHex(color: [number, number, number, number]): string {
  return `#${color
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function framesBoundsCenter(elements: TransformFrame[]): Point {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const { frame } of elements) {
    const centerX = frame.x + frame.width * 0.5
    const centerY = frame.y + frame.height * 0.5
    const radians = (frame.angle_degrees * Math.PI) / 180
    const halfWidth =
      Math.abs(Math.cos(radians)) * frame.width * 0.5 +
      Math.abs(Math.sin(radians)) * frame.height * 0.5
    const halfHeight =
      Math.abs(Math.sin(radians)) * frame.width * 0.5 +
      Math.abs(Math.cos(radians)) * frame.height * 0.5
    left = Math.min(left, centerX - halfWidth)
    right = Math.max(right, centerX + halfWidth)
    top = Math.min(top, centerY - halfHeight)
    bottom = Math.max(bottom, centerY + halfHeight)
  }
  return { x: (left + right) * 0.5, y: (top + bottom) * 0.5 }
}

function containCamera(
  viewportWidth: number,
  viewportHeight: number,
  pageWidth: number,
  pageHeight: number,
): CanvasView {
  if (viewportWidth <= 0 || viewportHeight <= 0 || pageWidth <= 0 || pageHeight <= 0) {
    return { zoom: 1, translation: [0, 0] }
  }
  const zoom = Math.max(
    Number.EPSILON,
    Math.min(viewportWidth / pageWidth, viewportHeight / pageHeight),
  )
  return {
    zoom,
    translation: [
      (viewportWidth - pageWidth * zoom) * 0.5,
      (viewportHeight - pageHeight * zoom) * 0.5,
    ],
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'The WebGPU canvas returned an unknown error.'
}

function clampCameraTranslation(
  translation: [number, number],
  zoom: number,
  pageWidth: number,
  pageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  dpr: number,
): [number, number] {
  const minOverlap = 100 * dpr
  const minX = minOverlap - pageWidth * zoom
  const minY = minOverlap - pageHeight * zoom
  const maxX = viewportWidth - minOverlap
  const maxY = viewportHeight - minOverlap

  const x =
    minX <= maxX ? clamp(translation[0], minX, maxX) : (viewportWidth - pageWidth * zoom) * 0.5
  const y =
    minY <= maxY ? clamp(translation[1], minY, maxY) : (viewportHeight - pageHeight * zoom) * 0.5
  return [x, y]
}

function mergeStrokeUpdates(current: StrokeUpdate, next: StrokeUpdate): StrokeUpdate {
  if (current.kind !== next.kind) return next
  current.points.push(...next.points)
  return current
}

function useFrameCommand<Value>(
  execute: (value: Value) => void | Promise<unknown>,
  merge?: (current: Value, next: Value) => Value,
): FrameCommand<Value> {
  const executeRef = useRef(execute)
  executeRef.current = execute
  const command = useRef<FrameCommand<Value> | null>(null)
  command.current ??= new FrameCommand((value) => executeRef.current(value), merge)

  useEffect(() => () => command.current?.clear(), [])
  return command.current
}

class FrameCommand<Value> {
  private pending: Value | undefined
  private frame: number | null = null

  constructor(
    private readonly execute: (value: Value) => void | Promise<unknown>,
    private readonly merge: (current: Value, next: Value) => Value = (_current, next) => next,
  ) {}

  schedule(value: Value): void {
    this.pending = this.pending === undefined ? value : this.merge(this.pending, value)
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.executePending()
    })
  }

  commit(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    this.executePending()
  }

  clear(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.pending = undefined
  }

  private executePending(): void {
    const value = this.pending
    if (value === undefined) return
    this.pending = undefined
    try {
      void Promise.resolve(this.execute(value)).catch((error: unknown) =>
        receiveError(errorMessage(error)),
      )
    } catch (error) {
      receiveError(errorMessage(error))
    }
  }
}
