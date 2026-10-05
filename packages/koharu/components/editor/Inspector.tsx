'use client'

import type { TFunction } from 'i18next'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Brush,
  ChevronDown,
  Eye,
  EyeOff,
  Folder,
  GripVertical,
  Image as ImageIcon,
  Layers3,
  Lock,
  RotateCcw,
  Trash2,
  Type,
} from 'lucide-react'
import { type DragEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ColorWell } from '@/components/controls/ColorWell'
import { CommitTextarea } from '@/components/controls/CommitTextarea'
import { FontPicker } from '@/components/controls/FontPicker'
import { ScrubNumber } from '@/components/controls/ScrubNumber'
import { call } from '@/lib/backend'
import {
  expandLayerSelection,
  isGroupLayer,
  isLockedLayer,
  isTextLayer,
  layerChildren,
} from '@/lib/document'
import { controlFrame } from '@/lib/geometry'
import {
  pageKey,
  projectKey,
  queryClient,
  refresh,
  useFonts,
  usePage,
  useProject,
} from '@/lib/queries'
import { receiveError, useKoharuStore } from '@/lib/store'
import {
  applySelectedFrameGroups,
  applySelectedTypographyGroups,
  applyTextStyle,
  readCopiedTextAttributes,
  readTextPresets,
  removeTextPreset,
  saveTextPreset,
  storeCopiedTextAttributes,
  type TextAttributeGroup,
} from '@/lib/text-presets'
import { defaultTypography } from '@/lib/typography'
import { previewCanvasOpacity } from '@koharu/bridge/canvas'
import {
  commands,
  type EntityId,
  type FontFamily,
  type FontStyle,
  type Layer,
  type TextAlignment,
  type Typography,
  type WritingMode,
} from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@koharu/ui/components/dropdown-menu'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@koharu/ui/components/resizable'
import { ScrollArea } from '@koharu/ui/components/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@koharu/ui/components/select'
import { Slider } from '@koharu/ui/components/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@koharu/ui/components/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@koharu/ui/components/tooltip'

const defaultFont: FontFamily = {
  name: 'CCWildWords',
  metadata: {
    primary_script: 'latn',
    scripts: ['latn'],
    languages: ['en'],
    category: 'HANDWRITING',
    classifications: ['comic', 'dialogue'],
    use_cases: ['comic-dialogue', 'word-balloons'],
  },
  sources: ['bundled'],
  faces: [
    {
      postscript_name: 'CCWildWords-Regular',
      weight: 400,
      weight_range: null,
      style: 'normal',
    },
  ],
}

const attributeGroupOptions: Array<{ value: TextAttributeGroup; label: string }> = [
  { value: 'font-size', label: 'Fonte e tamanho' },
  { value: 'fill', label: 'Cor do texto' },
  { value: 'outline', label: 'Contorno' },
  { value: 'effects', label: 'Sombra, brilho e gradiente' },
  { value: 'alignment-direction', label: 'Alinhamento e direção' },
  { value: 'shear-placement', label: 'Inclinação e posição' },
  { value: 'transform', label: 'Quadro: posição, tamanho e rotação' },
]

export function Inspector() {
  const { t } = useTranslation()
  return (
    <aside className='flex h-full min-h-0 flex-col bg-[var(--surface-panel)]'>
      <div className='flex h-8 shrink-0 items-center gap-1.5 border-b border-border/80 px-2'>
        <Type className='size-3 text-primary' />
        <h2 className='text-[10px] font-semibold'>{t('inspector.type')}</h2>
      </div>

      <ResizablePanelGroup
        orientation='vertical'
        defaultLayout={{ properties: 57, layers: 43 }}
        className='min-h-0 flex-1'
      >
        <ResizablePanel id='properties' defaultSize='57%' minSize='30%' className='min-h-0'>
          <TypeInspector />
        </ResizablePanel>
        <ResizableHandle
          withHandle
          aria-label='Redimensionar tipografia e camadas'
          className='z-10 h-1 bg-border/40 transition-colors hover:bg-primary/70 focus-visible:bg-primary'
        />
        <ResizablePanel id='layers' defaultSize='43%' minSize='18%' className='min-h-0'>
          <LayersInspector />
        </ResizablePanel>
      </ResizablePanelGroup>
    </aside>
  )
}

