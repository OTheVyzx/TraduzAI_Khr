'use client'

import { create } from 'zustand'

import type {
  CanvasState,
  Download,
  EntityId,
  Job,
  Model,
  Frame,
  Preferences,
  Stage,
  StartupState,
  ModelResources,
  PageSize,
} from '@koharu/bridge/protocol'
import { toast } from '@koharu/ui/components/toast'

export type CanvasTool =
  | 'select'
  | 'text'
  | 'ocr_region'
  | 'inpaint_region'
  | 'draw'
  | 'eraser'
  | 'restore_region'
  | 'color_picker'
  | 'remove'
  | 'pan'
export const MIN_BRUSH_DIAMETER = 1
export function maxBrushDiameter(size: PageSize): number {
  // Assume that for all sizes below 2048 width, 128 is sufficient.
  // For anything above, scale by percentage greater than 2048 width.
  return Math.round(Math.max(size.width / 2048, 1.0) * 128)
}

export function isBrushTool(tool: CanvasTool): boolean {
  return tool === 'draw' || tool === 'eraser' || tool === 'remove'
}

export interface CanvasBrush {
  diameter: number
  hardness: number
  color: string
}
export type InspectorSection = 'copy' | 'type' | 'layers'
export type ShortcutAction = CanvasTool | 'fit'
export type Shortcuts = Record<ShortcutAction, string>
export type PipelineScope = 'page' | 'selected-pages' | 'project'
export type ResizeMode = 'box' | 'scale'
export const pipelineStages: readonly Stage[] = ['detection', 'ocr', 'translation', 'inpainting']

interface KoharuStore {
  initialized: boolean
  preferences: Preferences | null
  translationModels: Model[]
  resources: ModelResources | null
  jobs: Record<string, Job>
  downloads: Record<string, Download>
  camera: { zoom: number; translation: [number, number]; fitted: boolean }
  canvasPage: EntityId | null
  canvasRevision: number | null
  canvasGeneration: number
  canvasSize: [number, number]
  fitCanvasRequest: number
  layerFrames: Record<EntityId, Frame>
  fontSizes: Record<EntityId, number>
  resizeMode: ResizeMode
  defaultFontSize: number | null
  ocrRegionAngle: number
  selectedLayers: EntityId[]
  selectedPages: EntityId[]
  tool: CanvasTool
  snapToCenter: boolean
  brush: CanvasBrush
  inspector: InspectorSection
  processingScope: PipelineScope
  processingStages: Stage[]
  settingsOpen: boolean
  shortcuts: Shortcuts
  selectPages: (pages: EntityId[]) => void
  showInspector: (section: InspectorSection) => void
  setProcessingScope: (scope: PipelineScope) => void
  setProcessingStages: (stages: Stage[]) => void
  setSettingsOpen: (open: boolean) => void
  selectLayers: (layers: EntityId[]) => void
  setTool: (tool: CanvasTool) => void
  setSnapToCenter: (enabled: boolean) => void
  setBrush: (brush: CanvasBrush) => void
  setResizeMode: (mode: ResizeMode) => void
  setDefaultFontSize: (size: number | null) => void
  setOcrRegionAngle: (angle: number) => void
  setShortcut: (action: ShortcutAction, key: string) => void
  requestCanvasFit: () => void
  dismissJob: (id: string) => void
  dismissDownload: (id: number) => void
}

export const defaultShortcuts: Shortcuts = {
  select: 'v',
  text: 't',
  ocr_region: 'o',
  inpaint_region: 'u',
  draw: 'b',
  eraser: 'e',
  restore_region: 'r',
  color_picker: 'i',
  remove: 'j',
  pan: 'h',
  fit: '0',
}

