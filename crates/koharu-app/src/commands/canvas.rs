use std::sync::Arc;

use anyhow::{Context as _, anyhow, bail};
use image::{GrayImage, ImageEncoder as _, RgbaImage, codecs::png::PngEncoder};
use koharu_desktop::{CanvasState, Desktop, Frame, TransformFrame};
use koharu_rasterizer::{Raster, RasterOptions, ResourceId};
use koharu_renderer::LayerKind;
use koharu_scene::{EntityId, Point as ScenePoint, Revision, Snapshot};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{
    AppHandle, Manager as _, State,
    ipc::{Channel, IpcResponse},
};
use tauri_runtime_cef::CefRuntime;

use super::{
    ChannelExt as _, Error, processing,
    processing::{JobChannel, JobId, Processing},
    project::{CurrentProject, Page, Project, RasterStrokeMode},
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, Type)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Type)]
pub struct PaintBrush {
    pub diameter: f32,
    pub hardness: f32,
    pub color: [u8; 4],
}

#[derive(Clone, Copy, Debug, Serialize, Type)]
pub struct LayerCommit {
    pub revision: Revision,
    pub layer: EntityId,
}

#[derive(Clone, Copy, Debug, Serialize, Type)]
pub struct OcrRegionCommit {
    pub revision: Revision,
    pub layer: EntityId,
    pub job: JobId,
}

