//! Text layout and portable glyph recording.

use std::sync::Arc;

use anyhow::Result;
use koharu_rasterizer::{
    PreparedGlyph, PreparedGlyphRun, PreparedLinearGradient, PreparedResource, PreparedScene,
    PreparedSceneCommand, ResourceId,
};
use koharu_scene::{TextGlow, TextGradient, TextShadow};
use vello::kurbo::Affine;

use crate::{
    Error, FontStyle, HyphenationPolicy, LayoutRun, RenderBounds, RenderDiagnostic,
    Result as RenderResult, TextAlign, TextLayout, WritingMode,
    bubble::LayoutBox,
    fonts::{Fonts, font_key},
    script::is_chinese_or_japanese_text,
};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TextNodeDescriptor {
    pub(crate) entity: koharu_scene::EntityId,
    pub(crate) text: String,
    pub(crate) language: Option<koharu_scene::LanguageTag>,
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) balloon_contour: Option<Vec<(f32, f32)>>,
    pub(crate) preferred_font: Option<String>,
    pub(crate) font_families: Vec<String>,
    pub(crate) font_weight: Option<u16>,
    pub(crate) font_style: Option<FontStyle>,
    pub(crate) font_size: Option<f32>,
    pub(crate) minimum_font_size: f32,
    pub(crate) auto_fit: bool,
    pub(crate) alignment: TextAlign,
    pub(crate) writing_mode: WritingMode,
    pub(crate) foreground_color: [u8; 4],
    pub(crate) stroke: Option<StrokeOptions>,
    pub(crate) shear_x: Option<f32>,
    pub(crate) shear_y: Option<f32>,
    pub(crate) shadow: Option<TextShadow>,
    pub(crate) glow: Option<TextGlow>,
    pub(crate) gradient: Option<TextGradient>,
    pub(crate) line_height: f32,
    pub(crate) letter_spacing: f32,
    pub(crate) word_spacing: f32,
    pub(crate) text_inset: [f32; 4],
    pub(crate) point_text: bool,
}

pub(crate) struct RenderedTextNode {
    pub(crate) scene: Arc<PreparedScene>,
    pub(crate) resources: Arc<[PreparedResource]>,
    pub(crate) local_bounds: RenderBounds,
    pub(crate) metadata: RenderedTextMetadata,
    pub(crate) diagnostics: Vec<RenderDiagnostic>,
}

