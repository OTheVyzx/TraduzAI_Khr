import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasWorkspace } from '@/components/editor/CanvasWorkspace'
import { pageKey, pagesKey, projectKey, queryClient } from '@/lib/queries'
import { useKoharuStore } from '@/lib/store'
import { defaultTypography } from '@/lib/typography'
import { commands, type Layer } from '@koharu/bridge/protocol'
import { TooltipProvider } from '@koharu/ui/components/tooltip'

const canvas = vi.hoisted(() => ({
  resize: vi.fn(),
  setView: vi.fn(),
  stageManifest: vi.fn(),
  installResource: vi.fn(),
  activateFrame: vi.fn(),
  activatePage: vi.fn(),
  clear: vi.fn(),
  previewOpacity: vi.fn(),
  beginTransform: vi.fn(),
  updateTransform: vi.fn(),
  finishTransform: vi.fn(),
  cancelTransform: vi.fn(),
  beginStroke: vi.fn(),
  extendStroke: vi.fn(),
  finishStroke: vi.fn(),
  cancelStroke: vi.fn(),
  sampleColor: vi.fn(),
  dispose: vi.fn(),
}))

const canvasState = vi.hoisted(() => ({
  activePage: 'page' as string | null,
  activeRevision: 1 as number | null,
  canvas,
  error: null as Error | null,
  generation: 1 as number | null,
  hasFrame: true,
  retry: vi.fn(),
  status: 'ready' as 'loading' | 'switching' | 'ready' | 'recovering' | 'error',
}))
const prefetchCanvasPages = vi.hoisted(() => vi.fn(async () => []))

vi.mock('@/components/editor/useCanvas', () => ({
  useCanvas: () => canvasState,
}))
vi.mock('@koharu/bridge/canvas', () => ({
  prefetchCanvasPages,
  workspaceColor: () => [245, 245, 245],
}))

const layer: Layer = {
  type: 'image',
  id: 'element',
  parent: 'page',
  geometry: {
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 70 },
      { x: 10, y: 70 },
    ],
  },
  visibility: { visible: true, opacity: 1 },
  image: 'image',
}

const paintLayer: Layer = {
  type: 'raster',
  id: 'paint',
  parent: 'page',
  visibility: { visible: true, opacity: 1 },
  image: 'paint-image',
  name: 'Paint 1',
  kind: 'paint',
}

const dialogueLayer: Layer = {
  type: 'text',
  id: 'dialogue',
  parent: 'page',
  geometry: layer.geometry,
  angle_degrees: 0,
  visibility: { visible: true, opacity: 1 },
  content: {
    id: 'dialogue-content',
    source: { text: 'Original line', language: 'en' },
    translation: { text: 'Linha traduzida', language: 'pt-BR' },
    role: null,
    source_region: null,
  },
  typography: defaultTypography,
  layout: 'paragraph',
  automatic_region: null,
}

let nextAnimationFrame = 1
let animationFrames = new Map<number, FrameRequestCallback>()