#[derive(Type)]
#[specta(transparent)]
pub(crate) struct CanvasBytes(#[specta(type = Vec<u8>)] Vec<u8>);

#[derive(Clone, Copy, Deserialize, Type)]
#[specta(transparent)]
pub(crate) struct CanvasGeneration(#[specta(type = f64)] u64);

#[derive(Clone, Debug, Serialize, Type)]
pub struct CanvasPagePreparation {
    pub revision: Revision,
    pub page: Page,
}

impl IpcResponse for CanvasBytes {
    fn body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        Ok(self.0.into())
    }
}

#[derive(Default)]
pub(crate) struct CanvasChannel {
    pub(crate) channel: Mutex<Option<Channel<CanvasState>>>,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_canvas_manifest(
    generation: CanvasGeneration,
    desktop: State<'_, Desktop>,
) -> Result<CanvasBytes, Error> {
    Ok(CanvasBytes(desktop.frame_manifest_bytes(generation.0)?))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_canvas_resource(
    generation: CanvasGeneration,
    resource: String,
    desktop: State<'_, Desktop>,
) -> Result<CanvasBytes, Error> {
    let resource = resource
        .parse::<ResourceId>()
        .context("canvas resource id is invalid")?;
    Ok(CanvasBytes(
        desktop.frame_resource_bytes(generation.0, resource)?,
    ))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn prepare_canvas_page(
    page: EntityId,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
) -> Result<Option<CanvasPagePreparation>, Error> {
    let (snapshot, prepared_page) = {
        let project = project.project.lock().await;
        let project = project.as_ref().context("no project is open")?;
        let snapshot = project.snapshot();
        let prepared_page = Project::page(&snapshot, page)?;
        (snapshot, prepared_page)
    };
    let revision = snapshot.revision();
    Ok(desktop
        .prepare_page(&snapshot, page)
        .await?
        .then_some(CanvasPagePreparation {
            revision,
            page: prepared_page,
        }))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_canvas_page_manifest(
    page: EntityId,
    revision: Revision,
    desktop: State<'_, Desktop>,
) -> Result<CanvasBytes, Error> {
    Ok(CanvasBytes(desktop.page_manifest_bytes(page, revision)?))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_canvas_page_resource(
    page: EntityId,
    revision: Revision,
    resource: String,
    desktop: State<'_, Desktop>,
) -> Result<CanvasBytes, Error> {
    let resource = resource
        .parse::<ResourceId>()
        .context("canvas resource id is invalid")?;
    Ok(CanvasBytes(
        desktop.page_resource_bytes(page, revision, resource)?,
    ))
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "point_text_added",
    skip_all,
    fields(origin = "user", point_count = 1_u64)
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn add_point_text(
    point: Point,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<LayerCommit, Error> {
    let (commit, page, layer) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let page = project
            .active_page()
            .context("the project has no active page")?;
        let (commit, layer) = project.add_point_text(page, point).await?;
        project.record_commit(&commit);
        (commit, project.active_page(), layer)
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(LayerCommit {
        revision: commit.revision,
        layer,
    })
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "text_box_added",
    skip_all,
    fields(origin = "user", entity_count = 1_u64)
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn add_text_box(
    frame: Frame,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<LayerCommit, Error> {
    let (commit, page, layer) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let page = project
            .active_page()
            .context("the project has no active page")?;
        let (commit, layer) = project.add_text_box(page, frame).await?;
        project.record_commit(&commit);
        (commit, project.active_page(), layer)
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(LayerCommit {
        revision: commit.revision,
        layer,
    })
}

#[tracing::instrument(level = "info", skip_all, fields(layer = %layer))]
#[tauri::command]
#[specta::specta]
pub(crate) async fn rasterize_text(
    expected_revision: Revision,
    layer: EntityId,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<LayerCommit, Error> {
    let (snapshot, page, width, height) = {
        let project = project.project.lock().await;
        let project = project.as_ref().context("no project is open")?;
        let snapshot = project.snapshot();
        ensure_revision(snapshot.revision(), expected_revision)?;
        let page = project
            .active_page()
            .context("the project has no active page")?;
        let size = snapshot.page(page)?.page()?;
        (
            snapshot,
            page,
            size.width.round() as u32,
            size.height.round() as u32,
        )
    };
    let frame = desktop.renderer().render(&snapshot, page).await?;
    let text = frame
        .layer(layer)
        .context("the selected text is not on the active page")?;
    if !matches!(text.kind(), LayerKind::Text(_)) || !text.presentation().visible {
        return Err(anyhow!("select a visible text layer to rasterize").into());
    }
    let opacity = text.presentation().opacity;
    let isolated = frame
        .cropped(layer)?
        .context("the selected text could not be isolated")?;
    let raster_frame = isolated.raster_frame()?;
    let rasterizer = desktop.rasterizer().await?;
    let raster =
        tokio_rayon::spawn(move || rasterizer.rasterize(&raster_frame, RasterOptions::default()))
            .await?;
    let image = place_raster_on_page(raster, width, height);
    let (commit, raster_layer) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        ensure_revision(project.snapshot().revision(), expected_revision)?;
        if project.active_page() != Some(page) {
            return Err(anyhow!("the active page changed during text rasterization").into());
        }
        let (commit, raster_layer) = project
            .rasterize_text_layer(page, layer, image, opacity)
            .await?;
        project.record_commit(&commit);
        (commit, raster_layer)
    };
    desktop
        .synchronize(&commit.snapshot, Some(page), &commit)
        .await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(LayerCommit {
        revision: commit.revision,
        layer: raster_layer,
    })
}

fn place_raster_on_page(raster: Raster, width: u32, height: u32) -> RgbaImage {
    let mut page = RgbaImage::new(width, height);
    for (x, y, pixel) in raster.image.enumerate_pixels() {
        let page_x = i64::from(raster.left) + i64::from(x);
        let page_y = i64::from(raster.top) + i64::from(y);
        if page_x >= 0 && page_y >= 0 && page_x < i64::from(width) && page_y < i64::from(height) {
            page.put_pixel(page_x as u32, page_y as u32, *pixel);
        }
    }
    page
}

#[cfg(test)]
mod rasterize_text_tests {
    use super::*;

    #[test]
    fn cropped_text_pixels_keep_page_coordinates_and_clip_outside_the_page() {
        let mut image = RgbaImage::new(2, 2);
        image.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, image::Rgba([0, 200, 0, 255]));
        let page = place_raster_on_page(
            Raster {
                image,
                left: -1,
                top: 1,
            },
            3,
            3,
        );
        assert_eq!(page.get_pixel(0, 1).0, [0, 200, 0, 255]);
        assert_eq!(page.get_pixel(1, 1).0[3], 0);
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn recognize_selected_region(
    expected_revision: Revision,
    page: EntityId,
    points: Vec<Point>,
    fixed_font_size: Option<f32>,
    angle_degrees: f32,
    handle: AppHandle<CefRuntime>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<OcrRegionCommit, Error> {
    if !handle.state::<Processing>().stops.lock().is_empty() {
        return Err(anyhow!("another process is already running").into());
    }
    let frame = desktop.canvas_frame_for_edit(page, expected_revision)?;
    let (commit, page, region, layer) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        ensure_active_page(project, page)?;
        ensure_canvas_page_size(&project.snapshot(), page, frame.size())?;
        let (commit, region, layer) = project
            .add_manual_ocr_region(page, &points, fixed_font_size, angle_degrees)
            .await?;
        project.record_commit(&commit);
        (commit, project.active_page(), region, layer)
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    let job = processing::process(
        handle.clone(),
        koharu_pipeline::Scope::Entities(vec![region]),
        koharu_pipeline::Operation::Only {
            stage: koharu_pipeline::Stage::Ocr,
        },
        handle.state::<CurrentProject>(),
        handle.state::<Processing>(),
        handle.state::<JobChannel>(),
    )
    .await?;
    Ok(OcrRegionCommit {
        revision: commit.revision,
        layer,
        job,
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn restore_original_region(
    expected_revision: Revision,
    page: EntityId,
    points: Vec<Point>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<Option<Revision>, Error> {
    let frame = desktop.canvas_frame_for_edit(page, expected_revision)?;
    let (commit, page) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        ensure_active_page(project, page)?;
        ensure_canvas_page_size(&project.snapshot(), page, frame.size())?;
        let commit = project.restore_original_region(page, &points).await?;
        if let Some(ref commit) = commit {
            project.record_commit(commit);
        }
        (commit, project.active_page())
    };
    let Some(commit) = commit else {
        return Ok(None);
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(Some(commit.revision))
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "paint_committed",
    skip_all,
    fields(
        origin = "user",
        point_count = points.len(),
        size = f64::from(brush.diameter),
        hardness = f64::from(brush.hardness),
    ),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn commit_paint(
    expected_revision: Revision,
    page: EntityId,
    layer: Option<EntityId>,
    points: Vec<Point>,
    brush: PaintBrush,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<LayerCommit, Error> {
    commit_raster_stroke(
        expected_revision,
        page,
        layer,
        points,
        brush.diameter,
        brush.hardness,
        brush.color,
        RasterStrokeMode::Paint,
        &desktop,
        &project,
        &canvas_channel,
    )
    .await
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "erase_committed",
    skip_all,
    fields(
        origin = "user",
        point_count = points.len(),
        size = f64::from(diameter),
        hardness = f64::from(hardness),
    ),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn commit_erase(
    expected_revision: Revision,
    page: EntityId,
    layer: EntityId,
    points: Vec<Point>,
    diameter: f32,
    hardness: f32,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<LayerCommit, Error> {
    commit_raster_stroke(
        expected_revision,
        page,
        Some(layer),
        points,
        diameter,
        hardness,
        [0; 4],
        RasterStrokeMode::Erase,
        &desktop,
        &project,
        &canvas_channel,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn commit_raster_stroke(
    expected_revision: Revision,
    page: EntityId,
    layer: Option<EntityId>,
    points: Vec<Point>,
    diameter: f32,
    hardness: f32,
    color: [u8; 4],
    mode: RasterStrokeMode,
    desktop: &Desktop,
    project: &CurrentProject,
    canvas_channel: &CanvasChannel,
) -> Result<LayerCommit, Error> {
    let frame = desktop.canvas_frame_for_edit(page, expected_revision)?;
    let (commit, page, element) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        ensure_active_page(project, page)?;
        ensure_canvas_page_size(&project.snapshot(), page, frame.size())?;
        let (commit, element) = project
            .apply_raster_stroke(
                page,
                layer,
                mode,
                color,
                diameter,
                hardness,
                points
                    .into_iter()
                    .map(|point| koharu_scene::Point {
                        x: point.x,
                        y: point.y,
                    })
                    .collect(),
            )
            .await?;
        project.record_commit(&commit);
        (commit, project.active_page(), element)
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(LayerCommit {
        revision: commit.revision,
        layer: element,
    })
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "transform_committed",
    skip_all,
    fields(origin = "user", entity_count = elements.len()),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn commit_transform(
    expected_revision: Revision,
    page: EntityId,
    elements: Vec<TransformFrame>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> Result<Option<Revision>, Error> {
    let frame = desktop.canvas_frame_for_edit(page, expected_revision)?;
    let geometries = desktop.transform_geometries(&frame, &elements)?;
    if geometries.is_empty() {
        return Ok(None);
    }
    let (commit, page) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        ensure_active_page(project, page)?;
        ensure_canvas_page_size(&project.snapshot(), page, frame.size())?;
        let commit = project.set_geometries(geometries).await?;
        project.record_commit(&commit);
        (commit, project.active_page())
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(Some(commit.revision))
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "inpaint_requested",
    skip_all,
    fields(origin = "user", point_count = points.len(), size = f64::from(diameter)),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn commit_inpaint(
    expected_revision: Revision,
    page: EntityId,
    points: Vec<Point>,
    diameter: f32,
    handle: AppHandle<CefRuntime>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
) -> Result<Option<JobId>, Error> {
    if !diameter.is_finite() || diameter <= 0.0 || points.is_empty() {
        return Err(anyhow!(
            "an inpaint stroke requires a positive diameter and at least one point"
        )
        .into());
    }
    if points
        .iter()
        .any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        return Err(anyhow!("inpaint stroke points must be finite").into());
    }
    let frame = desktop.canvas_frame_for_edit(page, expected_revision)?;
    let (width, height) = {
        let project = project.project.lock().await;
        let project = project.as_ref().context("no project is open")?;
        let snapshot = project.snapshot();
        ensure_active_page(project, page)?;
        ensure_canvas_page_size(&snapshot, page, frame.size())?;
        frame.size()
    };
    let (png, bounds) =
        tokio_rayon::spawn(move || encode_mask(width, height, &points, diameter)).await?;
    Ok(Some(
        processing::process_with_inpainting_mask(
            handle.clone(),
            page,
            [width, height],
            koharu_pipeline::Scope::Region { page, bounds },
            koharu_pipeline::Operation::Only {
                stage: koharu_pipeline::Stage::Inpainting,
            },
            koharu_pipeline::InpaintingMask {
                page,
                png: Arc::from(png),
            },
            project.inner(),
            handle.state::<Processing>().inner(),
            handle.state::<JobChannel>().inner(),
        )
        .await?,
    ))
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "inpaint_region_requested",
    skip_all,
    fields(origin = "user", point_count = points.len()),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn commit_inpaint_region(
    expected_revision: Revision,
    page: EntityId,
    points: Vec<Point>,
    handle: AppHandle<CefRuntime>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
) -> Result<Option<JobId>, Error> {
    let frame = desktop.canvas_frame_for_edit(page, expected_revision)?;
    let (width, height, polygon) = {
        let project = project.project.lock().await;
        let project = project.as_ref().context("no project is open")?;
        let snapshot = project.snapshot();
        ensure_active_page(project, page)?;
        ensure_canvas_page_size(&snapshot, page, frame.size())?;
        let page_value = snapshot.page(page)?.page()?;
        let polygon = Project::selection_geometry(&points, page_value.width, page_value.height)?;
        let (width, height) = frame.size();
        (width, height, polygon.points)
    };
    let (png, bounds) =
        tokio_rayon::spawn(move || encode_polygon_mask(width, height, &polygon)).await?;
    let job = processing::process_with_inpainting_mask(
        handle.clone(),
        page,
        [width, height],
        koharu_pipeline::Scope::Region { page, bounds },
        koharu_pipeline::Operation::Only {
            stage: koharu_pipeline::Stage::Inpainting,
        },
        koharu_pipeline::InpaintingMask {
            page,
            png: Arc::from(png),
        },
        project.inner(),
        handle.state::<Processing>().inner(),
        handle.state::<JobChannel>().inner(),
    )
    .await?;
    Ok(Some(job))
}

fn ensure_revision(actual: Revision, expected: Revision) -> anyhow::Result<()> {
    if actual != expected {
        bail!("canvas edit expected revision {expected}, but the project is at {actual}");
    }
    Ok(())
}

fn ensure_active_page(project: &Project, page: EntityId) -> anyhow::Result<()> {
    if project.active_page() != Some(page) {
        bail!("active page changed while the canvas edit was in progress");
    }
    Ok(())
}

fn ensure_canvas_page_size(
    snapshot: &Snapshot,
    page: EntityId,
    frame_size: (u32, u32),
) -> anyhow::Result<()> {
    let size = snapshot.page(page)?.page()?;
    let current_size = (size.width.round() as u32, size.height.round() as u32);
    if current_size != frame_size {
        bail!("page dimensions changed while the canvas edit was in progress");
    }
    Ok(())
}

fn encode_mask(
    width: u32,
    height: u32,
    points: &[Point],
    diameter: f32,
) -> anyhow::Result<(Vec<u8>, koharu_pipeline::Bounds)> {
    if width == 0 || height == 0 {
        bail!("page dimensions must be positive");
    }
    let mut image = GrayImage::new(width, height);
    let radius = f64::from(diameter) * 0.5;
    let mut dirty = None::<[u32; 4]>;
    for (start, end) in points
        .iter()
        .zip(points.iter().skip(1))
        .chain(points.last().map(|point| (point, point)))
    {
        let left = (start.x.min(end.x) - radius - 0.5).floor().max(0.0) as u32;
        let top = (start.y.min(end.y) - radius - 0.5).floor().max(0.0) as u32;
        let right = (start.x.max(end.x) + radius + 0.5)
            .ceil()
            .min(f64::from(width)) as u32;
        let bottom = (start.y.max(end.y) + radius + 0.5)
            .ceil()
            .min(f64::from(height)) as u32;
        let dx = end.x - start.x;
        let dy = end.y - start.y;
        let length_squared = dx.mul_add(dx, dy * dy);
        for y in top..bottom {
            for x in left..right {
                let px = f64::from(x) + 0.5;
                let py = f64::from(y) + 0.5;
                let progress = if length_squared <= f64::EPSILON {
                    0.0
                } else {
                    (((px - start.x) * dx + (py - start.y) * dy) / length_squared).clamp(0.0, 1.0)
                };
                let nearest_x = start.x + progress * dx;
                let nearest_y = start.y + progress * dy;
                let distance = (px - nearest_x).hypot(py - nearest_y);
                let coverage = ((radius + 0.5 - distance).clamp(0.0, 1.0) * 255.0).round() as u8;
                if coverage == 0 {
                    continue;
                }
                let pixel = image.get_pixel_mut(x, y);
                pixel.0[0] = pixel.0[0].max(coverage);
                dirty = Some(match dirty {
                    Some([min_x, min_y, max_x, max_y]) => {
                        [min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y)]
                    }
                    None => [x, y, x, y],
                });
            }
        }
    }
    let [left, top, right, bottom] = dirty.context("inpaint stroke does not intersect the page")?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png).write_image(
        image.as_raw(),
        width,
        height,
        image::ExtendedColorType::L8,
    )?;
    Ok((
        png,
        koharu_pipeline::Bounds {
            x: f64::from(left),
            y: f64::from(top),
            width: f64::from(right - left + 1),
            height: f64::from(bottom - top + 1),
        },
    ))
}

fn encode_polygon_mask(
    width: u32,
    height: u32,
    polygon: &[ScenePoint],
) -> anyhow::Result<(Vec<u8>, koharu_pipeline::Bounds)> {
    if width == 0 || height == 0 {
        bail!("page dimensions must be positive");
    }
    let top = polygon
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let bottom = polygon
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    let first_y = (top - 0.5).ceil().max(0.0) as u32;
    let last_y = (bottom - 0.5).ceil().min(f64::from(height)) as u32;
    let mut image = GrayImage::new(width, height);
    let mut dirty = None::<[u32; 4]>;
    let mut intersections = Vec::with_capacity(polygon.len());
    for y in first_y..last_y {
        intersections.clear();
        let scan_y = f64::from(y) + 0.5;
        let mut previous = polygon[polygon.len() - 1];
        for &current in polygon {
            if (previous.y > scan_y) != (current.y > scan_y) {
                intersections.push(
                    previous.x
                        + (current.x - previous.x) * (scan_y - previous.y)
                            / (current.y - previous.y),
                );
            }
            previous = current;
        }
        intersections.sort_by(f64::total_cmp);
        for pair in intersections.chunks_exact(2) {
            let first_x = (pair[0] - 0.5).ceil().max(0.0) as u32;
            let last_x = (pair[1] - 0.5).ceil().min(f64::from(width)) as u32;
            for x in first_x..last_x {
                image.get_pixel_mut(x, y).0[0] = 255;
                dirty = Some(match dirty {
                    Some([min_x, min_y, max_x, max_y]) => {
                        [min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y)]
                    }
                    None => [x, y, x, y],
                });
            }
        }
    }
    let [left, top, right, bottom] = dirty.context("polygon selection covers no page pixels")?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png).write_image(
        image.as_raw(),
        width,
        height,
        image::ExtendedColorType::L8,
    )?;
    Ok((
        png,
        koharu_pipeline::Bounds {
            x: f64::from(left),
            y: f64::from(top),
            width: f64::from(right - left + 1),
            height: f64::from(bottom - top + 1),
        },
    ))
}

#[cfg(test)]
mod polygon_mask_tests {
    use super::*;

    #[test]
    fn polygon_mask_only_covers_the_selected_area() {
        let polygon = [
            ScenePoint { x: 1.0, y: 1.0 },
            ScenePoint { x: 5.0, y: 1.0 },
            ScenePoint { x: 5.0, y: 5.0 },
            ScenePoint { x: 1.0, y: 5.0 },
        ];
        let (png, bounds) = encode_polygon_mask(8, 8, &polygon).unwrap();
        let mask = image::load_from_memory(&png).unwrap().to_luma8();

        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (1.0, 1.0, 4.0, 4.0)
        );
        assert_eq!(mask.get_pixel(1, 1).0[0], 255);
        assert_eq!(mask.get_pixel(4, 4).0[0], 255);
        assert_eq!(mask.get_pixel(5, 2).0[0], 0);
        assert_eq!(mask.get_pixel(2, 5).0[0], 0);
        assert_eq!(mask.get_pixel(0, 0).0[0], 0);
    }
}