pub(crate) struct RenderedTextMetadata {
    pub(crate) rendered_bounds: RenderBounds,
    pub(crate) layout_bounds: RenderBounds,
    pub(crate) post_script_fonts: Vec<String>,
    pub(crate) font_size: f32,
    pub(crate) color: [u8; 4],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct StrokeOptions {
    pub color: [u8; 4],
    pub width_px: f32,
}

/// Paint options used when recording one laid-out text run into a Vello scene.
#[derive(Debug, Clone)]
pub(crate) struct TextRenderOptions {
    pub color: [u8; 4],
    pub hint_glyphs: bool,
    pub padding: f32,
    pub baseline_shift: f32,
    pub stroke: Option<StrokeOptions>,
    pub shadow: Option<TextShadow>,
    pub glow: Option<TextGlow>,
    pub gradient: Option<PreparedLinearGradient>,
}

impl Default for TextRenderOptions {
    fn default() -> Self {
        Self {
            color: [0, 0, 0, 255],
            hint_glyphs: true,
            padding: 0.0,
            baseline_shift: 0.0,
            stroke: None,
            shadow: None,
            glow: None,
            gradient: None,
        }
    }
}

/// Shapes text and records the resulting glyphs into vector scenes.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TextRenderer;

impl TextRenderer {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    pub(crate) fn layout<'a>(&self, builder: &TextLayout<'a>, text: &str) -> Result<LayoutRun<'a>> {
        builder.run(text)
    }

    pub(crate) fn render(
        &self,
        scene: &mut PreparedScene,
        resources: &mut Vec<PreparedResource>,
        layout: &LayoutRun<'_>,
        writing_mode: WritingMode,
        options: &TextRenderOptions,
        transform: Affine,
    ) {
        if let Some(shadow) = options.shadow.as_ref().filter(|shadow| shadow.color[3] > 0) {
            let shifted =
                Affine::translate((f64::from(shadow.offset_x), f64::from(shadow.offset_y)))
                    * transform;
            draw_soft_effect(
                scene,
                resources,
                layout,
                writing_mode,
                options,
                shifted,
                shadow.color,
                shadow.blur_radius,
            );
        }
        if let Some(glow) = options.glow.as_ref().filter(|glow| glow.color[3] > 0) {
            draw_soft_effect(
                scene,
                resources,
                layout,
                writing_mode,
                options,
                transform,
                glow.color,
                glow.radius,
            );
        }
        // The border is drawn first as an outward-only dilation of the glyph outline (see
        // `draw_layout`), then the ordinary fill is drawn on top in the foreground color. Unlike a
        // centered stroke, a dilation never grows inward, so it can't punch a hole through small
        // features (e.g. dots) once the border width exceeds their radius.
        if let Some(stroke) = options
            .stroke
            .filter(|stroke| stroke.width_px > 0.0 && stroke.color[3] > 0)
        {
            draw_layout(
                scene,
                resources,
                layout,
                writing_mode,
                options,
                transform,
                GlyphPaint {
                    color: stroke.color,
                    dilation_px: stroke.width_px,
                    gradient: None,
                },
            );
        }
        draw_layout(
            scene,
            resources,
            layout,
            writing_mode,
            options,
            transform,
            GlyphPaint {
                color: options.color,
                dilation_px: 0.0,
                gradient: options.gradient.clone(),
            },
        );
    }

    pub(crate) fn render_descriptor(
        &self,
        descriptor: &TextNodeDescriptor,
        fonts: &Fonts,
    ) -> RenderResult<RenderedTextNode> {
        let is_bubble_text = descriptor.balloon_contour.is_some();
        let frame = LayoutBox {
            x: 0.0,
            y: 0.0,
            width: descriptor.width,
            height: descriptor.height,
        };
        let bounds = if is_bubble_text {
            inset(frame, descriptor.text_inset)
        } else {
            frame
        };
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Err(Error::invalid(format!(
                "text inset leaves no layout area for entity {}",
                descriptor.entity
            )));
        }
        let fonts = fonts
            .resolve(
                descriptor.preferred_font.as_deref(),
                descriptor.font_weight,
                descriptor.font_style,
                &descriptor.font_families,
                &descriptor.text,
                descriptor
                    .language
                    .as_ref()
                    .map(koharu_scene::LanguageTag::as_str),
            )
            .map_err(|source| Error::Font {
                entity: descriptor.entity,
                source,
            })?;
        let automatic_maximum = || automatic_maximum(descriptor, bounds, is_bubble_text);
        let maximum = if descriptor.auto_fit {
            automatic_maximum()
        } else {
            descriptor.font_size.unwrap_or_else(automatic_maximum)
        };
        let minimum = descriptor.minimum_font_size.min(maximum);
        let mut layout = TextLayout::new(&fonts[0])
            .with_fallback_fonts(&fonts[1..])
            .with_writing_mode(descriptor.writing_mode)
            .with_alignment(descriptor.alignment)
            .with_line_height(descriptor.line_height)
            .with_spacing(descriptor.letter_spacing, descriptor.word_spacing)
            .with_cjk_punctuation_layout(
                is_chinese_or_japanese_text(&descriptor.text)
                    || descriptor
                        .language
                        .as_ref()
                        .is_some_and(|language| is_chinese_or_japanese_language(language.as_str())),
            );
        if !descriptor.point_text {
            layout = layout
                .with_max_width(bounds.width)
                .with_max_height(bounds.height);
        }
        if let Some(contour) = &descriptor.balloon_contour {
            let [top, _, _, left] = descriptor.text_inset;
            let contour = contour.iter().map(|&(x, y)| (x - left, y - top)).collect();
            layout = layout.with_comic_balloon(
                bounds.width,
                bounds.height,
                contour,
                descriptor.text_inset.into_iter().fold(0.0, f32::max),
            );
        }
        if let Some(language) = &descriptor.language {
            layout = layout.with_hyphenation_language_tag(language.as_str());
        }
        if is_bubble_text && descriptor.writing_mode == WritingMode::Horizontal {
            layout = layout.with_hyphenation_policy(HyphenationPolicy::LastResort);
        }
        let layout = if descriptor.auto_fit && !descriptor.point_text {
            layout
                .with_max_font_size(maximum)
                .with_min_font_size(minimum)
        } else {
            layout.with_font_size(descriptor.font_size.unwrap_or(maximum))
        };
        let layout = self
            .layout(&layout, &descriptor.text)
            .map_err(|source| Error::Layout {
                entity: descriptor.entity,
                source,
            })?;
        let (mut x, mut y) = if descriptor.point_text {
            (bounds.x, bounds.y)
        } else {
            placement(bounds, layout.width, layout.height)
        };
        x += layout.placement_offset_x();
        y += layout.placement_offset_y();
        let shear_x = descriptor.shear_x.unwrap_or(0.0);
        let shear_y = descriptor.shear_y.unwrap_or(0.0);
        let transform = text_shear_transform(x, y, layout.width, layout.height, shear_x, shear_y);
        let color = descriptor.foreground_color;
        let mut options = TextRenderOptions {
            color,
            stroke: None,
            shadow: descriptor.shadow.clone(),
            glow: descriptor.glow.clone(),
            gradient: descriptor.gradient.as_ref().map(|gradient| {
                let radians = gradient.angle_degrees.to_radians();
                let (dx, dy) = (radians.cos(), radians.sin());
                let span = dx.abs() * layout.width + dy.abs() * layout.height;
                let midpoint = [layout.width * 0.5, layout.height * 0.5];
                PreparedLinearGradient {
                    start: [midpoint[0] - dx * span * 0.5, midpoint[1] - dy * span * 0.5],
                    end: [midpoint[0] + dx * span * 0.5, midpoint[1] + dy * span * 0.5],
                    start_color: gradient.start_color,
                    end_color: gradient.end_color,
                }
            }),
            ..TextRenderOptions::default()
        };
        let mut scene = PreparedScene::default();
        let mut resources = Vec::new();
        if let Some(stroke) = descriptor.stroke {
            options.stroke = Some(stroke);
        }
        self.render(
            &mut scene,
            &mut resources,
            &layout,
            descriptor.writing_mode,
            &options,
            transform,
        );
        let mut diagnostics = Vec::new();
        if layout.font_size + f32::EPSILON < descriptor.minimum_font_size {
            diagnostics.push(RenderDiagnostic::TextBelowReadableSize {
                entity: descriptor.entity,
                font_size: layout.font_size,
                minimum_font_size: descriptor.minimum_font_size,
            });
        }
        if layout.overflowed() {
            diagnostics.push(RenderDiagnostic::TextOverflow {
                entity: descriptor.entity,
                available: bounds.into(),
                actual_width: layout.width,
                actual_height: layout.height,
                font_size: layout.font_size,
            });
        }
        let rendered_bounds = RenderBounds {
            x,
            y,
            width: layout.width,
            height: layout.height,
        };
        let stroke_padding = descriptor
            .stroke
            .map_or(0.0, |stroke| stroke.width_px.max(0.0));
        let glow_padding = descriptor.glow.as_ref().map_or(0.0, |glow| glow.radius);
        let padding = stroke_padding.max(glow_padding);
        let shear_padding_x = shear_x.abs() * (shear_y.abs() * layout.width + layout.height) * 0.5;
        let shear_padding_y = shear_y.abs() * layout.width * 0.5;
        let mut left = rendered_bounds.x - padding - shear_padding_x;
        let mut top = rendered_bounds.y - padding - shear_padding_y;
        let mut right = rendered_bounds.x + rendered_bounds.width + padding + shear_padding_x;
        let mut bottom = rendered_bounds.y + rendered_bounds.height + padding + shear_padding_y;
        if let Some(shadow) = &descriptor.shadow {
            left = left
                .min(rendered_bounds.x + shadow.offset_x - shadow.blur_radius - shear_padding_x);
            top =
                top.min(rendered_bounds.y + shadow.offset_y - shadow.blur_radius - shear_padding_y);
            right = right.max(
                rendered_bounds.x
                    + rendered_bounds.width
                    + shadow.offset_x
                    + shadow.blur_radius
                    + shear_padding_x,
            );
            bottom = bottom.max(
                rendered_bounds.y
                    + rendered_bounds.height
                    + shadow.offset_y
                    + shadow.blur_radius
                    + shear_padding_y,
            );
        }
        Ok(RenderedTextNode {
            scene: Arc::new(scene),
            resources: resources.into(),
            local_bounds: RenderBounds {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
            },
            metadata: RenderedTextMetadata {
                rendered_bounds,
                layout_bounds: if descriptor.point_text {
                    rendered_bounds
                } else {
                    bounds.into()
                },
                post_script_fonts: fonts
                    .iter()
                    .map(|font| font.post_script_name().to_owned())
                    .collect(),
                font_size: layout.font_size,
                color,
            },
            diagnostics,
        })
    }
}

