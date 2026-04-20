use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const PROJECT_META_FILENAME: &str = "project.json";
const MODULE_STATE_FILE: &str = "module-state.json";
const DIR_IMPORT: &str = "导入文件";
const DIR_TEMPLATE: &str = "配置模板";
const DIR_EXPORT: &str = "导出文件";
const PREFIX_SOURCE: &str = "源文件";
const PREFIX_PKG_TPL: &str = "分包数量配置";
const PREFIX_SPLIT_TPL: &str = "拆分方式配置";
const PREFIX_RESULT: &str = "拆分结果";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub id: String,
    pub project_number: String,
    pub category: String,
    pub created_at: String,
    pub directory_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMetaDto {
    pub version: u32,
    pub project: ProjectDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirroredFileDto {
    pub file_name: String,
    pub data: Vec<u8>,
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|err| format!("创建目录失败 {}: {}", path.display(), err))
}

fn write_bytes(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    fs::write(path, data).map_err(|err| format!("写入文件失败 {}: {}", path.display(), err))
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    write_bytes(path, text.as_bytes())
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| format!("读取文本失败 {}: {}", path.display(), err))
}

fn module_base(project_dir: &str, module_sub_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(module_sub_dir)
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    chrono_like_timestamp(now)
}

fn chrono_like_timestamp(unix_secs: u64) -> String {
    const SECS_PER_DAY: u64 = 86_400;
    let days = unix_secs / SECS_PER_DAY;
    let secs_of_day = unix_secs % SECS_PER_DAY;

    let (year, month, day) = civil_from_days(days as i64);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    format!(
        "{year:04}{month:02}{day:02}_{hour:02}{minute:02}{second:02}",
        year = year,
        month = month,
        day = day,
        hour = hour,
        minute = minute,
        second = second
    )
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };

    (year as i32, m as u32, d as u32)
}

fn stamped_name(prefix: &str, ext: &str) -> String {
    format!("{}_{}{}", prefix, timestamp(), ext)
}

fn clear_by_prefix(dir: &Path, prefix: &str) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("读取目录失败 {}: {}", dir.display(), err))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("读取目录项失败: {}", err))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with(prefix) {
            fs::remove_file(&path)
                .map_err(|err| format!("删除旧文件失败 {}: {}", path.display(), err))?;
        }
    }
    Ok(())
}

fn normalize_extension(ext: &str, fallback: &str) -> String {
    let mut cleaned: String = ext
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '.')
        .collect();
    if cleaned.is_empty() {
        return fallback.to_string();
    }
    if !cleaned.starts_with('.') {
        cleaned.insert(0, '.');
    }
    cleaned
}

fn mirror_file(
    project_dir: &str,
    module_sub_dir: &str,
    dir_name: &str,
    prefix: &str,
    ext: &str,
    data: &[u8],
) -> Result<(), String> {
    let dir_path = module_base(project_dir, module_sub_dir).join(dir_name);
    ensure_dir(&dir_path)?;
    clear_by_prefix(&dir_path, prefix)?;
    let target = dir_path.join(stamped_name(prefix, &normalize_extension(ext, ".xlsx")));
    write_bytes(&target, data)
}

#[tauri::command]
pub fn create_project_dir(project: ProjectDto) -> Result<(), String> {
    let project_dir = PathBuf::from(&project.directory_path);
    ensure_dir(&project_dir)?;
    let meta = ProjectMetaDto { version: 1, project };
    let meta_path = project_dir.join(PROJECT_META_FILENAME);
    let raw = serde_json::to_string_pretty(&meta).map_err(|err| format!("序列化项目配置失败: {}", err))?;
    write_text(&meta_path, &raw)
}

#[tauri::command]
pub fn read_project_meta(dir_path: String) -> Result<Option<ProjectMetaDto>, String> {
    let meta_path = PathBuf::from(dir_path).join(PROJECT_META_FILENAME);
    if !meta_path.exists() {
        return Ok(None);
    }
    let raw = read_text(&meta_path)?;
    let meta = serde_json::from_str::<ProjectMetaDto>(&raw)
        .map_err(|err| format!("解析项目配置失败 {}: {}", meta_path.display(), err))?;
    Ok(Some(meta))
}

#[tauri::command]
pub fn update_project_meta(project: ProjectDto) -> Result<(), String> {
    create_project_dir(project)
}

#[tauri::command]
pub fn ensure_module_dirs(project_dir: String, module_sub_dir: String) -> Result<(), String> {
    let base = module_base(&project_dir, &module_sub_dir);
    ensure_dir(&base.join(DIR_IMPORT))?;
    ensure_dir(&base.join(DIR_TEMPLATE))?;
    ensure_dir(&base.join(DIR_EXPORT))?;
    Ok(())
}

#[tauri::command]
pub fn mirror_import_file(
    project_dir: String,
    module_sub_dir: String,
    ext: String,
    data: Vec<u8>,
) -> Result<(), String> {
    mirror_file(&project_dir, &module_sub_dir, DIR_IMPORT, PREFIX_SOURCE, &ext, &data)
}

#[tauri::command]
pub fn mirror_template_file(
    project_dir: String,
    module_sub_dir: String,
    template_type: String,
    ext: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let prefix = match template_type.as_str() {
        "pkg" => PREFIX_PKG_TPL,
        "split" => PREFIX_SPLIT_TPL,
        other => return Err(format!("不支持的模板类型: {}", other)),
    };
    mirror_file(&project_dir, &module_sub_dir, DIR_TEMPLATE, prefix, &ext, &data)
}

#[tauri::command]
pub fn mirror_export_result(
    project_dir: String,
    module_sub_dir: String,
    data: Vec<u8>,
) -> Result<(), String> {
    mirror_file(
        &project_dir,
        &module_sub_dir,
        DIR_EXPORT,
        PREFIX_RESULT,
        ".xlsx",
        &data,
    )
}

#[tauri::command]
pub fn save_module_state(
    project_dir: String,
    module_sub_dir: String,
    state_json: String,
) -> Result<(), String> {
    let file_path = module_base(&project_dir, &module_sub_dir).join(MODULE_STATE_FILE);
    write_text(&file_path, &state_json)
}

#[tauri::command]
pub fn load_module_state(
    project_dir: String,
    module_sub_dir: String,
) -> Result<Option<String>, String> {
    let file_path = module_base(&project_dir, &module_sub_dir).join(MODULE_STATE_FILE);
    if !file_path.exists() {
        return Ok(None);
    }
    Ok(Some(read_text(&file_path)?))
}

#[tauri::command]
pub fn load_latest_import_file(
    project_dir: String,
    module_sub_dir: String,
) -> Result<Option<MirroredFileDto>, String> {
    let dir_path = module_base(&project_dir, &module_sub_dir).join(DIR_IMPORT);
    if !dir_path.exists() {
        return Ok(None);
    }

    let mut names: Vec<String> = fs::read_dir(&dir_path)
        .map_err(|err| format!("读取导入目录失败 {}: {}", dir_path.display(), err))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(PREFIX_SOURCE))
        .collect();

    names.sort_by(|a, b| b.cmp(a));
    let Some(file_name) = names.into_iter().next() else {
        return Ok(None);
    };

    let file_path = dir_path.join(&file_name);
    let data = fs::read(&file_path)
        .map_err(|err| format!("读取导入文件失败 {}: {}", file_path.display(), err))?;

    Ok(Some(MirroredFileDto { file_name, data }))
}