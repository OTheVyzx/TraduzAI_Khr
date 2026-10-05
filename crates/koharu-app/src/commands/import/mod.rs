use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context as _, Result, bail};
use image::{DynamicImage, GenericImage, GenericImageView, ImageFormat, ImageReader, RgbaImage};
use rayon::prelude::*;
use strum::{EnumIter, EnumMessage, EnumString};

mod pdf;
mod rar;
mod zip;

#[derive(Clone, Copy, EnumIter, EnumMessage, EnumString)]
#[strum(ascii_case_insensitive)]
pub(super) enum Format {
    #[strum(
        serialize = "png",
        serialize = "jpg",
        serialize = "jpeg",
        serialize = "webp"
    )]
    Raster,
    #[strum(serialize = "cbz", serialize = "zip")]
    Zip,
    #[strum(serialize = "rar")]
    Rar,
    #[strum(serialize = "pdf")]
    Pdf,
}

#[derive(Debug)]
pub(super) struct EncodedPage {
    pub(super) name: String,
    pub(super) bytes: Vec<u8>,
}

pub(super) struct Page {
    pub(super) name: String,
    pub(super) bytes: Arc<[u8]>,
    pub(super) format: ImageFormat,
    pub(super) width: u32,
    pub(super) height: u32,
    sequence_group: PathBuf,
}

fn decode(path: &Path, sequence_group: &Path, source: EncodedPage) -> Result<Page> {
    let EncodedPage { name, bytes } = source;
    let format = image::guess_format(&bytes).with_context(|| {
        format!(
            "failed to identify imported image {} ({name})",
            path.display()
        )
    })?;
    let (width, height) = ImageReader::with_format(Cursor::new(bytes.as_slice()), format)
        .into_dimensions()
        .with_context(|| {
            format!(
                "failed to read dimensions of imported image {} ({name})",
                path.display()
            )
        })?;
    Ok(Page {
        name,
        bytes: Arc::<[u8]>::from(bytes),
        format,
        width,
        height,
        sequence_group: sequence_group.to_owned(),
    })
}

fn numbered_name(name: &str) -> Option<(&str, u64)> {
    let file_name = Path::new(name).file_name()?.to_str()?;
    let stem = Path::new(file_name).file_stem()?.to_str()?;
    let digit_start = stem
        .char_indices()
        .rev()
        .take_while(|(_, character)| character.is_ascii_digit())
        .last()
        .map(|(index, _)| index)?;
    let digits = &stem[digit_start..];
    Some((&stem[..digit_start], digits.parse().ok()?))
}

fn quiet_rows(image: &DynamicImage) -> Vec<bool> {
    let allowed_ink = (image.width() as f32 * 0.005).round() as u32;
    (0..image.height())
        .map(|y| {
            let mut ink = 0;
            for x in 0..image.width() {
                let pixel = image.get_pixel(x, y).0;
                let luminance = (u32::from(pixel[0]) * 299
                    + u32::from(pixel[1]) * 587
                    + u32::from(pixel[2]) * 114)
                    / 1000;
                if luminance < 192 {
                    ink += 1;
                    if ink > allowed_ink {
                        return false;
                    }
                }
            }
            true
        })
        .collect()
}

fn seam_is_continuous(image: &DynamicImage, seam: u32) -> bool {
    if seam == 0 || seam >= image.height() {
        return false;
    }
    let sample_step = image.width().div_ceil(256).max(1);
    let mut difference = 0u64;
    let mut samples = 0u64;
    for x in (0..image.width()).step_by(sample_step as usize) {
        let before = image.get_pixel(x, seam - 1).0;
        let after = image.get_pixel(x, seam).0;
        for channel in 0..3 {
            difference += u64::from(before[channel].abs_diff(after[channel]));
            samples += 255;
        }
    }
    samples > 0 && difference as f32 / samples as f32 <= 0.15
}

fn safer_seam(image: &DynamicImage, seam: u32) -> Option<u32> {
    let height = image.height();
    if !seam_is_continuous(image, seam) {
        return None;
    }
    let radius = image.width().min(height / 3).max(1);
    let lower = seam.saturating_sub(radius).max(1);
    let upper = seam.saturating_add(radius).min(height.saturating_sub(1));
    if lower >= upper {
        return None;
    }

    let quiet = quiet_rows(image);
    let safety_band = (image.width() as f32 * 0.02).round() as u32;
    let is_safe = |y: u32| {
        let start = y.saturating_sub(safety_band) as usize;
        let end = y.saturating_add(safety_band).min(height - 1) as usize;
        quiet[start..=end].iter().all(|&row| row)
    };
    if is_safe(seam) {
        return None;
    }
    let candidate = (lower..=upper)
        .filter(|&y| is_safe(y))
        .min_by_key(|&y| y.abs_diff(seam))?;

    (candidate != seam).then_some(candidate)
}