fn text_shear_transform(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    shear_x: f32,
    shear_y: f32,
) -> Affine {
    let center = (f64::from(width * 0.5), f64::from(height * 0.5));
    Affine::translate((f64::from(x), f64::from(y)))
        * Affine::translate(center)
        * Affine::skew(f64::from(shear_x), 0.0)
        * Affine::skew(0.0, f64::from(shear_y))
        * Affine::translate((-center.0, -center.1))
}

fn automatic_maximum(
    descriptor: &TextNodeDescriptor,
    bounds: LayoutBox,
    is_bubble_text: bool,
) -> f32 {
    if is_bubble_text {
        if descriptor.writing_mode.is_vertical() {
            bounds.height
        } else {
            bounds.width
        }
    } else {
        24.0
    }
}

fn is_chinese_or_japanese_language(language: &str) -> bool {
    language
        .split(['-', '_'])
        .next()
        .is_some_and(|primary| matches!(primary.to_ascii_lowercase().as_str(), "ja" | "zh"))
}

fn inset(rect: LayoutBox, [top, right, bottom, left]: [f32; 4]) -> LayoutBox {
    LayoutBox {
        x: rect.x + left,
        y: rect.y + top,
        width: (rect.width - left - right).max(0.0),
        height: (rect.height - top - bottom).max(0.0),
    }
}

