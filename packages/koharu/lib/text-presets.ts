import type { Frame, Typography } from '@koharu/bridge/protocol'

export interface TextPreset {
  name: string
  style: Partial<Typography>
}

const presetsKey = 'traduzai_khr.text_presets.v1'
const clipboardKey = 'traduzai_khr.text_attributes_clipboard.v1'

export interface CopiedTextAttributes {
  style: Typography
  frame: Frame
}

export type TextAttributeGroup =
  | 'font-size'
  | 'fill'
  | 'outline'
  | 'effects'
  | 'alignment-direction'
  | 'shear-placement'
  | 'transform'

export type TextAttributeGroupSelection = ReadonlySet<TextAttributeGroup>

export function copyTextStyle(typography: Typography): Partial<Typography> {
  const { placement: _placement, shear_x: _shearX, shear_y: _shearY, ...style } = typography
  return structuredClone(style)
}

export function applyTextStyle(target: Typography, style: Partial<Typography>): Typography {
  const { placement: _placement, shear_x: _shearX, shear_y: _shearY, ...safeStyle } = style
  return { ...target, ...structuredClone(safeStyle) }
}

export function applyTextAttributes(target: Typography, attributes: Typography): Typography {
  return { ...target, ...structuredClone(attributes) }
}

export function applySelectedTypographyGroups(
  target: Typography,
  source: Typography,
  groups: TextAttributeGroupSelection,
): Typography {
  return {
    ...target,
    ...(groups.has('font-size') &&
      copyFields(source, ['preferred_font', 'font_weight', 'font_style', 'size', 'auto_fit'])),
    ...(groups.has('fill') && copyFields(source, ['color'])),
    ...(groups.has('outline') && copyFields(source, ['stroke_color', 'stroke_width'])),
    ...(groups.has('effects') && copyFields(source, ['shadow', 'glow', 'gradient'])),
    ...(groups.has('alignment-direction') && copyFields(source, ['alignment', 'writing_mode'])),
    ...(groups.has('shear-placement') && copyFields(source, ['shear_x', 'shear_y', 'placement'])),
  }
}

export function applySelectedFrameGroups(
  target: Frame,
  source: Frame,
  groups: TextAttributeGroupSelection,
): Frame {
  return groups.has('transform') ? structuredClone(source) : target
}

export function readTextPresets(): TextPreset[] {
  const saved = readJson(presetsKey)
  if (!Array.isArray(saved)) return []
  return saved.filter(
    (item): item is TextPreset =>
      item !== null &&
      typeof item === 'object' &&
      typeof item.name === 'string' &&
      item.name.trim().length > 0 &&
      item.style !== null &&
      typeof item.style === 'object' &&
      !Array.isArray(item.style),
  )
}

export function saveTextPreset(name: string, typography: Typography): void {
  const trimmed = name.trim().slice(0, 80)
  if (!trimmed || typeof localStorage === 'undefined') return
  const presets = readTextPresets().filter((preset) => preset.name !== trimmed)
  presets.push({ name: trimmed, style: copyTextStyle(typography) })
  localStorage.setItem(presetsKey, JSON.stringify(presets.slice(-50)))
}

export function removeTextPreset(name: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(
    presetsKey,
    JSON.stringify(readTextPresets().filter((preset) => preset.name !== name)),
  )
}

export function storeCopiedTextAttributes(typography: Typography, frame: Frame): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(clipboardKey, JSON.stringify({ style: structuredClone(typography), frame }))
}

export function readCopiedTextAttributes(): CopiedTextAttributes | null {
  const value = readJson(clipboardKey)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const copied = value as Partial<CopiedTextAttributes>
  const frame = copied.frame
  if (
    !copied.style ||
    typeof copied.style !== 'object' ||
    Array.isArray(copied.style) ||
    !frame ||
    ![frame.x, frame.y, frame.width, frame.height, frame.angle_degrees].every(Number.isFinite) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return null
  }
  return structuredClone(copied as CopiedTextAttributes)
}

function readJson(key: string): unknown {
  if (typeof localStorage === 'undefined') return null
  try {
    const stored = localStorage.getItem(key)
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

function copyFields<T extends object, const K extends readonly (keyof T)[]>(
  source: T,
  fields: K,
): Pick<T, K[number]> {
  return Object.fromEntries(fields.map((field) => [field, structuredClone(source[field])])) as Pick<
    T,
    K[number]
  >
}
