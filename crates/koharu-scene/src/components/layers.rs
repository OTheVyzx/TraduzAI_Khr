use std::collections::BTreeMap;

use revision::revisioned;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    Error, Result,
    component::{Component, ValidationContext},
    id::validate_namespaced,
};

use super::Origin;

#[revisioned(revision = 1)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RasterLayerKind {
    Cleanup,
    Paint,
}

/// A full-page transparent pixel layer composited above the page source.
#[revisioned(revision = 1)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct RasterLayer {
    pub origin: Origin,
    pub name: String,
    pub kind: RasterLayerKind,
}

impl Component for RasterLayer {
    const KIND: &'static str = "dev.koharu.layer.raster";

    fn validate(&self, _context: &ValidationContext<'_>) -> Result<()> {
        self.origin.validate()?;
        if self.name.is_empty() || self.name.len() > 4096 || self.name.contains('\0') {
            return Err(Error::invalid("raster layer name is invalid"));
        }
        Ok(())
    }

    fn origin(&self) -> Option<&Origin> {
        Some(&self.origin)
    }

    fn set_origin(&mut self, origin: Origin) -> bool {
        self.origin = origin;
        true
    }
}

#[revisioned(revision = 1)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TextLayoutKind {
    Point,
    Paragraph,
}

#[revisioned(revision = 2)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct TextLayout {
    pub origin: Origin,
    pub kind: TextLayoutKind,
    /// Overrides the axes inferred from geometry when a frame is transformed.
    #[revision(start = 2)]
    pub angle_degrees: Option<f32>,
}

impl Component for TextLayout {
    const KIND: &'static str = "dev.koharu.layer.text";

    fn validate(&self, _context: &ValidationContext<'_>) -> Result<()> {
        if self.angle_degrees.is_some_and(|angle| !angle.is_finite()) {
            return Err(Error::invalid("text layout angle must be finite"));
        }
        self.origin.validate()
    }

    fn origin(&self) -> Option<&Origin> {
        Some(&self.origin)
    }

    fn set_origin(&mut self, origin: Origin) -> bool {
        self.origin = origin;
        true
    }
}

#[revisioned(revision = 1)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
pub enum TextAlignment {
    Start,
    Center,
    End,
    Justify,
}

#[revisioned(revision = 1)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
pub enum WritingMode {
    Horizontal,
    Vertical,
}

#[revisioned(revision = 1)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

#[revisioned(revision = 1)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TextPlacement {
    OriginalText,
    Balloon,
    Manual,
}

#[revisioned(revision = 1)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct TextShadow {
    pub color: [u8; 4],
    pub offset_x: f32,
    pub offset_y: f32,
    pub blur_radius: f32,
}

#[revisioned(revision = 1)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct TextGlow {
    pub color: [u8; 4],
    pub radius: f32,
}

#[revisioned(revision = 1)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct TextGradient {
    pub start_color: [u8; 4],
    pub end_color: [u8; 4],
    pub angle_degrees: f32,
}

#[revisioned(revision = 3)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct Typography {
    pub origin: Origin,
    pub preferred_font: Option<String>,
    pub font_weight: Option<u16>,
    pub font_style: Option<FontStyle>,
    pub size: Option<f32>,
    pub auto_fit: bool,
    pub color: Option<[u8; 4]>,
    pub stroke_color: Option<[u8; 4]>,
    pub stroke_width: Option<f32>,
    pub alignment: Option<TextAlignment>,
    pub writing_mode: Option<WritingMode>,
    #[revision(start = 2)]
    pub placement: Option<TextPlacement>,
    #[revision(start = 2)]
    pub shear_x: Option<f32>,
    #[revision(start = 3)]
    pub shear_y: Option<f32>,
    #[revision(start = 2)]
    pub shadow: Option<TextShadow>,
    #[revision(start = 2)]
    pub glow: Option<TextGlow>,
    #[revision(start = 2)]
    pub gradient: Option<TextGradient>,
    pub extensions: BTreeMap<String, String>,
}

impl Component for Typography {
    const KIND: &'static str = "dev.koharu.text.typography";

    fn validate(&self, _context: &ValidationContext<'_>) -> Result<()> {
        if self
            .preferred_font
            .as_ref()
            .is_some_and(|font| font.len() > 4096)
            || self
                .font_weight
                .is_some_and(|weight| !(1..=1000).contains(&weight))
            || self
                .size
                .is_some_and(|size| !size.is_finite() || size <= 0.0)
            || (!self.auto_fit && self.size.is_none())
            || self
                .stroke_width
                .is_some_and(|width| !width.is_finite() || width < 0.0)
            || self
                .shear_x
                .is_some_and(|shear| !shear.is_finite() || shear.abs() > 4.0)
            || self
                .shear_y
                .is_some_and(|shear| !shear.is_finite() || shear.abs() > 4.0)
            || self.shadow.as_ref().is_some_and(|shadow| {
                !shadow.offset_x.is_finite()
                    || !shadow.offset_y.is_finite()
                    || shadow.offset_x.abs() > 10_000.0
                    || shadow.offset_y.abs() > 10_000.0
                    || !shadow.blur_radius.is_finite()
                    || shadow.blur_radius < 0.0
                    || shadow.blur_radius > 128.0
            })
            || self.glow.as_ref().is_some_and(|glow| {
                !glow.radius.is_finite() || !(0.0..=128.0).contains(&glow.radius)
            })
            || self.gradient.as_ref().is_some_and(|gradient| {
                !gradient.angle_degrees.is_finite() || gradient.angle_degrees.abs() > 3600.0
            })
        {
            return Err(Error::invalid("typography intent is invalid"));
        }
        self.origin.validate()?;
        if self.extensions.len() > 1024
            || self.extensions.iter().any(|(key, value)| {
                validate_namespaced(key, "typography extension").is_err()
                    || value.len() > 64 * 1024
                    || value.contains('\0')
            })
        {
            return Err(Error::invalid("typography extensions are invalid"));
        }
        Ok(())
    }

    fn origin(&self) -> Option<&Origin> {
        Some(&self.origin)
    }

    fn set_origin(&mut self, origin: Origin) -> bool {
        self.origin = origin;
        true
    }
}