fn placement(rect: LayoutBox, width: f32, height: f32) -> (f32, f32) {
    let x = rect.x + (rect.width - width) * 0.5;
    let remaining = rect.height - height;
    let y = rect.y + remaining * 0.5;
    (x, y)
}

/// Color and outward dilation for one glyph draw pass (border or ordinary fill).
struct GlyphPaint {
    color: [u8; 4],
    dilation_px: f32,
    gradient: Option<PreparedLinearGradient>,
}

fn draw_soft_effect(
    scene: &mut PreparedScene,
    resources: &mut Vec<PreparedResource>,
    layout: &LayoutRun<'_>,
    writing_mode: WritingMode,
    options: &TextRenderOptions,
    transform: Affine,
    color: [u8; 4],
    radius: f32,
) {
    if radius <= 0.0 {
        draw_layout(
            scene,
            resources,
            layout,
            writing_mode,
            options,
            transform,
            GlyphPaint {
                color,
                dilation_px: 0.0,
                gradient: None,
            },
        );
        return;
    }

    // Portable display lists do not carry a blur filter. Several translucent outward
    // dilations preserve the same soft edge in the canvas and native export.
    for step in (1..=6).rev() {
        let mut faded = color;
        faded[3] = (f32::from(color[3]) / 6.0).round() as u8;
        draw_layout(
            scene,
            resources,
            layout,
            writing_mode,
            options,
            transform,
            GlyphPaint {
                color: faded,
                dilation_px: radius * step as f32 / 6.0,
                gradient: None,
            },
        );
    }
    draw_layout(
        scene,
        resources,
        layout,
        writing_mode,
        options,
        transform,
        GlyphPaint {
            color,
            dilation_px: 0.0,
            gradient: None,
        },
    );
}