function TypeInspector() {
  const { t } = useTranslation()
  const page = usePage().data
  const project = useProject().data
  const selectedIds = useKoharuStore((state) => state.selectedLayers)
  const selectLayers = useKoharuStore((state) => state.selectLayers)
  const setTool = useKoharuStore((state) => state.setTool)
  const resizeMode = useKoharuStore((state) => state.resizeMode)
  const setResizeMode = useKoharuStore((state) => state.setResizeMode)
  const defaultFontSize = useKoharuStore((state) => state.defaultFontSize)
  const setDefaultFontSize = useKoharuStore((state) => state.setDefaultFontSize)
  const availableFonts = useFonts().data
  const expandedSelection = page ? expandLayerSelection(page.layers, selectedIds) : []
  const selected =
    page?.layers.filter(isTextLayer).filter((layer) => expandedSelection.includes(layer.id)) ?? []
  const current = selected[0]
  const layerFrames = useKoharuStore((state) => state.layerFrames)
  const currentFrame = current ? controlFrame(current, layerFrames) : null
  const [draft, setDraft] = useState<{
    layer: EntityId
    typography: Typography
  } | null>(null)
  const [presetName, setPresetName] = useState('')
  const [selectedPreset, setSelectedPreset] = useState('')
  const [activeTab, setActiveTab] = useState<'typography' | 'effects' | 'presets'>('typography')
  const [pasteDialogOpen, setPasteDialogOpen] = useState(false)
  const [presets, setPresets] = useState(() => readTextPresets())
  const [hasCopiedAttributes, setHasCopiedAttributes] = useState(false)
  const [pasteGroups, setPasteGroups] = useState<Set<TextAttributeGroup>>(
    () => new Set(attributeGroupOptions.map(({ value }) => value)),
  )
  const [rasterizing, setRasterizing] = useState(false)
  const disabledEffectCache = useRef(
    new Map<
      string,
      {
        shadow?: NonNullable<Typography['shadow']>
        glow?: NonNullable<Typography['glow']>
        gradient?: NonNullable<Typography['gradient']>
        strokeAlpha?: number
      }
    >(),
  )
  const updateSequence = useRef(0)

  useEffect(() => setDraft(null), [current?.id])
  useEffect(() => setHasCopiedAttributes(Boolean(readCopiedTextAttributes())), [])

  const apply = (update: (value: Typography, layer: Layer) => Typography) => {
    if (!selected.length) return
    const updates = selected.map((layer) => ({
      layer: layer.id,
      typography: update(
        draft?.layer === layer.id ? draft.typography : (layer.typography ?? defaultTypography),
        layer,
      ),
    }))
    queryClient.setQueryData(pageKey, (cached: typeof page) =>
      cached
        ? {
            ...cached,
            layers: cached.layers.map((layer) => {
              const next = updates.find((update) => update.layer === layer.id)
              return next && layer.type === 'text'
                ? { ...layer, typography: next.typography }
                : layer
            }),
          }
        : cached,
    )
    const optimistic = current && updates.find(({ layer }) => layer === current.id)
    if (optimistic) setDraft(optimistic)
    const sequence = ++updateSequence.current
    void call(commands.setTypography, updates)
      .then(() => refresh(projectKey, pageKey))
      .catch(() => undefined)
      .finally(() => {
        if (updateSequence.current === sequence) setDraft(null)
      })
  }

  const toggleShadow = () =>
    apply((value, layer) => {
      const key = `${layer.id}:shadow`
      if (value.shadow) {
        disabledEffectCache.current.set(key, { shadow: structuredClone(value.shadow) })
        return { ...value, shadow: null }
      }
      return {
        ...value,
        shadow: disabledEffectCache.current.get(key)?.shadow ?? {
          color: [0, 0, 0, 160],
          offset_x: 2,
          offset_y: 2,
          blur_radius: 4,
        },
      }
    })
  const toggleGlow = () =>
    apply((value, layer) => {
      const key = `${layer.id}:glow`
      if (value.glow) {
        disabledEffectCache.current.set(key, { glow: structuredClone(value.glow) })
        return { ...value, glow: null }
      }
      return {
        ...value,
        glow: disabledEffectCache.current.get(key)?.glow ?? {
          color: [255, 255, 255, 180],
          radius: 6,
        },
      }
    })
  const toggleGradient = () =>
    apply((value, layer) => {
      const key = `${layer.id}:gradient`
      if (value.gradient) {
        disabledEffectCache.current.set(key, { gradient: structuredClone(value.gradient) })
        return { ...value, gradient: null }
      }
      return {
        ...value,
        gradient: disabledEffectCache.current.get(key)?.gradient ?? {
          start_color: [0, 0, 0, 255],
          end_color: [120, 120, 120, 255],
          angle_degrees: 90,
        },
      }
    })
  const toggleStroke = () =>
    apply((value, layer) => {
      const color = value.stroke_color ?? defaultTypography.stroke_color!
      const key = `${layer.id}:stroke`
      if ((value.stroke_width ?? 0) > 0 && color[3] > 0) {
        disabledEffectCache.current.set(key, { strokeAlpha: color[3] })
        return { ...value, stroke_color: [color[0], color[1], color[2], 0] }
      }
      return {
        ...value,
        stroke_width: value.stroke_width && value.stroke_width > 0 ? value.stroke_width : 1.5,
        stroke_color: [
          color[0],
          color[1],
          color[2],
          disabledEffectCache.current.get(key)?.strokeAlpha ?? 255,
        ],
      }
    })

  const rasterizeText = () => {
    if (!current || !project || rasterizing) return
    setRasterizing(true)
    void call(commands.rasterizeText, project.revision, current.id)
      .then(async ({ layer }) => {
        await refresh(projectKey, pageKey)
        selectLayers([layer])
        setTool('eraser')
      })
      .catch((error: unknown) =>
        receiveError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setRasterizing(false))
  }

  const typography =
    current && draft?.layer === current.id
      ? draft.typography
      : (current?.typography ?? defaultTypography)
  const disabled = !current
  const families = useMemo(() => {
    const available = availableFonts ?? []
    return available.some(
      (family) => normalizeFontName(family.name) === normalizeFontName(defaultFont.name),
    )
      ? available
      : [...available, defaultFont]
  }, [availableFonts])
  const size = Math.round((typography.size ?? 24) * 100) / 100
  const weight = typography.font_weight ?? 400
  const selectedFamily = findFontFamily(families, typography.preferred_font ?? defaultFont.name)
  const styles = usableFontStyles(selectedFamily)
  const style = styles.includes(typography.font_style ?? 'normal')
    ? (typography.font_style ?? 'normal')
    : (styles[0] ?? 'normal')
  const weights = usableFontWeights(selectedFamily, style)
  const strokeWidth = typography.stroke_width ?? 0
  const strokeColor = typography.stroke_color ?? defaultTypography.stroke_color!
  const strokeEnabled = strokeWidth > 0 && strokeColor[3] > 0
  const displayedStrokeWidth = strokeWidth > 0 ? strokeWidth : 1.5
  const writingMode = typography.writing_mode ?? 'Horizontal'
  const writingModeChoice = typography.writing_mode ?? 'Auto'
  const effectiveAlignment =
    typography.alignment ?? (writingMode === 'Vertical' ? 'Start' : 'Center')

  return (
    <div className='h-full min-h-0' data-testid='type-inspector' aria-disabled={disabled}>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as typeof activeTab)}
        className='flex h-full min-h-0 flex-col gap-0'
      >
        <TabsContent value='typography' className='min-h-0 flex-1 overflow-y-auto px-2 py-2'>
          <div className='grid min-w-0 gap-1.5'>
            <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_2.5rem] gap-1.5'>
              <InspectorField label={t('inspector.font')}>
                <FontPicker
                  value={typography.preferred_font ?? defaultFont.name}
                  families={families}
                  disabled={disabled}
                  size='sm'
                  onChange={(preferred_font) => {
                    const family = findFontFamily(families, preferred_font)
                    const nextStyles = usableFontStyles(family)
                    const fontStyle = nextStyles.includes(style)
                      ? style
                      : (nextStyles[0] ?? 'normal')
                    const nextWeights = usableFontWeights(family, fontStyle)
                    const fontWeight = nearestFontWeight(nextWeights, weight)
                    apply((value) => ({
                      ...value,
                      preferred_font,
                      font_weight: fontWeight,
                      font_style: fontStyle,
                    }))
                  }}
                />
              </InspectorField>
              <InspectorField label={t('inspector.color')}>
                <ColorWell
                  label={t('inspector.textColor')}
                  size='sm'
                  disabled={disabled}
                  value={rgbaToHex(typography.color ?? defaultTypography.color!)}
                  onChange={(color) => apply((value) => ({ ...value, color: hexToRgba(color) }))}
                />
              </InspectorField>
            </div>

            <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_4.25rem_4.75rem] gap-1.5'>
              <InspectorField label={t('inspector.size')}>
                <FontSizeField
                  disabled={disabled}
                  value={size}
                  autoFit={typography.auto_fit}
                  onChange={(next) => apply((value) => ({ ...value, size: next, auto_fit: false }))}
                  onAutoFit={() =>
                    apply((value) => ({
                      ...value,
                      size: value.size ?? size,
                      auto_fit: true,
                    }))
                  }
                />
              </InspectorField>
              <InspectorField label={t('inspector.weight')}>
                <Select
                  disabled={disabled}
                  value={String(weight)}
                  onValueChange={(font_weight) =>
                    apply((value) => ({
                      ...value,
                      font_weight: Number(font_weight),
                    }))
                  }
                >
                  <SelectTrigger
                    size='sm'
                    aria-label={t('inspector.fontWeight')}
                    className='w-full min-w-0'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {weights.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InspectorField>
              <InspectorField label={t('inspector.style')}>
                <Select
                  disabled={disabled}
                  value={style}
                  onValueChange={(font_style) => {
                    const nextStyle = font_style as FontStyle
                    const nextWeights = usableFontWeights(selectedFamily, nextStyle)
                    apply((value) => ({
                      ...value,
                      font_style: nextStyle,
                      font_weight: nearestFontWeight(nextWeights, weight),
                    }))
                  }}
                >
                  <SelectTrigger
                    size='sm'
                    aria-label={t('inspector.fontStyle')}
                    className='w-full min-w-0'
                  >
                    <SelectValue>{t(`inspector.fontStyles.${style}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align='end'>
                    {styles.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`inspector.fontStyles.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InspectorField>
            </div>

            <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(6.5rem,1fr)] gap-1.5'>
              <InspectorField label={t('inspector.alignment')}>
                <div className='grid h-6 grid-cols-3 rounded-md border border-input bg-background p-px'>
                  {(
                    [
                      [
                        'Start',
                        AlignLeft,
                        writingMode === 'Vertical'
                          ? t('inspector.alignTop')
                          : t('inspector.alignLeft'),
                      ],
                      [
                        'Center',
                        AlignCenter,
                        writingMode === 'Vertical'
                          ? t('inspector.alignMiddle')
                          : t('inspector.alignCenter'),
                      ],
                      [
                        'End',
                        AlignRight,
                        writingMode === 'Vertical'
                          ? t('inspector.alignBottom')
                          : t('inspector.alignRight'),
                      ],
                    ] as const
                  ).map(([alignment, Icon, label]) => (
                    <button
                      key={alignment}
                      type='button'
                      aria-label={label}
                      aria-pressed={effectiveAlignment === alignment}
                      disabled={disabled}
                      data-active={effectiveAlignment === alignment}
                      className='grid place-items-center rounded-[4px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:hover:bg-primary/90'
                      onClick={() =>
                        apply((value) => ({
                          ...value,
                          alignment: alignment as TextAlignment,
                        }))
                      }
                    >
                      <Icon className='size-3' />
                    </button>
                  ))}
                </div>
              </InspectorField>
              <InspectorField label={t('inspector.direction')}>
                <Select
                  disabled={disabled}
                  value={writingModeChoice}
                  onValueChange={(writing_mode) =>
                    apply((value) => ({
                      ...value,
                      writing_mode: writing_mode === 'Auto' ? null : (writing_mode as WritingMode),
                    }))
                  }
                >
                  <SelectTrigger
                    size='sm'
                    aria-label={t('inspector.textDirection')}
                    className='w-full'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='Auto'>{t('inspector.auto')}</SelectItem>
                    <SelectItem value='Horizontal'>{t('inspector.horizontal')}</SelectItem>
                    <SelectItem value='Vertical'>{t('inspector.vertical')}</SelectItem>
                  </SelectContent>
                </Select>
              </InspectorField>
            </div>

            <button
              type='button'
              aria-label='Rasterizar texto selecionado'
              title='Cria uma camada de imagem editável e oculta o texto original'
              disabled={disabled || !project || rasterizing || draft !== null}
              className='rounded-lg border border-border/70 bg-background/40 px-2.5 py-1.5 text-left text-[10px] font-semibold transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-50'
              onClick={rasterizeText}
            >
              {rasterizing ? 'Rasterizando texto…' : 'Rasterizar texto para apagar com a borracha'}
            </button>

            <InspectorField label='Posição automática'>
              <select
                aria-label='Posição automática do texto'
                className='h-7 w-full rounded-md border border-input bg-background px-2 text-[10px]'
                disabled={disabled}
                value={typography.placement ?? 'balloon'}
                onChange={(event) =>
                  apply((value) => ({
                    ...value,
                    placement: event.target.value as Typography['placement'],
                  }))
                }
              >
                <option value='balloon'>Centro do balão</option>
                <option value='original_text'>Centro do texto original</option>
                <option value='manual'>Posição manual</option>
              </select>
            </InspectorField>

            <InspectorField label='Redimensionar com os puxadores'>
              <div className='grid grid-cols-2 gap-1 rounded-lg border border-border/70 bg-background/35 p-1'>
                <button
                  type='button'
                  aria-label='Redimensionar caixa e fonte proporcionalmente'
                  aria-pressed={resizeMode === 'scale'}
                  className='rounded-md px-2 py-1.5 text-[9px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground'
                  onClick={() => setResizeMode('scale')}
                >
                  Caixa + fonte
                </button>
                <button
                  type='button'
                  aria-label='Redimensionar somente a caixa de texto'
                  aria-pressed={resizeMode === 'box'}
                  className='rounded-md px-2 py-1.5 text-[9px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground'
                  onClick={() => setResizeMode('box')}
                >
                  Só a caixa
                </button>
              </div>
              <span className='text-[9px] leading-3 text-muted-foreground'>
                O padrão acompanha caixa e fonte ao arrastar, sem encaixe automático.
              </span>
            </InspectorField>

            <InspectorField label='Tamanho fixo para novos textos'>
              <input
                type='number'
                aria-label='Tamanho padrão da fonte'
                className='h-7 w-full rounded-md border border-input bg-background px-2 text-[10px]'
                min={0.5}
                max={300}
                step={0.5}
                placeholder='Automático'
                value={defaultFontSize ?? ''}
                onChange={(event) => {
                  if (!event.target.value) return setDefaultFontSize(null)
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 0.5 && value <= 300) {
                    setDefaultFontSize(value)
                  }
                }}
              />
            </InspectorField>
          </div>
        </TabsContent>

        <TabsContent value='effects' className='min-h-0 flex-1 overflow-y-auto px-2 py-2'>
          <div className='grid min-w-0 gap-2'>
            <div className='rounded-xl border border-border/70 bg-background/30 p-2'>
              <div className='flex items-center gap-2'>
                <button
                  type='button'
                  aria-label={strokeEnabled ? 'Desativar contorno' : 'Ativar contorno'}
                  aria-pressed={strokeEnabled}
                  disabled={disabled}
                  className='flex min-w-0 flex-1 items-center gap-2 text-left text-[10px] font-semibold disabled:opacity-50 aria-pressed:text-primary'
                  onClick={toggleStroke}
                >
                  <span className='grid size-4 place-items-center rounded border border-current text-[9px]'>
                    {strokeEnabled ? '✓' : ''}
                  </span>
                  Contorno
                  <span className='ml-auto text-[9px] font-normal text-muted-foreground'>
                    {strokeEnabled ? 'Ativo' : 'Desativado'}
                  </span>
                </button>
                <ColorWell
                  label={t('inspector.borderColor')}
                  size='sm'
                  disabled={disabled}
                  value={rgbaToHex(strokeColor)}
                  onChange={(stroke_color) =>
                    stroke_color &&
                    apply((value) => ({
                      ...value,
                      stroke_color: rgbaWithAlpha(
                        hexToRgba(stroke_color),
                        value.stroke_color?.[3] ?? 255,
                      ),
                      stroke_width: (value.stroke_width ?? 0) > 0 ? value.stroke_width : 1.5,
                    }))
                  }
                />
              </div>
              <div className='mt-2 grid grid-cols-[1fr_1fr] items-end gap-2'>
                <EffectNumber
                  label='Largura do contorno'
                  value={displayedStrokeWidth}
                  min={0.5}
                  max={32}
                  step={0.5}
                  disabled={disabled}
                  onChange={(stroke_width) => apply((value) => ({ ...value, stroke_width }))}
                />
                <div className='grid min-w-0 gap-0.5'>
                  <label className='text-[9px] font-medium text-muted-foreground'>Opacidade</label>
                  <div className='flex items-center gap-1.5'>
                    <Slider
                      aria-label='Opacidade do contorno'
                      min={0}
                      max={255}
                      step={1}
                      value={strokeColor[3]}
                      disabled={disabled}
                      className='min-w-0 flex-1'
                      onValueChange={(alpha) =>
                        apply((value) => ({
                          ...value,
                          stroke_color: rgbaWithAlpha(
                            value.stroke_color ?? defaultTypography.stroke_color!,
                            Math.round(alpha),
                          ),
                        }))
                      }
                    />
                    <span className='w-8 text-right text-[9px] text-muted-foreground tabular-nums'>
                      {Math.round((strokeColor[3] / 255) * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <details className='rounded-xl border border-border/70 bg-background/20 p-2' open>
              <summary className='cursor-pointer text-[10px] font-semibold'>
                Camadas de efeito
              </summary>
              <div className='mt-2 grid gap-2 text-[10px]'>
                <button
                  type='button'
                  aria-label={typography.shadow ? 'Desativar sombra' : 'Ativar sombra'}
                  aria-pressed={Boolean(typography.shadow)}
                  disabled={disabled}
                  className='flex items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2 py-1.5 text-left font-semibold transition-colors hover:border-primary/40 disabled:opacity-50 aria-pressed:border-primary/50 aria-pressed:bg-primary/10'
                  onClick={toggleShadow}
                >
                  <span className='grid size-4 place-items-center rounded border border-current text-[9px]'>
                    {typography.shadow ? '✓' : ''}
                  </span>
                  Sombra
                  <span className='ml-auto text-[9px] font-normal text-muted-foreground'>
                    {typography.shadow ? 'Ativa' : 'Desativada'}
                  </span>
                </button>
                {typography.shadow && (
                  <div className='grid grid-cols-2 gap-2 rounded-lg border border-border/50 p-2'>
                    <EffectNumber
                      label='Sombra X'
                      value={typography.shadow.offset_x}
                      min={-128}
                      max={128}
                      disabled={disabled}
                      onChange={(offset_x) =>
                        apply((value) => ({
                          ...value,
                          shadow: value.shadow && { ...value.shadow, offset_x },
                        }))
                      }
                    />
                    <EffectNumber
                      label='Sombra Y'
                      value={typography.shadow.offset_y}
                      min={-128}
                      max={128}
                      disabled={disabled}
                      onChange={(offset_y) =>
                        apply((value) => ({
                          ...value,
                          shadow: value.shadow && { ...value.shadow, offset_y },
                        }))
                      }
                    />
                    <EffectNumber
                      label='Suavidade da sombra'
                      value={typography.shadow.blur_radius}
                      min={0}
                      max={128}
                      disabled={disabled}
                      onChange={(blur_radius) =>
                        apply((value) => ({
                          ...value,
                          shadow: value.shadow && { ...value.shadow, blur_radius },
                        }))
                      }
                    />
                    <ColorWell
                      label='Cor da sombra'
                      size='sm'
                      disabled={disabled}
                      value={rgbaToHex(typography.shadow.color)}
                      onChange={(color) =>
                        color &&
                        apply((value) => ({
                          ...value,
                          shadow: value.shadow && {
                            ...value.shadow,
                            color: rgbaWithAlpha(hexToRgba(color), value.shadow.color[3]),
                          },
                        }))
                      }
                    />
                    <OpacityControl
                      label='Opacidade da sombra'
                      value={typography.shadow.color[3]}
                      disabled={disabled}
                      onChange={(alpha) =>
                        apply((value) => ({
                          ...value,
                          shadow: value.shadow && {
                            ...value.shadow,
                            color: rgbaWithAlpha(value.shadow.color, alpha),
                          },
                        }))
                      }
                    />
                  </div>
                )}
                <button
                  type='button'
                  aria-label={typography.glow ? 'Desativar brilho' : 'Ativar brilho'}
                  aria-pressed={Boolean(typography.glow)}
                  disabled={disabled}
                  className='flex items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2 py-1.5 text-left font-semibold transition-colors hover:border-primary/40 disabled:opacity-50 aria-pressed:border-primary/50 aria-pressed:bg-primary/10'
                  onClick={toggleGlow}
                >
                  <span className='grid size-4 place-items-center rounded border border-current text-[9px]'>
                    {typography.glow ? '✓' : ''}
                  </span>
                  Brilho
                  <span className='ml-auto text-[9px] font-normal text-muted-foreground'>
                    {typography.glow ? 'Ativo' : 'Desativado'}
                  </span>
                </button>
                {typography.glow && (
                  <div className='grid grid-cols-2 gap-2 rounded-lg border border-border/50 p-2'>
                    <EffectNumber
                      label='Raio do brilho'
                      value={typography.glow.radius}
                      min={0}
                      max={128}
                      disabled={disabled}
                      onChange={(radius) =>
                        apply((value) => ({
                          ...value,
                          glow: value.glow && { ...value.glow, radius },
                        }))
                      }
                    />
                    <ColorWell
                      label='Cor do brilho'
                      size='sm'
                      disabled={disabled}
                      value={rgbaToHex(typography.glow.color)}
                      onChange={(color) =>
                        color &&
                        apply((value) => ({
                          ...value,
                          glow: value.glow && {
                            ...value.glow,
                            color: rgbaWithAlpha(hexToRgba(color), value.glow.color[3]),
                          },
                        }))
                      }
                    />
                    <OpacityControl
                      label='Opacidade do brilho'
                      value={typography.glow.color[3]}
                      disabled={disabled}
                      onChange={(alpha) =>
                        apply((value) => ({
                          ...value,
                          glow: value.glow && {
                            ...value.glow,
                            color: rgbaWithAlpha(value.glow.color, alpha),
                          },
                        }))
                      }
                    />
                  </div>
                )}
                <button
                  type='button'
                  aria-label={typography.gradient ? 'Desativar gradiente' : 'Ativar gradiente'}
                  aria-pressed={Boolean(typography.gradient)}
                  disabled={disabled}
                  className='flex items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2 py-1.5 text-left font-semibold transition-colors hover:border-primary/40 disabled:opacity-50 aria-pressed:border-primary/50 aria-pressed:bg-primary/10'
                  onClick={toggleGradient}
                >
                  <span className='grid size-4 place-items-center rounded border border-current text-[9px]'>
                    {typography.gradient ? '✓' : ''}
                  </span>
                  Gradiente
                  <span className='ml-auto text-[9px] font-normal text-muted-foreground'>
                    {typography.gradient ? 'Ativo' : 'Desativado'}
                  </span>
                </button>
                {typography.gradient && (
                  <div className='grid gap-2 rounded-lg border border-border/50 p-2'>
                    <div className='flex items-end gap-2'>
                      <ColorWell
                        label='Cor inicial'
                        size='sm'
                        disabled={disabled}
                        value={rgbaToHex(typography.gradient.start_color)}
                        onChange={(color) =>
                          color &&
                          apply((value) => ({
                            ...value,
                            gradient: value.gradient && {
                              ...value.gradient,
                              start_color: rgbaWithAlpha(
                                hexToRgba(color),
                                value.gradient.start_color[3],
                              ),
                            },
                          }))
                        }
                      />
                      <ColorWell
                        label='Cor final'
                        size='sm'
                        disabled={disabled}
                        value={rgbaToHex(typography.gradient.end_color)}
                        onChange={(color) =>
                          color &&
                          apply((value) => ({
                            ...value,
                            gradient: value.gradient && {
                              ...value.gradient,
                              end_color: rgbaWithAlpha(
                                hexToRgba(color),
                                value.gradient.end_color[3],
                              ),
                            },
                          }))
                        }
                      />
                      <EffectNumber
                        label='Ângulo do gradiente'
                        value={typography.gradient.angle_degrees}
                        min={-360}
                        max={360}
                        disabled={disabled}
                        onChange={(angle_degrees) =>
                          apply((value) => ({
                            ...value,
                            gradient: value.gradient && {
                              ...value.gradient,
                              angle_degrees,
                            },
                          }))
                        }
                      />
                    </div>
                    <div className='grid grid-cols-2 gap-2'>
                      <OpacityControl
                        label='Opacidade da cor inicial'
                        value={typography.gradient.start_color[3]}
                        disabled={disabled}
                        onChange={(alpha) =>
                          apply((value) => ({
                            ...value,
                            gradient: value.gradient && {
                              ...value.gradient,
                              start_color: rgbaWithAlpha(value.gradient.start_color, alpha),
                            },
                          }))
                        }
                      />
                      <OpacityControl
                        label='Opacidade da cor final'
                        value={typography.gradient.end_color[3]}
                        disabled={disabled}
                        onChange={(alpha) =>
                          apply((value) => ({
                            ...value,
                            gradient: value.gradient && {
                              ...value.gradient,
                              end_color: rgbaWithAlpha(value.gradient.end_color, alpha),
                            },
                          }))
                        }
                      />
                    </div>
                  </div>
                )}
                <EffectNumber
                  label='Inclinação horizontal'
                  value={typography.shear_x ?? 0}
                  min={-4}
                  max={4}
                  step={0.01}
                  disabled={disabled}
                  onChange={(shear_x) => apply((value) => ({ ...value, shear_x }))}
                />
                <EffectNumber
                  label='Inclinação vertical'
                  value={typography.shear_y ?? 0}
                  min={-4}
                  max={4}
                  step={0.01}
                  disabled={disabled}
                  onChange={(shear_y) => apply((value) => ({ ...value, shear_y }))}
                />
              </div>
            </details>
          </div>
        </TabsContent>

        <TabsContent value='presets' className='min-h-0 flex-1 overflow-y-auto px-2 py-2'>
          <div className='grid min-w-0 gap-2'>
            <details className='rounded-lg border border-border/70 bg-background/25 p-2' open>
              <summary className='cursor-pointer text-[10px] font-semibold'>
                Presets e atributos
              </summary>
              <div className='mt-1 grid gap-1 text-[10px]'>
                <div className='flex gap-1'>
                  <button
                    type='button'
                    disabled={disabled || !currentFrame}
                    title='Copia tipografia, inclinação, posição, tamanho e rotação sem copiar o texto.'
                    onClick={() => {
                      if (!current || !currentFrame) return
                      storeCopiedTextAttributes(typography, currentFrame)
                      setHasCopiedAttributes(true)
                      setPasteGroups(new Set(attributeGroupOptions.map(({ value }) => value)))
                    }}
                  >
                    Copiar atributos
                  </button>
                  <button
                    type='button'
                    disabled={disabled || selected.length !== 1 || !hasCopiedAttributes}
                    title='Escolha quais atributos serão aplicados ao texto selecionado.'
                    aria-expanded={pasteDialogOpen}
                    onClick={() => setPasteDialogOpen((open) => !open)}
                  >
                    {pasteDialogOpen ? 'Fechar opções' : 'Colar atributos…'}
                  </button>
                </div>
                {pasteDialogOpen && (
                  <div className='grid gap-2 rounded-lg border border-border/70 bg-background/45 p-2'>
                    <div className='flex items-center gap-2'>
                      <span className='flex-1 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase'>
                        Atributos a colar
                      </span>
                      <button
                        type='button'
                        className='text-[9px] text-primary hover:underline'
                        onClick={() =>
                          setPasteGroups(new Set(attributeGroupOptions.map(({ value }) => value)))
                        }
                      >
                        Todos
                      </button>
                      <button
                        type='button'
                        className='text-[9px] text-muted-foreground hover:text-foreground'
                        onClick={() => setPasteGroups(new Set())}
                      >
                        Limpar
                      </button>
                    </div>
                    <div className='grid grid-cols-2 gap-x-2 gap-y-1'>
                      {attributeGroupOptions.map(({ value, label }) => (
                        <label key={value} className='flex items-center gap-1.5 text-[9px]'>
                          <input
                            type='checkbox'
                            checked={pasteGroups.has(value)}
                            onChange={(event) =>
                              setPasteGroups((previous) => {
                                const next = new Set(previous)
                                if (event.target.checked) next.add(value)
                                else next.delete(value)
                                return next
                              })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <button
                      type='button'
                      disabled={
                        pasteGroups.size === 0 || (pasteGroups.has('transform') && !currentFrame)
                      }
                      className='rounded-md bg-primary px-2 py-1.5 text-[10px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40'
                      onClick={() => {
                        if (!current) return
                        const copied = readCopiedTextAttributes()
                        if (!copied) return setHasCopiedAttributes(false)
                        if (pasteGroups.has('transform') && !currentFrame) return
                        const typographyGroups = new Set(
                          [...pasteGroups].filter((group) => group !== 'transform'),
                        )
                        const nextTypography = applySelectedTypographyGroups(
                          current.typography ?? defaultTypography,
                          copied.style,
                          typographyGroups,
                        )
                        const nextFrame = applySelectedFrameGroups(
                          currentFrame ?? copied.frame,
                          copied.frame,
                          pasteGroups,
                        )
                        void (async () => {
                          if (typographyGroups.size > 0) {
                            await call(commands.setTypography, [
                              { layer: current.id, typography: nextTypography },
                            ])
                          }
                          if (pasteGroups.has('transform')) {
                            const latestProject = await call(commands.getProject)
                            if (latestProject) {
                              await call(commands.commitTransform, latestProject.revision, page!.id, [
                                { element: current.id, frame: nextFrame },
                              ])
                            }
                          }
                          await refresh(projectKey, pageKey)
                          setPasteDialogOpen(false)
                        })().catch((error: unknown) =>
                          receiveError(error instanceof Error ? error.message : String(error)),
                        )
                      }}
                    >
                      Aplicar selecionados
                    </button>
                  </div>
                )}
                <div className='flex gap-1 rounded-lg border border-border/70 bg-background/30 p-1.5'>
                  <input
                    aria-label='Nome do preset'
                    placeholder='Nome do preset'
                    className='h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-ring'
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                  <button
                    type='button'
                    disabled={disabled || !presetName.trim()}
                    className='rounded-md bg-primary px-2 text-[9px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40'
                    onClick={() => {
                      saveTextPreset(presetName, typography)
                      setSelectedPreset(presetName.trim())
                      setPresets(readTextPresets())
                    }}
                  >
                    Salvar
                  </button>
                </div>
                <div
                  className='grid max-h-36 gap-1 overflow-y-auto pr-0.5'
                  aria-label='Presets de texto'
                >
                  {presets.map((preset) => (
                    <button
                      key={preset.name}
                      type='button'
                      aria-pressed={selectedPreset === preset.name}
                      className='flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/35 px-2 py-1.5 text-left transition-colors hover:border-primary/40 hover:bg-accent aria-pressed:border-primary/60 aria-pressed:bg-primary/10'
                      onClick={() => setSelectedPreset(preset.name)}
                    >
                      <span
                        className='grid size-8 shrink-0 place-items-center rounded-md border border-border/60 bg-background text-[17px] font-bold'
                        style={{
                          color: rgbaToCss(preset.style.color ?? defaultTypography.color!),
                          fontWeight: preset.style.font_weight ?? 400,
                        }}
                      >
                        Aa
                      </span>
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate text-[10px] font-semibold'>
                          {preset.name}
                        </span>
                        <span className='block truncate text-[9px] text-muted-foreground'>
                          {preset.style.preferred_font ?? defaultFont.name} ·{' '}
                          {preset.style.size ? `${preset.style.size}px` : 'Automático'}
                        </span>
                      </span>
                      {selectedPreset === preset.name && (
                        <span className='size-1.5 shrink-0 rounded-full bg-primary' />
                      )}
                    </button>
                  ))}
                  {presets.length === 0 && (
                    <div className='rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-[9px] text-muted-foreground'>
                      Salve um estilo para criar seu primeiro preset.
                    </div>
                  )}
                </div>
                <div className='flex gap-1'>
                  <button
                    type='button'
                    disabled={disabled || !selectedPreset}
                    className='flex-1 rounded-md border border-border/70 bg-background/50 px-2 py-1.5 text-[9px] font-semibold transition-colors hover:bg-accent disabled:opacity-40'
                    onClick={() => {
                      const preset = presets.find((item) => item.name === selectedPreset)
                      if (preset) apply((value) => applyTextStyle(value, preset.style))
                    }}
                  >
                    Aplicar preset
                  </button>
                  <button
                    type='button'
                    disabled={!selectedPreset}
                    className='rounded-md border border-border/70 px-2 py-1.5 text-[9px] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40'
                    onClick={() => {
                      removeTextPreset(selectedPreset)
                      setSelectedPreset('')
                      setPresets(readTextPresets())
                    }}
                  >
                    Excluir preset
                  </button>
                </div>
              </div>
            </details>
          </div>
        </TabsContent>
        <TabsList
          variant='line'
          className='z-20 w-full shrink-0 justify-stretch rounded-none border-t border-border/80 bg-[var(--surface-panel)] px-1.5 py-1'
        >
          <TabsTrigger value='typography' className='text-[10px]'>
            Tipografia
          </TabsTrigger>
          <TabsTrigger value='effects' className='text-[10px]'>
            Efeitos
          </TabsTrigger>
          <TabsTrigger value='presets' className='text-[10px]'>
            Presets
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}

function OpacityControl({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  return (
    <div className='grid min-w-0 gap-1'>
      <div className='flex items-center justify-between gap-2 text-[9px] text-muted-foreground'>
        <span className='truncate'>{label}</span>
        <span className='shrink-0 tabular-nums'>{Math.round((value / 255) * 100)}%</span>
      </div>
      <Slider
        aria-label={label}
        min={0}
        max={255}
        step={1}
        value={value}
        disabled={disabled}
        onValueChange={(alpha) => onChange(Math.round(alpha))}
      />
    </div>
  )
}

function rgbaWithAlpha(
  color: [number, number, number, number],
  alpha: number,
): [number, number, number, number] {
  return [color[0], color[1], color[2], Math.max(0, Math.min(255, Math.round(alpha)))]
}

function EffectNumber({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  return (
    <ScrubNumber
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

function findFontFamily(families: FontFamily[], name: string): FontFamily | undefined {
  return families.find((family) => normalizeFontName(family.name) === normalizeFontName(name))
}

function usableFontStyles(family: FontFamily | undefined): FontStyle[] {
  if (!family) return ['normal']
  const styles = new Set(family.faces.map((font) => font.style))
  const available = (['normal', 'italic', 'oblique'] satisfies FontStyle[]).filter((style) =>
    styles.has(style),
  )
  return available.length ? available : ['normal']
}

function usableFontWeights(family: FontFamily | undefined, style: FontStyle): number[] {
  if (!family) return [400]
  const styled = family.faces.filter((font) => font.style === style)
  const faces = styled.length ? styled : family.faces
  const weights = new Set(faces.map((font) => font.weight))
  for (const face of faces) {
    if (!face.weight_range) continue
    weights.add(face.weight_range.minimum)
    weights.add(face.weight_range.maximum)
    for (let weight = 100; weight <= 900; weight += 100) {
      if (weight >= face.weight_range.minimum && weight <= face.weight_range.maximum) {
        weights.add(weight)
      }
    }
  }
  return [...weights].sort((left, right) => left - right)
}

function nearestFontWeight(weights: number[], target: number): number {
  return weights.reduce((nearest, weight) =>
    Math.abs(weight - target) < Math.abs(nearest - target) ? weight : nearest,
  )
}

function normalizeFontName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function displayedLayers(layers: Layer[], page: EntityId) {
  const indexes = new Map(layers.map((layer, index) => [layer.id, index]))
  const rows: { layer: Layer; index: number; depth: number }[] = []
  const append = (layer: Layer, depth: number) => {
    rows.push({ layer, index: indexes.get(layer.id) ?? 0, depth })
    if (!isGroupLayer(layer)) return
    const children = layerChildren(layers, layer.id)
    const ordered = layer.role === 'text' ? children : [...children].reverse()
    for (const child of ordered) append(child, depth + 1)
  }
  const roots = layers.filter((layer) => (layer.parent ?? page) === page).reverse()
  for (const layer of roots) append(layer, 0)
  return rows
}

function LayersInspector() {
  const { t } = useTranslation()
  const page = usePage().data
  const selected = useKoharuStore((state) => state.selectedLayers)
  const selectLayers = useKoharuStore((state) => state.selectLayers)
  const [expandedLayer, setExpandedLayer] = useState<EntityId | null>(
    selected.length === 1 ? (selected[0] ?? null) : null,
  )
  const [movingLayer, setMovingLayer] = useState<EntityId | null>(null)
  const [draggedLayer, setDraggedLayer] = useState<EntityId | null>(null)
  const [dropTarget, setDropTarget] = useState<EntityId | null>(null)
  const anchor = useRef<EntityId | null>(null)

  useEffect(() => {
    setExpandedLayer(selected.length === 1 ? (selected[0] ?? null) : null)
  }, [selected])

  const layers = useMemo(() => (page ? displayedLayers(page.layers, page.id) : []), [page])

  if (!page) return <EmptyInspector>{t('inspector.selectPage')}</EmptyInspector>

  const move = (layer: Layer, displayDelta: number) => {
    if (movingLayer !== null || isLockedLayer(layer)) return
    const parent = layer.parent ?? page.id
    const storedSiblings = page.layers.filter(
      (candidate) => !isLockedLayer(candidate) && (candidate.parent ?? page.id) === parent,
    )
    const parentLayer = page.layers.find((candidate) => candidate.id === parent)
    const shownSiblings =
      parentLayer && isGroupLayer(parentLayer) && parentLayer.role === 'text'
        ? storedSiblings
        : [...storedSiblings].reverse()
    const shownSource = shownSiblings.findIndex((candidate) => candidate.id === layer.id)
    const shownTarget = shownSource + displayDelta
    const targetLayer = shownSiblings[shownTarget]
    if (shownSource < 0 || !targetLayer) return
    const target = storedSiblings.findIndex((candidate) => candidate.id === targetLayer.id)

    setMovingLayer(layer.id)
    void call(commands.moveLayer, layer.id, parent, target).then(
      (next) => {
        queryClient.setQueryData(pageKey, next)
        setMovingLayer(null)
        void refresh(projectKey)
      },
      () => setMovingLayer(null),
    )
  }

  const moveTo = (targetLayer: Layer, placeBeforeVisually: boolean) => {
    const source = page.layers.find((layer) => layer.id === draggedLayer)
    if (
      !source ||
      draggedLayer === targetLayer.id ||
      isLockedLayer(source) ||
      isLockedLayer(targetLayer) ||
      movingLayer !== null
    ) {
      return
    }
    const parent = targetLayer.parent ?? page.id
    if ((source.parent ?? page.id) !== parent) return
    const siblings = page.layers.filter((layer) => (layer.parent ?? page.id) === parent)
    const remaining = siblings.filter((layer) => layer.id !== source.id)
    const targetIndex = remaining.findIndex((layer) => layer.id === targetLayer.id)
    if (targetIndex < 0) return
    const parentLayer = page.layers.find((layer) => layer.id === parent)
    const visuallyReversed = !(
      parentLayer &&
      isGroupLayer(parentLayer) &&
      parentLayer.role === 'text'
    )
    const insertBeforeStored = visuallyReversed ? !placeBeforeVisually : placeBeforeVisually
    const target = targetIndex + (insertBeforeStored ? 0 : 1)

    setMovingLayer(source.id)
    void call(commands.moveLayer, source.id, parent, target).then(
      (next) => {
        queryClient.setQueryData(pageKey, next)
        setMovingLayer(null)
        setDropTarget(null)
        void refresh(projectKey)
      },
      () => {
        setMovingLayer(null)
        setDropTarget(null)
      },
    )
  }

  const deleteLayer = (layer: EntityId) =>
    void call(commands.deleteLayers, [layer])
      .then(() => {
        if (selected.includes(layer)) {
          selectLayers(selected.filter((selectedLayer) => selectedLayer !== layer))
        }
        setExpandedLayer((current) => (current === layer ? null : current))
        return refresh(projectKey, pageKey)
      })
      .catch(() => undefined)

  // Modifier semantics mirror the page rail: ctrl/meta toggles, shift selects a display range.
  const selectLayer = (layer: EntityId, additive: boolean, range: boolean) => {
    if (!additive && !range) {
      anchor.current = layer
      if (selected.length === 1 && selected[0] === layer) {
        setExpandedLayer((current) => (current === layer ? null : layer))
        return
      }
      selectLayers([layer])
      setExpandedLayer(layer)
      return
    }
    const order = layers.map((row) => row.layer.id)
    const anchorIndex = anchor.current ? order.indexOf(anchor.current) : -1
    if (range && anchorIndex >= 0) {
      const targetIndex = order.indexOf(layer)
      const span = layers
        .slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
        .filter((row) => !isLockedLayer(row.layer))
        .map((row) => row.layer.id)
      selectLayers(additive ? [...selected, ...span] : span)
      return
    }
    anchor.current = layer
    if (!additive) {
      selectLayers([layer])
      return
    }
    selectLayers(
      selected.includes(layer)
        ? selected.filter((selectedLayer) => selectedLayer !== layer)
        : [...selected, layer],
    )
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <header className='flex h-8 shrink-0 items-center gap-1.5 border-b border-border/80 px-2'>
        <Layers3 className='size-3 text-primary' />
        <h2 className='text-[10px] font-semibold'>{t('layers.title')}</h2>
        <span className='text-[9px] text-muted-foreground tabular-nums'>
          {page.layers.filter((layer) => !isGroupLayer(layer)).length}
        </span>
      </header>

      <ScrollArea className='min-h-0 flex-1'>
        <div className='py-0.5'>
          {layers.map(({ layer, index, depth }) => {
            const locked = isLockedLayer(layer)
            const storedSiblings = page.layers.filter(
              (candidate) =>
                !isLockedLayer(candidate) &&
                (candidate.parent ?? page.id) === (layer.parent ?? page.id),
            )
            const parentLayer = page.layers.find((candidate) => candidate.id === layer.parent)
            const siblings =
              parentLayer && isGroupLayer(parentLayer) && parentLayer.role === 'text'
                ? storedSiblings
                : [...storedSiblings].reverse()
            const position = siblings.findIndex((candidate) => candidate.id === layer.id)
            return (
              <LayerRow
                key={`${layer.type}:${layer.id}`}
                layer={layer}
                index={index}
                depth={depth}
                selected={selected.includes(layer.id)}
                expanded={!locked && expandedLayer === layer.id}
                locked={locked}
                onSelect={(event) =>
                  selectLayer(layer.id, event.ctrlKey || event.metaKey, event.shiftKey)
                }
                onToggle={() =>
                  void call(commands.setVisibility, [layer.id], !layer.visibility.visible, null)
                    .then(() => refresh(projectKey, pageKey))
                    .catch(() => undefined)
                }
                onMove={(delta) => move(layer, delta)}
                canMoveUp={!locked && position > 0}
                canMoveDown={!locked && position >= 0 && position < siblings.length - 1}
                reordering={movingLayer !== null}
                dragging={draggedLayer === layer.id}
                dropTarget={dropTarget === layer.id}
                onDragStart={(event) => {
                  setDraggedLayer(layer.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', layer.id)
                }}
                onDragEnd={() => {
                  setDraggedLayer(null)
                  setDropTarget(null)
                }}
                onDragOver={(event) => {
                  const source = page.layers.find((candidate) => candidate.id === draggedLayer)
                  if (
                    !source ||
                    isLockedLayer(layer) ||
                    (source.parent ?? page.id) !== (layer.parent ?? page.id)
                  ) {
                    return
                  }
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTarget(layer.id)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const bounds = event.currentTarget.getBoundingClientRect()
                  moveTo(layer, event.clientY < bounds.top + bounds.height / 2)
                  setDraggedLayer(null)
                }}
                onDelete={isGroupLayer(layer) ? undefined : () => deleteLayer(layer.id)}
              />
            )
          })}
          {layers.length === 0 && <EmptyInspector>{t('layers.empty')}</EmptyInspector>}
        </div>
      </ScrollArea>
    </div>
  )
}

function LayerRow({
  layer,
  index,
  depth,
  selected,
  expanded,
  locked,
  onSelect,
  onToggle,
  onMove,
  canMoveUp,
  canMoveDown,
  reordering,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onDelete,
}: {
  layer: Layer
  index: number
  depth: number
  selected: boolean
  expanded: boolean
  locked: boolean
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void
  onToggle: () => void
  onMove: (delta: number) => void
  canMoveUp: boolean
  canMoveDown: boolean
  reordering: boolean
  dragging: boolean
  dropTarget: boolean
  onDragStart: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const name = localizedLayerName(layer, index, t)
  const detail = localizedLayerKind(layer, t)
  const Icon = layerIcon(layer)
  return (
    <div
      draggable={!locked && !reordering}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`group min-w-0 px-1 py-px ${!locked ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging ? 'opacity-40' : ''}`}
      style={{ paddingLeft: `${depth * 10 + 4}px` }}
    >
      <div
        data-selected={selected}
        data-expanded={expanded}
        data-drop-target={dropTarget}
        className='min-w-0 overflow-hidden rounded-lg border border-transparent transition-colors duration-150 data-[drop-target=true]:border-primary/70 data-[drop-target=true]:bg-primary/10 data-[selected=true]:bg-accent motion-reduce:transition-none'
      >
        <div className='relative flex min-w-0 items-center gap-0.5'>
          <button
            type='button'
            aria-label={t('layers.edit', { name })}
            aria-expanded={locked ? undefined : expanded}
            disabled={locked}
            className='flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring/25'
            onClick={onSelect}
          >
            {!locked && <GripVertical className='size-3 shrink-0 text-muted-foreground/70' />}
            <Icon className='size-3.5 shrink-0 text-muted-foreground' />
            <span className='min-w-0 flex-1'>
              <span className='block truncate text-[11px] font-medium'>{name}</span>
              <span className='block truncate text-[9px] leading-3 text-muted-foreground capitalize'>
                {detail}
              </span>
            </span>
          </button>
          {!locked && (
            <div
              className={`pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 rounded-md bg-background/80 p-0.5 opacity-0 shadow-sm ring-1 ring-border/40 backdrop-blur-md transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 motion-reduce:transition-none ${expanded ? 'right-7' : 'right-[3.25rem]'}`}
            >
              <button
                type='button'
                aria-label={t('layers.moveUp', { name })}
                disabled={reordering || !canMoveUp}
                className='grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-30'
                onClick={() => onMove(-1)}
              >
                <ArrowUp className='size-3' />
              </button>
              <button
                type='button'
                aria-label={t('layers.moveDown', { name })}
                disabled={reordering || !canMoveDown}
                className='grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-30'
                onClick={() => onMove(1)}
              >
                <ArrowDown className='size-3' />
              </button>
            </div>
          )}
          {!expanded && (
            <span className='w-7 shrink-0 text-right text-[9px] text-muted-foreground tabular-nums'>
              {Math.round(layer.visibility.opacity * 100)}%
            </span>
          )}
          {locked ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role='img'
                    className='grid size-6 shrink-0 place-items-center text-muted-foreground'
                    aria-label={t('layers.lockedLabel', { name })}
                  />
                }
              >
                <Lock className='size-3.5' />
              </TooltipTrigger>
              <TooltipContent side='left'>{t('layers.locked')}</TooltipContent>
            </Tooltip>
          ) : (
            <button
              type='button'
              aria-label={
                layer.visibility.visible ? t('layers.hide', { name }) : t('layers.show', { name })
              }
              className='grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25'
              onClick={onToggle}
            >
              {layer.visibility.visible ? (
                <Eye className='size-3.5' />
              ) : (
                <EyeOff className='size-3.5' />
              )}
            </button>
          )}
        </div>
        {expanded && (
          <div className='animate-in duration-150 fade-in slide-in-from-top-1 motion-reduce:animate-none'>
            <LayerEditor layer={layer} onDelete={onDelete} />
          </div>
        )}
      </div>
    </div>
  )
}

function LayerEditor({ layer, onDelete }: { layer: Layer; onDelete?: () => void }) {
  const { t } = useTranslation()
  const name = localizedLayerName(layer, 0, t)
  const [opacity, setOpacity] = useState(layer.visibility.opacity * 100)

  useEffect(() => {
    setOpacity(layer.visibility.opacity * 100)
  }, [layer.id, layer.visibility.opacity])

  const commitOpacity = (next: number) => {
    void call(commands.setVisibility, [layer.id], null, next / 100)
      .then(() => refresh(projectKey, pageKey))
      .catch(() => {
        setOpacity(layer.visibility.opacity * 100)
        previewCanvasOpacity(layer.id, null)
      })
  }

  const previewOpacity = (next: number) => {
    setOpacity(next)
    previewCanvasOpacity(layer.id, next / 100)
  }

  const resetTextFrame = () => {
    if (!isTextLayer(layer) || !layer.automatic_region || !layer.geometry) return
    void call(commands.setGeometry, [{ layer: layer.id, points: null }])
      .then(() => refresh(projectKey, pageKey))
      .catch(() => undefined)
  }

  return (
    <div className='grid min-w-0 gap-1.5 px-1.5 pt-0.5 pb-1.5'>
      <div className='flex min-w-0 items-center gap-1.5'>
        <span className='shrink-0 text-[8px] font-medium text-muted-foreground uppercase'>
          {t('inspector.opacity')}
        </span>
        <div className='flex min-w-0 flex-1 items-center gap-1.5'>
          <Slider
            aria-label={t('layers.opacityLabel', { name })}
            min={0}
            max={100}
            step={1}
            value={opacity}
            className='[&_[data-slot=slider-thumb]]:size-2'
            onValueChange={previewOpacity}
            onValueCommitted={commitOpacity}
          />
          <span className='w-7 shrink-0 text-right text-[8px] text-muted-foreground tabular-nums'>
            {Math.round(opacity)}%
          </span>
        </div>
        {onDelete && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-xs'
                  aria-label={t('layers.delete', { name })}
                  className='size-5 rounded-md text-muted-foreground hover:text-foreground'
                  onClick={onDelete}
                />
              }
            >
              <Trash2 className='size-3' />
            </TooltipTrigger>
            <TooltipContent side='left'>{t('layers.delete', { name })}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {isTextLayer(layer) && (
        <>
          <div className='flex h-5 min-w-0 items-center gap-1.5'>
            <span className='text-[8px] font-medium text-muted-foreground uppercase'>
              {t('inspector.placement')}
            </span>
            <span className='rounded-md bg-foreground/[0.055] px-1.5 py-0.5 text-[9px] leading-none text-foreground/75'>
              {layer.geometry
                ? t('inspector.customFrame')
                : layer.automatic_region
                  ? t('inspector.autoFit')
                  : t('inspector.unplaced')}
            </span>
            {layer.geometry && layer.automatic_region && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type='button'
                      variant='ghost'
                      size='xs'
                      aria-label={t('inspector.resetAutoFit')}
                      className='ml-auto h-5 gap-1 rounded-md px-1.5 text-[9px] font-normal text-muted-foreground hover:text-foreground'
                      onClick={resetTextFrame}
                    />
                  }
                >
                  <RotateCcw className='size-3' />
                  {t('common.reset')}
                </TooltipTrigger>
                <TooltipContent side='left'>{t('inspector.resetAutoFit')}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <InspectorField label={t('inspector.source')}>
            <CommitTextarea
              data-testid={`edit-source-${layer.id}`}
              aria-label={t('layers.sourceLabel', { name })}
              wrap='soft'
              className='max-h-14 min-h-8 w-full max-w-full min-w-0 resize-y overflow-y-auto rounded-md bg-background px-1.5 py-1 text-[12px] leading-4 md:text-[12px]'
              value={layer.content.source?.text ?? ''}
              onCommit={(text) =>
                void call(commands.setSourceText, layer.id, text)
                  .then(() => refresh(projectKey, pageKey))
                  .catch(() => undefined)
              }
            />
          </InspectorField>
          <InspectorField label={t('inspector.translation')}>
            <CommitTextarea
              data-testid={`edit-translation-${layer.id}`}
              aria-label={t('layers.translationLabel', { name })}
              wrap='soft'
              className='max-h-16 min-h-9 w-full max-w-full min-w-0 resize-y overflow-y-auto rounded-md border-primary/25 bg-background px-1.5 py-1 text-[12px] leading-4 md:text-[12px]'
              value={layer.content.translation?.text ?? ''}
              onCommit={(text) =>
                void call(commands.setTranslation, layer.id, text.trim() ? text : null)
                  .then(() => refresh(projectKey, pageKey))
                  .catch(() => undefined)
              }
            />
          </InspectorField>
        </>
      )}
    </div>
  )
}

function InspectorField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='grid min-w-0 gap-0.5'>
      <span className='text-[8px] font-medium tracking-[0.06em] text-muted-foreground uppercase'>
        {label}
      </span>
      {children}
    </div>
  )
}

const fontSizePresets = [8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96]

function FontSizeField({
  value,
  autoFit,
  disabled,
  onChange,
  onAutoFit,
}: {
  value: number
  autoFit: boolean
  disabled: boolean
  onChange: (value: number) => void
  onAutoFit: () => void
}) {
  const { t } = useTranslation()

  const select = (choice: string) => {
    if (choice === 'auto') {
      onAutoFit()
      return
    }
    const size = Number(choice)
    if (Number.isFinite(size) && size > 0 && size <= 300) {
      onChange(size)
    }
  }

  return (
    <div className='flex min-w-0 items-end gap-1'>
      <div className='min-w-0 flex-1'>
        <ScrubNumber
          label={
            autoFit
              ? `${t('inspector.fontSize')} · ${t('inspector.auto')}`
              : t('inspector.fontSize')
          }
          value={value}
          inputTestId='type-size'
          min={0.5}
          max={300}
          step={0.5}
          disabled={disabled}
          scrubbable
          onChange={onChange}
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label={t('inspector.chooseFontSize')}
          className='grid size-6 shrink-0 place-items-center rounded-md border border-input text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-40'
        >
          <ChevronDown className='size-3' />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          className='w-28 min-w-28 border border-border/50 p-0.5 shadow-sm ring-0'
        >
          <DropdownMenuRadioGroup value={autoFit ? 'auto' : String(value)} onValueChange={select}>
            <DropdownMenuRadioItem value='auto' className='min-h-6 py-0.5 text-[10px]'>
              {t('inspector.auto')}
            </DropdownMenuRadioItem>
            {fontSizePresets.map((size) => (
              <DropdownMenuRadioItem
                key={size}
                value={String(size)}
                className='min-h-6 py-0.5 text-[10px] tabular-nums'
              >
                {size}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function EmptyInspector({ children }: { children: React.ReactNode }) {
  return (
    <div className='px-4 py-8 text-center text-[10px] leading-4 text-muted-foreground'>
      {children}
    </div>
  )
}

function rgbaToHex([red, green, blue]: [number, number, number, number]): string {
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

function rgbaToCss([red, green, blue, alpha]: [number, number, number, number]): string {
  return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`
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

function layerIcon(layer: Layer): typeof Type {
  if (layer.type === 'group') return Folder
  if (layer.type === 'raster') return Brush
  if (layer.type === 'text') return Type
  return ImageIcon
}

function localizedLayerName(layer: Layer, index: number, t: TFunction): string {
  if (layer.type === 'group' || layer.type === 'raster') return layer.name
  if (layer.type === 'text') {
    const text = layer.content.translation?.text || layer.content.source?.text
    return text?.trim() || t('layers.textName', { index: index + 1 })
  }
  if (layer.type === 'artwork') return t('layers.originalArtwork')
  return t('layers.imageName', { index: index + 1 })
}

function localizedLayerKind(layer: Layer, t: TFunction): string {
  if (layer.type === 'group') {
    return t(layer.role === 'text' ? 'layers.kinds.textGroup' : 'layers.kinds.group')
  }
  if (layer.type === 'raster') {
    return t(`layers.kinds.${layer.kind}`, { defaultValue: layer.kind })
  }
  if (layer.type === 'text') {
    const role = layer.content.role?.split('.').at(-1)
    if (role === 'dialogue') return t('layers.kinds.dialogue')
    if (role === 'free-text') return t('layers.kinds.freeText')
    return t('layers.kinds.text')
  }
  return t('layers.kinds.image')
}