export const useKoharuStore = create<KoharuStore>()((set) => ({
  initialized: false,
  preferences: null,
  translationModels: [],
  resources: null,
  jobs: {},
  downloads: {},
  camera: { zoom: 1, translation: [0, 0], fitted: true },
  canvasPage: null,
  canvasRevision: null,
  canvasGeneration: 0,
  canvasSize: [0, 0],
  fitCanvasRequest: 0,
  layerFrames: {},
  fontSizes: {},
  resizeMode:
    typeof localStorage === 'undefined' ||
    localStorage.getItem('traduzai_khr.resize_mode.v2') !== 'box'
      ? 'scale'
      : 'box',
  defaultFontSize: readDefaultFontSize(),
  ocrRegionAngle: readOcrRegionAngle(),
  selectedLayers: [],
  selectedPages: [],
  tool: 'select',
  snapToCenter:
    typeof localStorage === 'undefined' ||
    localStorage.getItem('traduzai_khr.snap_to_center') !== 'false',
  brush: { diameter: 48, hardness: 100, color: '#FFFFFF' },
  inspector: 'copy',
  processingScope: 'selected-pages',
  processingStages: [...pipelineStages],
  settingsOpen: false,
  shortcuts: defaultShortcuts,
  selectPages: (selectedPages) => set({ selectedPages: [...new Set(selectedPages)] }),
  showInspector: (inspector) => set({ inspector }),
  setProcessingScope: (processingScope) => set({ processingScope }),
  setProcessingStages: (processingStages) => set({ processingStages }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  selectLayers: (selectedLayers) => set({ selectedLayers: [...new Set(selectedLayers)] }),
  setTool: (tool) => set({ tool }),
  setSnapToCenter: (snapToCenter) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('traduzai_khr.snap_to_center', String(snapToCenter))
    }
    set({ snapToCenter })
  },
  setBrush: (brush) => set({ brush }),
  setResizeMode: (resizeMode) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('traduzai_khr.resize_mode.v2', resizeMode)
    }
    set({ resizeMode })
  },
  setDefaultFontSize: (defaultFontSize) => {
    if (typeof localStorage !== 'undefined') {
      if (defaultFontSize === null) localStorage.removeItem('traduzai_khr.default_font_size')
      else localStorage.setItem('traduzai_khr.default_font_size', String(defaultFontSize))
    }
    set({ defaultFontSize })
  },
  setOcrRegionAngle: (ocrRegionAngle) => {
    if (!Number.isFinite(ocrRegionAngle) || Math.abs(ocrRegionAngle) > 180) return
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('traduzai_khr.ocr_region_angle', String(ocrRegionAngle))
    }
    set({ ocrRegionAngle })
  },
  setShortcut: (action, key) =>
    set((state) => ({
      shortcuts: {
        ...state.shortcuts,
        [action]: key.toLowerCase().slice(0, 1),
      },
    })),
  requestCanvasFit: () => set((state) => ({ fitCanvasRequest: state.fitCanvasRequest + 1 })),
  dismissJob: (id) =>
    set((state) => {
      const jobs = { ...state.jobs }
      delete jobs[id]
      return { jobs }
    }),
  dismissDownload: (id) =>
    set((state) => {
      const downloads = { ...state.downloads }
      delete downloads[String(id)]
      return { downloads }
    }),
}))

export function receiveStartupState(state: StartupState): void {
  useKoharuStore.setState({
    initialized: true,
    preferences: state.preferences,
    jobs: byId(state.jobs),
    ...canvasSnapshot(state.canvas),
  })
}

export function receiveCanvas(canvas: CanvasState): void {
  useKoharuStore.setState(canvasSnapshot(canvas))
}

export function receiveJob(job: Job): void {
  useKoharuStore.setState((state) => ({
    jobs: { ...state.jobs, [job.id]: job },
  }))
}

export function receiveDownload(download: Download): void {
  useKoharuStore.setState((state) => {
    const downloads = { ...state.downloads }
    if (download.state === 'finished') delete downloads[String(download.id)]
    else downloads[String(download.id)] = download
    return { downloads }
  })
}

export function receivePreferences(preferences: Preferences): void {
  useKoharuStore.setState({ preferences })
}

export function receiveTranslationModels(translationModels: Model[]): void {
  useKoharuStore.setState({ translationModels })
}

export function receiveResources(resources: ModelResources): void {
  useKoharuStore.setState({ resources })
}

export function receiveError(message: string): void {
  toast.add({
    type: 'error',
    title: 'Could not complete that action',
    description: message,
  })
}

function canvasSnapshot(canvas: CanvasState) {
  return {
    canvasPage: canvas.page,
    canvasRevision: canvas.revision,
    canvasGeneration: canvas.generation,
    canvasSize: canvas.size,
    layerFrames: Object.fromEntries(
      canvas.element_frames.map(({ element, frame }) => [element, frame]),
    ),
    fontSizes: Object.fromEntries(canvas.element_font_sizes),
  }
}

function byId<T extends { id: string | number }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [String(item.id), item]))
}

function readDefaultFontSize(): number | null {
  if (typeof localStorage === 'undefined') return null
  const value = Number(localStorage.getItem('traduzai_khr.default_font_size'))
  return value >= 0.5 && value <= 300 ? value : null
}

function readOcrRegionAngle(): number {
  if (typeof localStorage === 'undefined') return 0
  const value = Number(localStorage.getItem('traduzai_khr.ocr_region_angle'))
  return Number.isFinite(value) && Math.abs(value) <= 180 ? value : 0
}