fn draw_layout(
    scene: &mut PreparedScene,
    resources: &mut Vec<PreparedResource>,
    layout: &LayoutRun<'_>,
    writing_mode: WritingMode,
    options: &TextRenderOptions,
    transform: Affine,
    paint: GlyphPaint,
) {
    for line in &layout.lines {
        let (baseline_x, baseline_y) = match writing_mode {
            WritingMode::Horizontal | WritingMode::VerticalRl => line.baseline,
        };
        let mut pen_x = 0.0;
        let mut pen_y = 0.0;
        let mut start = 0;

        while start < line.glyphs.len() {
            let font = line.glyphs[start].font;
            let key = font_key(font);
            let mut end = start + 1;
            while end < line.glyphs.len() && font_key(line.glyphs[end].font) == key {
                end += 1;
            }

            let mut glyphs = Vec::with_capacity(end - start);
            for glyph in &line.glyphs[start..end] {
                glyphs.push(PreparedGlyph {
                    id: glyph.glyph_id,
                    x: options.padding + baseline_x + pen_x + glyph.x_offset,
                    y: options.padding + baseline_y + pen_y
                        - glyph.y_offset
                        - options.baseline_shift,
                });
                pen_x += glyph.x_advance;
                pen_y -= glyph.y_advance;
            }

            let font_id = ResourceId::for_font(font.bytes());
            if !resources.iter().any(|candidate| candidate.id() == font_id) {
                resources.push(PreparedResource::font_shared(font.shared_bytes()));
            }
            let glyph_transform = font
                .synthetic_skew()
                .map(|angle| Affine::skew(-(angle.to_radians().tan() as f64), 0.0).as_coeffs());
            let synthetic_bold = if font.synthetic_bold() { 1.0 } else { 0.0 };
            scene
                .commands
                .push(PreparedSceneCommand::GlyphRun(PreparedGlyphRun {
                    font: font_id,
                    font_index: font.index(),
                    font_size: layout.font_size,
                    normalized_coords: font.normalized_coords().to_vec(),
                    transform: transform.as_coeffs(),
                    glyph_transform,
                    // Hinting folds a uniform zoom into `font_size` for crisp fill text, but a
                    // border needs the real transform so its dilation amount stays proportional
                    // to that same zoom instead of being rendered at a fixed pixel size.
                    hint: options.hint_glyphs && paint.dilation_px == 0.0,
                    embolden: [synthetic_bold + paint.dilation_px; 2],
                    color: paint.color,
                    gradient: paint.gradient.clone(),
                    glyphs,
                }));
            start = end;
        }
    }
}

#[cfg(test)]
mod tests {
    use koharu_rasterizer::{
        Bounds, CompositionCommand, LayerId, LayerKind as PreparedLayerKind, Point,
        PreparedContent, PreparedFrame, PreparedFrameBundle, PreparedFrameManifest, PreparedLayer,
        PreparedResourcePacket, PreparedResourceStore, Presentation, Revision,
    };
    use koharu_scene::EntityId;

    use super::*;
    use crate::fonts::FontSystem;

    #[test]
    fn text_shear_moves_both_axes_around_the_same_center() {
        let transform = text_shear_transform(10.0, 20.0, 100.0, 50.0, 0.2, 0.3);
        let center = transform * vello::kurbo::Point::new(50.0, 25.0);
        let top = transform * vello::kurbo::Point::new(50.0, 0.0);
        let left = transform * vello::kurbo::Point::new(0.0, 25.0);

        assert!((center.x - 60.0).abs() < 1e-5);
        assert!((center.y - 45.0).abs() < 1e-5);
        assert!((top.x - 55.0).abs() < 1e-5);
        assert!((top.y - 20.0).abs() < 1e-5);
        assert!((left.y - 30.0).abs() < 1e-5);
    }

    #[test]
    fn automatic_size_preserves_free_text_default_and_balloon_extent() {
        let descriptor = TextNodeDescriptor {
            entity: EntityId::new(),
            text: "Hi".to_owned(),
            language: None,
            width: 240.0,
            height: 120.0,
            balloon_contour: None,
            preferred_font: Some("Arial".to_owned()),
            font_families: vec!["Arial".to_owned()],
            font_weight: None,
            font_style: None,
            font_size: Some(6.0),
            minimum_font_size: 9.0,
            auto_fit: true,
            alignment: TextAlign::Center,
            writing_mode: WritingMode::Horizontal,
            foreground_color: [0, 0, 0, 255],
            stroke: None,
            shear_x: None,
            shear_y: None,
            shadow: None,
            glow: None,
            gradient: None,
            line_height: 1.2,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            text_inset: [0.0; 4],
            point_text: false,
        };
        let bounds = LayoutBox {
            x: 0.0,
            y: 0.0,
            width: 240.0,
            height: 120.0,
        };

        assert_eq!(automatic_maximum(&descriptor, bounds, false), 24.0);
        assert_eq!(automatic_maximum(&descriptor, bounds, true), 240.0);
    }