fn encode_page_image(format: ImageFormat, image: DynamicImage) -> Result<(Arc<[u8]>, u32, u32)> {
    let mut encoded = Cursor::new(Vec::new());
    image.write_to(&mut encoded, format)?;
    Ok((
        Arc::<[u8]>::from(encoded.into_inner()),
        image.width(),
        image.height(),
    ))
}

fn adjust_sequence_seams(pages: &mut [Page]) {
    for index in 0..pages.len().saturating_sub(1) {
        let Some((prefix, number)) = numbered_name(&pages[index].name) else {
            continue;
        };
        let Some((next_prefix, next_number)) = numbered_name(&pages[index + 1].name) else {
            continue;
        };
        if prefix != next_prefix
            || next_number != number.saturating_add(1)
            || pages[index].sequence_group != pages[index + 1].sequence_group
            || pages[index].width != pages[index + 1].width
        {
            continue;
        }

        let first = match ImageReader::with_format(
            Cursor::new(pages[index].bytes.as_ref()),
            pages[index].format,
        )
        .decode()
        {
            Ok(image) => image,
            Err(error) => {
                tracing::warn!(%error, page = %pages[index].name, "could not inspect imported page seam");
                continue;
            }
        };
        let second = match ImageReader::with_format(
            Cursor::new(pages[index + 1].bytes.as_ref()),
            pages[index + 1].format,
        )
        .decode()
        {
            Ok(image) => image,
            Err(error) => {
                tracing::warn!(%error, page = %pages[index + 1].name, "could not inspect imported page seam");
                continue;
            }
        };
        if first.width() != second.width() {
            continue;
        }

        let seam = first.height();
        let mut combined = RgbaImage::new(first.width(), first.height() + second.height());
        if combined.copy_from(&first.to_rgba8(), 0, 0).is_err()
            || combined.copy_from(&second.to_rgba8(), 0, seam).is_err()
        {
            continue;
        }
        let combined = DynamicImage::ImageRgba8(combined);
        let Some(new_seam) = safer_seam(&combined, seam) else {
            continue;
        };

        let first_part = combined.crop_imm(0, 0, combined.width(), new_seam);
        let second_part =
            combined.crop_imm(0, new_seam, combined.width(), combined.height() - new_seam);
        let encoded_first = encode_page_image(pages[index].format, first_part);
        let encoded_second = encode_page_image(pages[index + 1].format, second_part);
        match (encoded_first, encoded_second) {
            (
                Ok((first_bytes, first_width, first_height)),
                Ok((second_bytes, second_width, second_height)),
            ) => {
                pages[index].bytes = first_bytes;
                pages[index].width = first_width;
                pages[index].height = first_height;
                pages[index + 1].bytes = second_bytes;
                pages[index + 1].width = second_width;
                pages[index + 1].height = second_height;
                tracing::info!(
                    target = "koharu_metrics",
                    metric = "import_page_seam_adjusted",
                    previous_page = %pages[index].name,
                    next_page = %pages[index + 1].name,
                    pixels = seam.abs_diff(new_seam),
                );
            }
            (Err(error), _) | (_, Err(error)) => {
                tracing::warn!(%error, seam, new_seam, "could not save adjusted imported page seam");
            }
        }
    }
}

