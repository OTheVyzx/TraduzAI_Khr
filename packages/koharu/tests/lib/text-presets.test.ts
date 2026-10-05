import { beforeEach, describe, expect, it } from 'vitest'

import {
  applySelectedFrameGroups,
  applySelectedTypographyGroups,
  applyTextStyle,
  copyTextStyle,
  readCopiedTextAttributes,
  readTextPresets,
  saveTextPreset,
  storeCopiedTextAttributes,
  type TextAttributeGroup,
} from '@/lib/text-presets'
import type { Frame, Typography } from '@koharu/bridge/protocol'

const base: Typography = {
  preferred_font: 'Noto Sans',
  font_weight: 400,
  font_style: 'normal',
  size: 20,
  auto_fit: false,
  color: [0, 0, 0, 255],
  stroke_color: [255, 255, 255, 255],
  stroke_width: 0,
  alignment: 'Center',
  writing_mode: null,
  placement: 'original_text',
  shear_x: 0.25,
  shear_y: 0.1,
  shadow: null,
  glow: null,
  gradient: null,
}

beforeEach(() => localStorage.clear())

describe('text style presets', () => {
  it('saves and reads a named style including enabled effects', () => {
    saveTextPreset('Noite', {
      ...base,
      shadow: {
        color: [0, 0, 0, 200],
        offset_x: 2,
        offset_y: 3,
        blur_radius: 4,
      },
    })
    expect(readTextPresets()).toEqual([
      expect.objectContaining({
        name: 'Noite',
        style: expect.objectContaining({
          shadow: expect.objectContaining({ blur_radius: 4 }),
        }),
      }),
    ])
  })

  it('applies a copied style without moving or shearing the target', () => {
    const style = copyTextStyle({
      ...base,
      size: 30,
      glow: { color: [255, 0, 0, 255], radius: 5 },
    })
    const target = {
      ...base,
      placement: 'balloon' as const,
      shear_x: -0.3,
      shear_y: -0.2,
      size: 12,
    }
    expect(applyTextStyle(target, style)).toMatchObject({
      size: 30,
      glow: { color: [255, 0, 0, 255], radius: 5 },
      placement: 'balloon',
      shear_x: -0.3,
      shear_y: -0.2,
    })
  })

  it('copies typography and frame without copying text content', () => {
    const frame = {
      x: 40,
      y: 60,
      width: 120,
      height: 42,
      angle_degrees: 18,
    }
    storeCopiedTextAttributes(base, frame)
    expect(readCopiedTextAttributes()).toEqual({ style: base, frame })
  })

  it('applies selected typography groups while preserving unchecked attributes', () => {
    const source: Typography = {
      ...base,
      preferred_font: 'Comic Source',
      font_weight: 700,
      font_style: 'italic',
      size: 36,
      auto_fit: true,
      color: [12, 34, 56, 255],
      stroke_color: [70, 80, 90, 255],
      stroke_width: 3,
      shadow: { color: [1, 2, 3, 255], offset_x: 4, offset_y: 5, blur_radius: 6 },
      glow: { color: [7, 8, 9, 255], radius: 10 },
      gradient: {
        start_color: [11, 12, 13, 255],
        end_color: [14, 15, 16, 255],
        angle_degrees: 45,
      },
      alignment: 'End',
      writing_mode: 'Vertical',
      placement: 'manual',
      shear_x: -0.4,
      shear_y: 0.5,
    }
    const target: Typography = {
      ...base,
      preferred_font: 'Target Font',
      color: [100, 110, 120, 255],
      stroke_width: 1,
      shadow: null,
      alignment: 'Center',
      writing_mode: 'Horizontal',
      placement: 'balloon',
      shear_x: 0.1,
      shear_y: 0.2,
    }
    const groups = new Set<TextAttributeGroup>([
      'font-size',
      'fill',
      'outline',
      'effects',
      'alignment-direction',
    ])

    expect(applySelectedTypographyGroups(target, source, groups)).toEqual({
      ...source,
      placement: target.placement,
      shear_x: target.shear_x,
      shear_y: target.shear_y,
    })
  })

  it('applies inclination and placement independently from typography groups', () => {
    const source: Typography = { ...base, placement: 'manual', shear_x: 0.75, shear_y: -0.25 }
    const target: Typography = { ...base, placement: 'balloon', shear_x: 0, shear_y: 0 }

    expect(applySelectedTypographyGroups(target, source, new Set(['shear-placement']))).toEqual({
      ...target,
      placement: 'manual',
      shear_x: 0.75,
      shear_y: -0.25,
    })
  })

  it('copies the frame only when transformation is selected', () => {
    const source: Frame = { x: 40, y: 60, width: 120, height: 42, angle_degrees: 18 }
    const target: Frame = { x: 10, y: 20, width: 80, height: 30, angle_degrees: -5 }

    expect(applySelectedFrameGroups(target, source, new Set(['fill']))).toEqual(target)
    expect(applySelectedFrameGroups(target, source, new Set(['transform']))).toEqual(source)
  })
})
