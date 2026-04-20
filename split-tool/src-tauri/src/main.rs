#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project_fs;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            project_fs::create_project_dir,
            project_fs::read_project_meta,
            project_fs::update_project_meta,
            project_fs::ensure_module_dirs,
            project_fs::mirror_import_file,
            project_fs::mirror_template_file,
            project_fs::mirror_export_result,
            project_fs::save_module_state,
            project_fs::load_module_state,
            project_fs::load_latest_import_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