    #[test]
    fn rendered_text_survives_prepared_packet_round_trip() {
        let font = FontSystem::new().first_font().unwrap();
        let layout = TextLayout::new(&font)
            .with_font_size(24.0)
            .run("Koharu")
            .unwrap();
        let mut scene = PreparedScene::default();
        let mut resources = Vec::new();
        let options = TextRenderOptions {
            gradient: Some(PreparedLinearGradient {
                start: [0.0, 0.0],
                end: [160.0, 0.0],
                start_color: [255, 0, 0, 255],
                end_color: [0, 0, 255, 255],
            }),
            ..TextRenderOptions::default()
        };
        TextRenderer::new().render(
            &mut scene,
            &mut resources,
            &layout,
            WritingMode::Horizontal,
            &options,
            Affine::IDENTITY,
        );
        assert_eq!(resources.len(), 1);
        assert!(matches!(
            &resources[0],
            PreparedResource::Font { bytes, .. } if !bytes.is_empty()
        ));

        let layer = LayerId::from_bytes([2; 16]);
        let bundle = PreparedFrameBundle {
            frame: PreparedFrame {
                revision: Revision::new(7),
                page: LayerId::from_bytes([1; 16]),
                width: 160,
                height: 48,
                origin: (0, 0),
                normalization: Affine::IDENTITY.as_coeffs(),
                layers: vec![PreparedLayer {
                    id: layer,
                    geometry: vec![
                        Point { x: 0.0, y: 0.0 },
                        Point { x: 160.0, y: 0.0 },
                        Point { x: 160.0, y: 48.0 },
                        Point { x: 0.0, y: 48.0 },
                    ],
                    bounds: Bounds {
                        x: 0.0,
                        y: 0.0,
                        width: 160.0,
                        height: 48.0,
                    },
                    local_bounds: Bounds {
                        x: 0.0,
                        y: 0.0,
                        width: 160.0,
                        height: 48.0,
                    },
                    presentation: Presentation {
                        visible: true,
                        opacity: 1.0,
                    },
                    kind: PreparedLayerKind::Text,
                    placement: Affine::IDENTITY.as_coeffs(),
                    content: PreparedContent::Vector(scene),
                    element_frame: None,
                }],
            },
            resources,
        };

        let encoded = bundle.manifest().unwrap().encode().unwrap();
        let manifest = PreparedFrameManifest::decode(&encoded).unwrap();
        let mut resources = PreparedResourceStore::default();
        for reference in manifest.required_resources() {
            let encoded = bundle
                .resource_packet(reference.id)
                .unwrap()
                .encode()
                .unwrap();
            resources.insert(PreparedResourcePacket::decode(&encoded).unwrap());
        }
        let compiled = manifest.compile(&resources).unwrap();
        assert_eq!(compiled.revision(), Revision::new(7));
        assert_eq!(compiled.layers()[0].id(), layer);
        assert!(matches!(
            compiled.composition_commands(1).as_slice(),
            [CompositionCommand::Vector(_)]
        ));
    }

    #[test]
    fn effects_record_ordered_passes_and_a_portable_gradient() {
        let font = FontSystem::new().first_font().unwrap();
        let layout = TextLayout::new(&font)
            .with_font_size(24.0)
            .run("Texto")
            .unwrap();
        let mut scene = PreparedScene::default();
        let mut resources = Vec::new();
        let options = TextRenderOptions {
            color: [1, 2, 3, 255],
            stroke: Some(StrokeOptions {
                color: [4, 5, 6, 255],
                width_px: 2.0,
            }),
            shadow: Some(TextShadow {
                color: [7, 8, 9, 128],
                offset_x: 3.0,
                offset_y: 4.0,
                blur_radius: 0.0,
            }),
            glow: Some(TextGlow {
                color: [10, 11, 12, 128],
                radius: 0.0,
            }),
            gradient: Some(PreparedLinearGradient {
                start: [0.0, 0.0],
                end: [100.0, 0.0],
                start_color: [255, 0, 0, 255],
                end_color: [0, 0, 255, 255],
            }),
            ..TextRenderOptions::default()
        };
        TextRenderer::new().render(
            &mut scene,
            &mut resources,
            &layout,
            WritingMode::Horizontal,
            &options,
            Affine::IDENTITY,
        );

        let colors: Vec<_> = scene
            .commands
            .iter()
            .map(|command| match command {
                PreparedSceneCommand::GlyphRun(run) => run.color,
                _ => unreachable!("text records only glyph runs"),
            })
            .collect();
        assert_eq!(
            colors.as_slice(),
            [
                [7, 8, 9, 128],
                [10, 11, 12, 128],
                [4, 5, 6, 255],
                [1, 2, 3, 255]
            ]
            .as_slice()
        );
        assert!(
            matches!(&scene.commands[3], PreparedSceneCommand::GlyphRun(run) if run.gradient == options.gradient)
        );
    }
}