beforeEach(() => {
  nextAnimationFrame = 1
  animationFrames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = nextAnimationFrame++
    animationFrames.set(frame, callback)
    return frame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => animationFrames.delete(frame))
  canvasState.error = null
  canvasState.activePage = 'page'
  canvasState.activeRevision = 1
  canvasState.generation = 1
  canvasState.hasFrame = true
  canvasState.status = 'ready'
  prefetchCanvasPages.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

function installProject() {
  const page = {
    id: 'page',
    label: 'Page',
    size: { width: 1000, height: 1000 },
    layers: [layer],
    regions: [],
  }
  queryClient.setQueryData(projectKey, {
    name: 'Book',
    revision: 1,
    active_page: 'page',
    can_undo: false,
    can_redo: false,
  })
  queryClient.setQueryData(pagesKey, [])
  queryClient.setQueryData(pageKey, page)
  useKoharuStore.setState({ selectedLayers: [], tool: 'select' })
  useKoharuStore.setState({
    canvasPage: 'page',
    canvasRevision: 1,
    canvasGeneration: 1,
    canvasSize: [1000, 1000],
  })
}

function renderWorkspace() {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CanvasWorkspace />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  const surface = screen.getByLabelText('Koharu canvas')
  Object.defineProperty(surface, 'getBoundingClientRect', {
    value: () => ({ x: 10, y: 20, width: 800, height: 600 }),
  })
  return surface
}

describe('canvas interaction adapter', () => {
  it('prefetches only after the authoritative canvas page and generation are active', async () => {
    installProject()
    queryClient.setQueryData(pagesKey, [
      {
        id: 'page',
        label: 'Page',
        size: { width: 1000, height: 1000 },
        source_asset: null,
        layer_count: 1,
      },
      {
        id: 'next',
        label: 'Next',
        size: { width: 1000, height: 1000 },
        source_asset: null,
        layer_count: 1,
      },
    ])
    useKoharuStore.setState({ canvasPage: 'previous' })
    renderWorkspace()

    await Promise.resolve()
    expect(prefetchCanvasPages).not.toHaveBeenCalled()

    act(() => useKoharuStore.setState({ canvasPage: 'page' }))
    await waitFor(() => expect(prefetchCanvasPages).toHaveBeenCalledWith(['next']))
  })

  it('renders an accessible browser canvas and keeps camera updates local', async () => {
    installProject()
    const surface = renderWorkspace()
    expect(screen.getByTestId('webgpu-canvas')).toBeInstanceOf(HTMLCanvasElement)

    fireEvent.wheel(surface, { clientX: 100, clientY: 100, deltaY: 4 })
    fireEvent.wheel(surface, { clientX: 100, clientY: 100, deltaY: 6 })

    await waitFor(() => expect(canvas.setView).toHaveBeenLastCalledWith(1, [0, -10]))
  })

  it('preserves a manual camera when a newer canvas generation becomes ready', () => {
    installProject()
    renderWorkspace()
    const camera = { zoom: 2, translation: [-120, -80] as [number, number], fitted: false }

    act(() => useKoharuStore.setState({ camera }))
    act(() => {
      canvasState.status = 'switching'
      useKoharuStore.setState({ canvasGeneration: 2 })
    })
    act(() => {
      canvasState.status = 'ready'
      canvasState.generation = 2
      useKoharuStore.setState({ canvasRevision: 2 })
    })

    expect(useKoharuStore.getState().camera).toEqual(camera)
  })

  it('suppresses Alt browser handling while an editor input retains focus', () => {
    installProject()
    renderWorkspace()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    const event = new KeyboardEvent('keydown', { key: 'Alt', bubbles: true, cancelable: true })
    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    input.remove()
  })

  it('announces WebGPU startup failures and offers recovery', () => {
    installProject()
    canvasState.status = 'error'
    canvasState.error = new Error('No compatible WebGPU adapter was found.')
    renderWorkspace()
    expect(screen.getByRole('alert')).toHaveTextContent('WebGPU canvas unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent('No compatible WebGPU adapter was found.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(canvasState.retry).toHaveBeenCalledOnce()
  })

  it('previews brush input locally and sends only the durable paint commit to Rust', async () => {
    installProject()
    useKoharuStore.setState({
      tool: 'draw',
      brush: { diameter: 48, hardness: 100, color: '#FFFFFF' },
    })
    const commit = vi
      .spyOn(commands, 'commitPaint')
      .mockResolvedValue({ revision: 2, layer: 'paint' })
    const surface = renderWorkspace()
    expect(surface).toHaveStyle({ cursor: 'none' })

    fireEvent.pointerDown(surface, { button: 0, pointerId: 7, clientX: 30, clientY: 40 })
    fireEvent.pointerMove(surface, { pointerId: 7, clientX: 55, clientY: 65 })
    fireEvent.pointerUp(surface, { pointerId: 7, clientX: 58, clientY: 70 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginStroke).toHaveBeenCalledWith({
      kind: 'paint',
      layer: null,
      point: { x: 20, y: 20 },
      diameter: 48,
      hardness: 100,
      color: [255, 255, 255, 255],
    })
    expect(canvas.extendStroke).toHaveBeenCalledWith(expect.arrayContaining([{ x: 45, y: 45 }]))
    expect(canvas.finishStroke).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(1, 'page', null, expect.arrayContaining([{ x: 45, y: 45 }]), {
      diameter: 48,
      hardness: 100,
      color: [255, 255, 255, 255],
    })
  })

  it('copies and pastes selected text layers with Ctrl+C and Ctrl+V', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [dialogueLayer],
    }))
    useKoharuStore.setState({ selectedLayers: ['dialogue'] })
    const addTextBox = vi
      .spyOn(commands, 'addTextBox')
      .mockResolvedValue({ revision: 2, layer: 'pasted-dialogue' })
    const setSourceText = vi.spyOn(commands, 'setSourceText').mockResolvedValue(null)
    const setTranslation = vi.spyOn(commands, 'setTranslation').mockResolvedValue(null)
    const setTypography = vi.spyOn(commands, 'setTypography').mockResolvedValue(null)
    vi.spyOn(commands, 'getProject').mockResolvedValue({
      name: 'Book',
      revision: 2,
      active_page: 'page',
      can_undo: false,
      can_redo: false,
    })
    const commitTransform = vi.spyOn(commands, 'commitTransform').mockResolvedValue(3)
    renderWorkspace()

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true })

    await waitFor(() => expect(setTypography).toHaveBeenCalledOnce())
    expect(addTextBox).toHaveBeenCalledWith({
      x: 22,
      y: 32,
      width: 100,
      height: 50,
      angle_degrees: 0,
    })
    expect(setSourceText).toHaveBeenCalledWith('pasted-dialogue', 'Original line')
    expect(setTranslation).toHaveBeenCalledWith('pasted-dialogue', 'Linha traduzida')
    expect(setTypography).toHaveBeenCalledWith([
      { layer: 'pasted-dialogue', typography: defaultTypography },
    ])
    expect(commitTransform).toHaveBeenCalledWith(2, 'page', [
      {
        element: 'pasted-dialogue',
        frame: { x: 22, y: 32, width: 100, height: 50, angle_degrees: 0 },
      },
    ])
    expect(useKoharuStore.getState().selectedLayers).toEqual(['pasted-dialogue'])
  })

  it.each([
    ['revision', { canvasRevision: 2 }],
    ['generation', { canvasGeneration: 2 }],
  ])('keeps an active gesture when the canvas %s changes', async (_name, update) => {
    installProject()
    useKoharuStore.setState({
      tool: 'draw',
      brush: { diameter: 48, hardness: 100, color: '#FFFFFF' },
    })
    const commit = vi
      .spyOn(commands, 'commitPaint')
      .mockResolvedValue({ revision: 2, layer: 'paint' })
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 8, clientX: 30, clientY: 40 })
    expect(canvas.beginStroke).toHaveBeenCalledOnce()

    act(() => {
      useKoharuStore.setState(update)
    })

    expect(canvas.cancelStroke).not.toHaveBeenCalled()
    fireEvent.pointerUp(surface, { pointerId: 8, clientX: 30, clientY: 40 })
    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.finishStroke).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(1, 'page', null, expect.any(Array), expect.any(Object))
  })

  it('keeps the canvas editable on the same page while the next frame is prepared', async () => {
    installProject()
    useKoharuStore.setState({
      canvasGeneration: 2,
      tool: 'draw',
      brush: { diameter: 48, hardness: 100, color: '#FFFFFF' },
    })
    canvasState.status = 'switching'
    const commit = vi
      .spyOn(commands, 'commitPaint')
      .mockResolvedValue({ revision: 2, layer: 'paint' })
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 81, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 81, clientX: 30, clientY: 40 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(commit).toHaveBeenCalledWith(1, 'page', null, expect.any(Array), expect.any(Object))
  })

  it('uses rendered text bounds for hit testing and semantic transforms', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [
        {
          type: 'text',
          id: 'element',
          parent: 'page',
          geometry: layer.geometry,
          angle_degrees: 0,
          visibility: { visible: true, opacity: 1 },
          content: {
            id: 'content',
            source: { text: 'Source', language: 'en' },
            translation: { text: 'Rendered', language: null },
            role: null,
            source_region: null,
          },
          typography: null,
          layout: 'paragraph',
          automatic_region: null,
        },
      ],
    }))
    useKoharuStore.setState({
      layerFrames: {
        element: { x: 30, y: 40, width: 50, height: 20, angle_degrees: 0 },
      },
    })
    const commit = vi.spyOn(commands, 'commitTransform').mockResolvedValue(2)
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 9, clientX: 50, clientY: 60 })
    fireEvent.pointerMove(surface, { pointerId: 9, clientX: 70, clientY: 80 })
    fireEvent.pointerUp(surface, { pointerId: 9, clientX: 70, clientY: 80 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(useKoharuStore.getState().selectedLayers).toEqual(['element'])
    expect(canvas.beginTransform).toHaveBeenCalledWith([
      {
        element: 'element',
        frame: { x: 30, y: 40, width: 50, height: 20, angle_degrees: 0 },
      },
    ])
    expect(canvas.updateTransform).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          element: 'element',
          frame: expect.objectContaining({ x: 50, y: 60 }),
        }),
      ]),
    )
    expect(canvas.finishTransform).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(
      1,
      'page',
      expect.arrayContaining([
        expect.objectContaining({
          element: 'element',
          frame: expect.objectContaining({ x: 50, y: 60 }),
        }),
      ]),
    )
  })

  it('resizes a selected layer through Koharu selection controls', async () => {
    installProject()
    useKoharuStore.setState({ selectedLayers: ['element'] })
    const commit = vi.spyOn(commands, 'commitTransform').mockResolvedValue(2)
    renderWorkspace()
    Object.defineProperty(screen.getByTestId('canvas-overlay'), 'getBoundingClientRect', {
      value: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    })
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="e"]')!

    fireEvent.pointerDown(handle, { button: 0, pointerId: 10, clientX: 120, clientY: 65 })
    fireEvent.pointerMove(handle, { pointerId: 10, clientX: 140, clientY: 65 })
    fireEvent.pointerUp(handle, { pointerId: 10, clientX: 140, clientY: 65 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginTransform).toHaveBeenCalledWith([
      { element: 'element', frame: { x: 10, y: 20, width: 100, height: 50, angle_degrees: 0 } },
    ])
    expect(canvas.updateTransform).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          element: 'element',
          frame: { x: 10, y: 20, width: 120, height: 50, angle_degrees: 0 },
        },
      ]),
    )
    expect(commit).toHaveBeenCalledWith(
      1,
      'page',
      expect.arrayContaining([
        {
          element: 'element',
          frame: { x: 10, y: 20, width: 120, height: 50, angle_degrees: 0 },
        },
      ]),
    )
  })

  it('scales the rendered font size with a text frame in proportional mode', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [
        {
          type: 'text',
          id: 'element',
          parent: 'page',
          geometry: layer.geometry,
          angle_degrees: 0,
          visibility: { visible: true, opacity: 1 },
          content: {
            id: 'content',
            source: { text: 'Source', language: 'en' },
            translation: { text: 'Text', language: null },
            role: null,
            source_region: null,
          },
          typography: null,
          layout: 'paragraph',
          automatic_region: null,
        },
      ],
    }))
    useKoharuStore.setState({
      selectedLayers: ['element'],
      resizeMode: 'scale',
      fontSizes: { element: 20 },
    })
    vi.spyOn(commands, 'commitTransform').mockResolvedValue(2)
    const setTypography = vi.spyOn(commands, 'setTypography').mockResolvedValue(null)
    renderWorkspace()
    Object.defineProperty(screen.getByTestId('canvas-overlay'), 'getBoundingClientRect', {
      value: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    })
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="e"]')!
    fireEvent.pointerDown(handle, { button: 0, pointerId: 11, clientX: 120, clientY: 65 })
    fireEvent.pointerMove(handle, { pointerId: 11, clientX: 140, clientY: 65 })
    fireEvent.pointerUp(handle, { pointerId: 11, clientX: 140, clientY: 65 })

    await waitFor(() =>
      expect(setTypography).toHaveBeenCalledWith([
        expect.objectContaining({
          layer: 'element',
          typography: expect.objectContaining({ size: 24, auto_fit: false }),
        }),
      ]),
    )
  })

  it('shears selected text when the pink edge is dragged without rotating it', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [
        {
          type: 'text',
          id: 'element',
          parent: 'page',
          geometry: layer.geometry,
          angle_degrees: 0,
          visibility: { visible: true, opacity: 1 },
          content: {
            id: 'content',
            source: { text: 'Source', language: 'en' },
            translation: { text: 'Text', language: null },
            role: null,
            source_region: null,
          },
          typography: null,
          layout: 'paragraph',
          automatic_region: null,
        },
      ],
    }))
    useKoharuStore.setState({ selectedLayers: ['element'] })
    const setTypography = vi.spyOn(commands, 'setTypography').mockResolvedValue(null)
    renderWorkspace()
    Object.defineProperty(screen.getByTestId('canvas-overlay'), 'getBoundingClientRect', {
      value: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    })
    const handle = document.querySelector<HTMLElement>('[data-shear-handle]')!
    expect(handle).not.toBeNull()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 12, clientX: 60, clientY: 20 })
    fireEvent.pointerMove(handle, { pointerId: 12, clientX: 80, clientY: 20 })
    fireEvent.pointerUp(handle, { pointerId: 12, clientX: 80, clientY: 20 })

    expect(canvas.beginTransform).toHaveBeenCalledOnce()
    expect(canvas.updateTransform).toHaveBeenCalledWith(
      [{ element: 'element', frame: { x: 10, y: 20, width: 100, height: 50, angle_degrees: 0 } }],
      { x: 0.4, y: 0 },
    )

    await waitFor(() =>
      expect(setTypography).toHaveBeenCalledWith([
        expect.objectContaining({
          layer: 'element',
          typography: expect.objectContaining({ shear_x: 0.4 }),
        }),
      ]),
    )
  })

  it('shears selected text vertically while preserving horizontal shear', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [
        {
          type: 'text',
          id: 'element',
          parent: 'page',
          geometry: layer.geometry,
          angle_degrees: 0,
          visibility: { visible: true, opacity: 1 },
          content: {
            id: 'content',
            source: { text: 'Source', language: 'en' },
            translation: { text: 'Text', language: null },
            role: null,
            source_region: null,
          },
          typography: { ...defaultTypography, shear_x: 0.2 },
          layout: 'paragraph',
          automatic_region: null,
        },
      ],
    }))
    useKoharuStore.setState({ selectedLayers: ['element'] })
    const setTypography = vi.spyOn(commands, 'setTypography').mockResolvedValue(null)
    renderWorkspace()
    Object.defineProperty(screen.getByTestId('canvas-overlay'), 'getBoundingClientRect', {
      value: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    })
    const handle = document.querySelector<HTMLElement>('[data-shear-y-handle]')!
    expect(handle).not.toBeNull()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 13, clientX: 10, clientY: 45 })
    fireEvent.pointerMove(handle, { pointerId: 13, clientX: 10, clientY: 75 })
    fireEvent.pointerUp(handle, { pointerId: 13, clientX: 10, clientY: 75 })

    expect(canvas.beginTransform).toHaveBeenCalledWith(
      [{ element: 'element', frame: { x: 10, y: 20, width: 100, height: 50, angle_degrees: 0 } }],
      { x: 0.2, y: 0 },
    )
    expect(canvas.updateTransform).toHaveBeenCalledWith(
      [{ element: 'element', frame: { x: 10, y: 20, width: 100, height: 50, angle_degrees: 0 } }],
      { x: 0.2, y: 0.3 },
    )
    await waitFor(() =>
      expect(setTypography).toHaveBeenCalledWith([
        expect.objectContaining({
          layer: 'element',
          typography: expect.objectContaining({ shear_x: 0.2, shear_y: 0.3 }),
        }),
      ]),
    )
  })

  it('shows the automatic region behind the selected text controls', () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [
        {
          type: 'text',
          id: 'element',
          parent: 'page',
          geometry: null,
          angle_degrees: null,
          visibility: { visible: true, opacity: 1 },
          content: {
            id: 'content',
            source: { text: 'Source', language: 'en' },
            translation: { text: 'Rendered', language: null },
            role: null,
            source_region: null,
          },
          typography: null,
          layout: 'paragraph',
          automatic_region: 'bubble',
        },
      ],
      regions: [
        {
          id: 'bubble',
          parent: 'page',
          geometry: {
            points: [
              { x: 20, y: 30 },
              { x: 100, y: 30 },
              { x: 100, y: 90 },
              { x: 20, y: 90 },
            ],
          },
          kind: 'bubble',
          label: null,
        },
      ],
    }))
    useKoharuStore.setState({
      selectedLayers: ['element'],
      layerFrames: {
        element: { x: 30, y: 40, width: 50, height: 20, angle_degrees: 0 },
      },
    })

    renderWorkspace()

    expect(screen.getByTestId('text-fit-region').querySelector('polygon')).toHaveAttribute(
      'points',
      '20,30 100,30 100,90 20,90',
    )
  })

  it('targets the selected raster layer with the eraser', async () => {
    installProject()
    queryClient.setQueryData(pageKey, (page: { layers: Layer[] }) => ({
      ...page,
      layers: [...page.layers, paintLayer],
    }))
    useKoharuStore.setState({ tool: 'eraser', selectedLayers: ['paint'] })
    const commit = vi
      .spyOn(commands, 'commitErase')
      .mockResolvedValue({ revision: 2, layer: 'paint' })
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 11, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 11, clientX: 30, clientY: 40 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginStroke).toHaveBeenCalledWith({
      kind: 'erase',
      layer: 'paint',
      point: { x: 20, y: 20 },
      diameter: 48,
      hardness: 100,
    })
    expect(commit).toHaveBeenCalledWith(
      1,
      'page',
      'paint',
      expect.arrayContaining([{ x: 20, y: 20 }]),
      48,
      100,
    )
  })

  it('maps the Remove tool to an inpainting mask gesture', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'remove' })
    const commit = vi.spyOn(commands, 'commitInpaint').mockResolvedValue('job')
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 12, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 12, clientX: 30, clientY: 40 })

    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(canvas.beginStroke).toHaveBeenCalledWith({
      kind: 'inpaint',
      layer: null,
      point: { x: 20, y: 20 },
      diameter: 48,
      hardness: 100,
    })
    expect(commit).toHaveBeenCalledWith(1, 'page', expect.arrayContaining([{ x: 20, y: 20 }]), 48)
  })

  it('creates point text on click and paragraph text on drag', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'text' })
    const point = vi
      .spyOn(commands, 'addPointText')
      .mockResolvedValue({ revision: 2, layer: 'point-text' })
    const box = vi
      .spyOn(commands, 'addTextBox')
      .mockResolvedValue({ revision: 3, layer: 'box-text' })
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 13, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 13, clientX: 30, clientY: 40 })
    await waitFor(() => expect(point).toHaveBeenCalledWith({ x: 20, y: 20 }))

    fireEvent.pointerDown(surface, { button: 0, pointerId: 14, clientX: 40, clientY: 50 })
    fireEvent.pointerMove(surface, { pointerId: 14, clientX: 140, clientY: 110 })
    fireEvent.pointerUp(surface, { pointerId: 14, clientX: 140, clientY: 110 })
    await waitFor(() => expect(box).toHaveBeenCalledOnce())
    expect(box).toHaveBeenCalledWith({
      x: 30,
      y: 30,
      width: 100,
      height: 60,
      angle_degrees: 0,
    })
  })

  it('applies the configured fixed size to newly created text', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'text', defaultFontSize: 28 })
    vi.spyOn(commands, 'addPointText').mockResolvedValue({ revision: 2, layer: 'new-text' })
    const setTypography = vi.spyOn(commands, 'setTypography').mockResolvedValue(null)
    const surface = renderWorkspace()

    fireEvent.pointerDown(surface, { button: 0, pointerId: 51, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(surface, { pointerId: 51, clientX: 30, clientY: 40 })

    await waitFor(() =>
      expect(setTypography).toHaveBeenCalledWith([
        expect.objectContaining({
          layer: 'new-text',
          typography: expect.objectContaining({ size: 28, auto_fit: false }),
        }),
      ]),
    )
  })

  it('recognizes a closed polygon and selects its text layer', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'ocr_region', defaultFontSize: 26, ocrRegionAngle: 30 })
    const recognize = vi.spyOn(commands, 'recognizeSelectedRegion').mockResolvedValue({
      revision: 2,
      layer: 'recognized-text',
      job: 'ocr-job',
    })
    const surface = renderWorkspace()

    for (const [x, y] of [
      [40, 50],
      [140, 50],
      [140, 110],
      [40, 110],
    ]) {
      fireEvent.pointerDown(surface, { button: 0, pointerId: 21, clientX: x, clientY: y })
      fireEvent.pointerUp(surface, { pointerId: 21, clientX: x, clientY: y })
    }
    expect(recognize).not.toHaveBeenCalled()
    fireEvent.pointerDown(surface, { button: 0, pointerId: 21, clientX: 40, clientY: 50 })
    fireEvent.pointerUp(surface, { pointerId: 21, clientX: 40, clientY: 50 })

    await waitFor(() => expect(recognize).toHaveBeenCalledOnce())
    expect(recognize).toHaveBeenCalledWith(
      1,
      'page',
      [
        { x: 30, y: 30 },
        { x: 130, y: 30 },
        { x: 130, y: 90 },
        { x: 30, y: 90 },
      ],
      26,
      30,
    )
    expect(useKoharuStore.getState().selectedLayers).toEqual(['recognized-text'])
  })

  it('restores a concave polygon only after Enter', async () => {
    installProject()
    useKoharuStore.setState({ tool: 'restore_region' })
    const restore = vi.spyOn(commands, 'restoreOriginalRegion').mockResolvedValue(2)
    const surface = renderWorkspace()

    const vertices = [
      [40, 50],
      [140, 50],
      [140, 110],
      [90, 80],
      [40, 110],
    ]
    for (const [x, y] of vertices) {
      fireEvent.pointerDown(surface, { button: 0, pointerId: 22, clientX: x, clientY: y })
      fireEvent.pointerUp(surface, { pointerId: 22, clientX: x, clientY: y })
    }
    expect(restore).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => expect(restore).toHaveBeenCalledOnce())
    expect(restore).toHaveBeenCalledWith(1, 'page', [
      { x: 30, y: 30 },
      { x: 130, y: 30 },
      { x: 130, y: 90 },
      { x: 80, y: 60 },
      { x: 30, y: 90 },
    ])
  })

  it('cancels a polygon selection with Escape', () => {
    installProject()
    useKoharuStore.setState({ tool: 'restore_region' })
    const restore = vi.spyOn(commands, 'restoreOriginalRegion').mockResolvedValue(2)
    const surface = renderWorkspace()
    for (const [x, y] of [
      [40, 50],
      [140, 50],
      [140, 110],
    ]) {
      fireEvent.pointerDown(surface, { button: 0, pointerId: 23, clientX: x, clientY: y })
      fireEvent.pointerUp(surface, { pointerId: 23, clientX: x, clientY: y })
    }
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(restore).not.toHaveBeenCalled()
  })
})