pub(super) fn import(mut paths: Vec<PathBuf>) -> Result<Vec<Page>> {
    alphanumeric_sort::sort_slice_by_os_str_key(&mut paths, |path| {
        path.file_name().unwrap_or_else(|| path.as_os_str())
    });
    let mut groups = paths
        .into_par_iter()
        .map(|path| -> Result<Vec<Page>> {
            let extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .and_then(|extension| extension.parse::<Format>().ok());
            let sequence_group = match extension {
                Some(Format::Raster) => path.parent().unwrap_or(&path).to_owned(),
                _ => path.clone(),
            };
            let encoded = match extension {
                Some(Format::Raster) => vec![EncodedPage {
                    name: path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "page".to_owned()),
                    bytes: fs::read(&path)
                        .with_context(|| format!("failed to read {}", path.display()))?,
                }],
                Some(Format::Zip) => zip::extract(&path)?,
                Some(Format::Rar) => rar::extract(&path)?,
                Some(Format::Pdf) => pdf::render(&path)?,
                None => bail!("unsupported page import path {}", path.display()),
            };
            encoded
                .into_iter()
                .map(|source| decode(&path, &sequence_group, source))
                .collect()
        })
        .collect::<Result<Vec<_>>>()?;
    let page_count = groups.iter().map(Vec::len).sum();
    let mut pages = Vec::with_capacity(page_count);
    for group in &mut groups {
        pages.append(group);
    }
    adjust_sequence_seams(&mut pages);
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_pixels_do_not_crash_seam_analysis() {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            2,
            2,
            image::Rgba([255, 255, 255, 255]),
        ));
        assert_eq!(quiet_rows(&image), vec![true; 2]);
    }

    #[test]
    #[ignore = "set KOHARU_IMPORT_FIXTURE_DIR to a numbered image folder"]
    fn numbered_image_folder_imports_and_keeps_all_rows() {
        use std::hash::Hasher as _;

        let directory = PathBuf::from(
            std::env::var_os("KOHARU_IMPORT_FIXTURE_DIR").expect("fixture directory is set"),
        );
        let requested_names = std::env::var("KOHARU_IMPORT_FIXTURE_NAMES").ok();
        let mut paths = fs::read_dir(directory)
            .expect("read fixture directory")
            .map(|entry| entry.expect("read fixture entry").path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "webp")
                    && requested_names.as_ref().is_none_or(|names| {
                        path.file_name().is_some_and(|name| {
                            names.split(',').any(|requested| name == requested.trim())
                        })
                    })
            })
            .collect::<Vec<_>>();
        alphanumeric_sort::sort_slice_by_os_str_key(&mut paths, |path| {
            path.file_name().unwrap_or_else(|| path.as_os_str())
        });
        let original_sizes = paths
            .iter()
            .map(|path| image::image_dimensions(path).expect("read fixture dimensions"))
            .collect::<Vec<_>>();
        let mut original_pixels = std::collections::hash_map::DefaultHasher::new();
        for path in &paths {
            let decoded = ImageReader::open(path)
                .expect("open fixture page")
                .decode()
                .expect("decode fixture page")
                .to_rgba8();
            original_pixels.write(decoded.as_raw());
        }

        let pages = import(paths).expect("import fixture pages");
        assert_eq!(pages.len(), original_sizes.len());
        assert_eq!(
            pages.iter().map(|page| u64::from(page.height)).sum::<u64>(),
            original_sizes
                .iter()
                .map(|(_, height)| u64::from(*height))
                .sum::<u64>()
        );
        let mut imported_pixels = std::collections::hash_map::DefaultHasher::new();
        for page in &pages {
            let decoded = ImageReader::with_format(Cursor::new(page.bytes.as_ref()), page.format)
                .decode()
                .expect("decode imported page");
            assert_eq!(decoded.dimensions(), (page.width, page.height));
            imported_pixels.write(decoded.to_rgba8().as_raw());
        }
        assert_eq!(original_pixels.finish(), imported_pixels.finish());
        eprintln!(
            "heights before/after: {:?}",
            pages
                .iter()
                .zip(original_sizes)
                .map(|(page, (_, height))| (page.name.as_str(), height, page.height))
                .collect::<Vec<_>>()
        );
        if let Some(output_dir) = std::env::var_os("KOHARU_IMPORT_REVIEW_DIR") {
            let output_dir = PathBuf::from(output_dir);
            fs::create_dir_all(&output_dir).expect("create review directory");
            for page in &pages {
                fs::write(output_dir.join(&page.name), page.bytes.as_ref())
                    .expect("write imported review page");
            }
        }
    }

    #[test]
    fn top_level_paths_are_naturally_sorted() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "koharu-import-order-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create fixture directory");
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 255]));
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, ImageFormat::Png)
            .expect("encode fixture");
        let paths = ["page10.PNG", "page2.png", "page1.png"].map(|name| directory.join(name));
        for path in &paths {
            fs::write(path, encoded.get_ref()).expect("write fixture");
        }

        let pages = import(paths.into()).expect("import fixtures");
        fs::remove_dir_all(&directory).expect("remove fixture directory");
        assert_eq!(
            pages
                .iter()
                .map(|page| page.name.as_str())
                .collect::<Vec<_>>(),
            ["page1.png", "page2.png", "page10.PNG"]
        );
    }
}
