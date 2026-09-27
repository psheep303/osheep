use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn user_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn codex_personal_paths(home: &Path) -> (PathBuf, PathBuf) {
    (
        std::env::var_os("OSHEEP_CODEX_PERSONAL_PLUGIN_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("plugins")),
        std::env::var_os("OSHEEP_CODEX_PERSONAL_MARKETPLACE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                home.join(".agents")
                    .join("plugins")
                    .join("marketplace.json")
            }),
    )
}

pub(crate) async fn claude_snapshot() -> Value {
    claude_snapshot_from(&user_home()).await
}

pub(crate) async fn codex_snapshot() -> Value {
    let home = std::env::var_os("CODEX_HOME")
        .or_else(|| std::env::var_os("OSHEEP_CODEX_CONFIG_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".codex"));
    codex_snapshot_from_codex_dir(&home).await
}

async fn read_json(path: &Path) -> Option<Value> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn claude_snapshot_from(home: &Path) -> Value {
    let claude_dir = home.join(".claude");
    let settings_path = claude_dir.join("settings.json");
    let local_settings = claude_dir.join("settings.local.json");
    let cache = claude_dir.join("plugins").join("cache");
    let marketplaces_root = claude_dir.join("plugins").join("marketplaces");
    let installed_path = claude_dir.join("plugins").join("installed_plugins.json");
    let enabled = read_json(&settings_path)
        .await
        .and_then(|value| value.get("enabledPlugins").cloned())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let installed = read_json(&installed_path)
        .await
        .and_then(|value| value.get("plugins").cloned())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut plugins = HashMap::<String, Value>::new();
    let mut marketplaces = Vec::new();
    let mut warnings = Vec::new();

    let mut entries = match tokio::fs::read_dir(&marketplaces_root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return serde_json::json!({
                "plugins": [], "marketplaces": [], "warnings": [],
                "paths": claude_paths(&claude_dir, &settings_path, &local_settings, &cache, &marketplaces_root)
            });
        }
        Err(error) => {
            warnings.push(format!("Claude marketplace scan failed: {error}"));
            return serde_json::json!({
                "plugins": [], "marketplaces": [], "warnings": warnings,
                "paths": claude_paths(&claude_dir, &settings_path, &local_settings, &cache, &marketplaces_root)
            });
        }
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if !entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let manifest_path = entry.path().join(".claude-plugin").join("marketplace.json");
        let Some(manifest) = read_json(&manifest_path).await else {
            continue;
        };
        let marketplace = manifest["name"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());
        marketplaces.push(serde_json::json!({
            "name": marketplace,
            "source": manifest.get("source").and_then(Value::as_str),
            "repo": manifest.get("repo").and_then(Value::as_str),
            "url": manifest.get("homepage").and_then(Value::as_str),
            "path": entry.path()
        }));
        for item in manifest["plugins"].as_array().into_iter().flatten() {
            let Some(name) = item["name"].as_str() else {
                continue;
            };
            let selector = format!("{name}@{marketplace}");
            let installs = installed
                .get(&selector)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let install = installs.last();
            let is_installed = !installs.is_empty();
            let is_enabled = enabled
                .get(&selector)
                .and_then(Value::as_bool)
                .unwrap_or(is_installed);
            let source_path = plugin_source_path(item, &entry.path()).or_else(|| {
                install
                    .and_then(|value| value["installPath"].as_str())
                    .map(PathBuf::from)
            });
            let plugin_manifest = match source_path.as_deref() {
                Some(path) => read_json(&path.join(".claude-plugin").join("plugin.json")).await,
                None => None,
            };
            let icon = load_plugin_icon(
                plugin_manifest.as_ref().unwrap_or(item),
                source_path.as_deref(),
                name,
            )
            .await;
            let display_name = plugin_manifest
                .as_ref()
                .and_then(|value| value["interface"]["displayName"].as_str())
                .or_else(|| {
                    plugin_manifest
                        .as_ref()
                        .and_then(|value| value["displayName"].as_str())
                })
                .or_else(|| item.get("displayName").and_then(Value::as_str))
                .unwrap_or(name);
            let version = install
                .and_then(|value| value["version"].as_str())
                .or_else(|| {
                    plugin_manifest
                        .as_ref()
                        .and_then(|value| value["version"].as_str())
                });
            let description = plugin_manifest
                .as_ref()
                .and_then(|value| value["interface"]["shortDescription"].as_str())
                .or_else(|| {
                    plugin_manifest
                        .as_ref()
                        .and_then(|value| value["description"].as_str())
                })
                .or_else(|| item.get("description").and_then(Value::as_str));
            plugins.insert(selector.clone(), serde_json::json!({
                "name": name,
                "marketplace": marketplace,
                "selector": selector,
                "displayName": display_name,
                "version": version,
                "description": description,
                "icon": icon,
                "scope": install.and_then(|value| value["scope"].as_str()),
                "status": {"installed":is_installed,"available":true,"enabled":is_enabled,"cached":is_installed,"local":false},
                "source": {"kind":"marketplace","path":source_path}
            }));
        }
    }
    let mut plugins = plugins.into_values().collect::<Vec<_>>();
    sort_plugins(&mut plugins);
    serde_json::json!({
        "plugins": plugins, "marketplaces": marketplaces, "warnings": warnings,
        "paths": claude_paths(&claude_dir, &settings_path, &local_settings, &cache, &marketplaces_root)
    })
}

fn claude_paths(
    claude_dir: &Path,
    settings: &Path,
    local_settings: &Path,
    cache: &Path,
    marketplaces: &Path,
) -> Value {
    serde_json::json!({
        "claudeDir":claude_dir,"settings":settings,"localSettings":local_settings,
        "pluginCache":cache,"marketplaces":marketplaces,"skills":claude_dir.join("skills")
    })
}

async fn codex_snapshot_from_codex_dir(codex_dir: &Path) -> Value {
    let codex_dir = codex_dir.to_path_buf();
    let config_path = codex_dir.join("config.toml");
    let cache_root = codex_dir.join(".tmp").join("plugins");
    let preferred_registry_path = cache_root
        .join(".agents")
        .join("plugins")
        .join("api_marketplace.json");
    let fallback_registry_path = cache_root
        .join(".agents")
        .join("plugins")
        .join("marketplace.json");
    // Codex keeps the personal marketplace outside CODEX_HOME. CODEX_HOME is
    // the native runtime/config directory, while local plugins are shared
    // from the user's home directory.
    let home = user_home();
    let (personal_root, personal_marketplace) = codex_personal_paths(&home);
    let config = tokio::fs::read_to_string(&config_path)
        .await
        .unwrap_or_default();
    let mut plugins = HashMap::<String, Value>::new();
    let mut marketplaces = Vec::new();
    let warnings: Vec<String> = Vec::new();

    let registry = if let Some(value) = read_json(&preferred_registry_path).await {
        Some((preferred_registry_path, value))
    } else {
        read_json(&fallback_registry_path)
            .await
            .map(|value| (fallback_registry_path, value))
    };
    if let Some((registry_path, registry)) = registry {
        let marketplace = registry["name"].as_str().unwrap_or("openai-api-curated");
        marketplaces.push(serde_json::json!({
            "name": marketplace,
            "source": "official",
            "path": registry_path
        }));
        for item in registry["plugins"].as_array().into_iter().flatten() {
            let Some(name) = item["name"].as_str() else {
                continue;
            };
            let selector = format!("{name}@{marketplace}");
            let plugin_root = codex_plugin_root(&cache_root, item);
            let metadata = match &plugin_root {
                Some(root) => read_json(&root.join(".codex-plugin").join("plugin.json")).await,
                None => None,
            };
            let icon = load_plugin_icon(
                metadata.as_ref().unwrap_or(item),
                plugin_root.as_deref(),
                name,
            )
            .await;
            let installed = codex_config_mentions(&config, &selector);
            let enabled = codex_config_enabled(&config, &selector).unwrap_or(installed);
            plugins.insert(selector.clone(), serde_json::json!({
                "name": name,
                "marketplace": marketplace,
                "selector": selector,
                "displayName": metadata.as_ref().and_then(|value| value["interface"]["displayName"].as_str()).or_else(|| metadata.as_ref().and_then(|value| value["displayName"].as_str())).unwrap_or(name),
                "version": metadata.as_ref().and_then(|value| value["version"].as_str()),
                "description": metadata.as_ref().and_then(|value| value["description"].as_str()).or_else(|| item["description"].as_str()),
                "icon": icon,
                "status":{"installed":installed,"available":true,"enabled":enabled,"cached":plugin_root.is_some(),"local":false},
                "source":{"kind":"marketplace","path":plugin_root}
            }));
        }
    }

    if let Some(personal) = read_json(&personal_marketplace).await {
        let marketplace = personal["name"].as_str().unwrap_or("personal");
        marketplaces.push(
            serde_json::json!({"name":marketplace,"source":"personal","path":personal_marketplace}),
        );
        for item in personal["plugins"].as_array().into_iter().flatten() {
            let Some(name) = item["name"].as_str() else {
                continue;
            };
            let selector = format!("{name}@{marketplace}");
            let source_path = item["source"]["path"].as_str().map(|path| {
                personal_plugin_source_path(&personal_marketplace, &personal_root, path)
            });
            let plugin_manifest = match source_path.as_deref() {
                Some(path) => read_json(&path.join(".codex-plugin").join("plugin.json")).await,
                None => None,
            };
            let icon = load_plugin_icon(
                plugin_manifest.as_ref().unwrap_or(item),
                source_path.as_deref(),
                name,
            )
            .await;
            let display_name = plugin_manifest
                .as_ref()
                .and_then(|value| value["interface"]["displayName"].as_str())
                .or_else(|| {
                    plugin_manifest
                        .as_ref()
                        .and_then(|value| value["displayName"].as_str())
                })
                .unwrap_or(name);
            let version = plugin_manifest
                .as_ref()
                .and_then(|value| value["version"].as_str());
            let description = plugin_manifest
                .as_ref()
                .and_then(|value| value["interface"]["shortDescription"].as_str())
                .or_else(|| {
                    plugin_manifest
                        .as_ref()
                        .and_then(|value| value["description"].as_str())
                });
            let installed = codex_config_mentions(&config, &selector);
            plugins.insert(selector.clone(), serde_json::json!({
                "name":name,"marketplace":marketplace,"selector":selector,"displayName":display_name,
                "version":version,"description":description,
                "icon":icon,
                "status":{"installed":installed,"available":true,"enabled":codex_config_enabled(&config, &selector).unwrap_or(installed),"cached":source_path.as_ref().is_some_and(|path| path.exists()),"local":true},
                "source":{"kind":"personal","path":source_path}
            }));
        }
    }
    let mut plugins = plugins.into_values().collect::<Vec<_>>();
    sort_plugins(&mut plugins);
    serde_json::json!({
        "plugins":plugins,"marketplaces":marketplaces,"warnings":warnings,
        "paths":{"codexDir":codex_dir,"codexConfig":config_path,"codexPluginCache":cache_root,"personalMarketplace":personal_marketplace,"personalPluginRoot":personal_root}
    })
}

fn codex_plugin_root(cache_root: &Path, item: &Value) -> Option<PathBuf> {
    let path = item["source"]["path"].as_str()?;
    let candidate = cache_root.join(path);
    candidate.exists().then_some(candidate)
}

fn plugin_source_path(item: &Value, marketplace_root: &Path) -> Option<PathBuf> {
    let source = item.get("source")?;
    let raw = source
        .as_str()
        .or_else(|| source.get("path").and_then(Value::as_str))?;
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return None;
    }
    Some(marketplace_root.join(raw.replace('\\', "/")))
}

fn personal_plugin_source_path(
    marketplace_path: &Path,
    personal_root: &Path,
    raw: &str,
) -> PathBuf {
    let normalized = raw.replace('\\', "/");
    let segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>();
    if segments.first() == Some(&"plugins") && segments.len() > 1 {
        return segments[1..]
            .iter()
            .fold(personal_root.to_path_buf(), |path, segment| {
                path.join(segment)
            });
    }
    segments.iter().fold(
        marketplace_path
            .parent()
            .unwrap_or(personal_root)
            .to_path_buf(),
        |path, segment| path.join(segment),
    )
}

fn codex_config_mentions(config: &str, selector: &str) -> bool {
    config.contains(&format!("[plugins.\"{selector}\"]"))
        || config.contains(&format!("[plugins.{selector}]"))
}

fn codex_config_enabled(config: &str, selector: &str) -> Option<bool> {
    let headers = [
        format!("[plugins.\"{selector}\"]"),
        format!("[plugins.{selector}]"),
    ];
    let start = headers.iter().find_map(|header| config.find(header))?;
    let section = &config[start..];
    let section = section.find('\n').map_or("", |index| &section[index + 1..]);
    let section = section
        .find("\n[")
        .map_or(section, |index| &section[..index]);
    section.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "enabled").then(|| value.trim() == "true")
    })
}

async fn load_plugin_icon(metadata: &Value, plugin_root: Option<&Path>, name: &str) -> String {
    let candidate = [
        metadata["icon"].as_str(),
        metadata["composerIcon"].as_str(),
        metadata["logo"].as_str(),
        metadata["interface"]["icon"].as_str(),
        metadata["interface"]["composerIcon"].as_str(),
        metadata["interface"]["logo"].as_str(),
    ]
    .into_iter()
    .flatten()
    .find(|value| !value.trim().is_empty())
    .unwrap_or("");
    if candidate.starts_with("data:image/")
        || candidate.starts_with("http://")
        || candidate.starts_with("https://")
    {
        return candidate.to_owned();
    }
    if let Some(root) = plugin_root {
        let path = root.join(candidate);
        if !candidate.is_empty() && path.starts_with(root) {
            if let Ok(bytes) = tokio::fs::read(&path).await {
                if bytes.len() <= 256 * 1024 {
                    if let Some(mime) = icon_mime(path.extension().and_then(|value| value.to_str()))
                    {
                        return format!("data:{mime};base64,{}", base64_encode(&bytes));
                    }
                }
            }
        }
    }
    fallback_plugin_icon(name)
}

fn icon_mime(extension: Option<&str>) -> Option<&'static str> {
    match extension.unwrap_or("").to_ascii_lowercase().as_str() {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(TABLE[a >> 2] as char);
        out.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[c & 63] as char
        } else {
            '='
        });
    }
    out
}

fn fallback_plugin_icon(name: &str) -> String {
    let mut hash = 0u32;
    for byte in name.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(byte as u32);
    }
    let colors = [
        "#2563EB", "#059669", "#7C3AED", "#DC2626", "#0891B2", "#C2410C",
    ];
    let color = colors[(hash as usize) % colors.len()];
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"14\" fill=\"{color}\"/><g fill=\"none\" stroke=\"#fff\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M24 18h16a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6Z\"/><path d=\"M28 18v-5M36 18v-5M28 51v-5M36 51v-5M18 28h-5M18 36h-5M51 28h-5M51 36h-5\"/></g></svg>"
    );
    format!(
        "data:image/svg+xml;base64,{}",
        base64_encode(svg.as_bytes())
    )
}

fn sort_plugins(plugins: &mut [Value]) {
    plugins.sort_by(|left, right| {
        let left_installed = left["status"]["installed"].as_bool().unwrap_or(false);
        let right_installed = right["status"]["installed"].as_bool().unwrap_or(false);
        right_installed.cmp(&left_installed).then_with(|| {
            left["displayName"]
                .as_str()
                .cmp(&right["displayName"].as_str())
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "osheep-plugin-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn finds_codex_plugin_enabled_setting() {
        let config = "[plugins.\"game-studio@openai-api-curated\"]\nenabled = true\n";
        assert!(codex_config_mentions(
            config,
            "game-studio@openai-api-curated"
        ));
        assert_eq!(
            codex_config_enabled(config, "game-studio@openai-api-curated"),
            Some(true)
        );
    }

    #[tokio::test]
    async fn plugin_snapshot_records_always_include_renderable_icons() {
        let icon = load_plugin_icon(
            &serde_json::json!({"icon":"https://example.test/icon.png"}),
            None,
            "demo",
        )
        .await;
        assert_eq!(icon, "https://example.test/icon.png");
        let fallback = load_plugin_icon(&serde_json::json!({}), None, "demo").await;
        assert!(fallback.starts_with("data:image/svg+xml;base64,"));
    }

    #[tokio::test]
    async fn reads_claude_official_marketplace_without_cli() {
        let home = temp_home("claude");
        let marketplace = home.join(
            ".claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json",
        );
        tokio::fs::create_dir_all(marketplace.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &marketplace,
            r#"{"name":"claude-plugins-official","plugins":[{"name":"agent-sdk-dev","description":"SDK"}]}"#,
        )
        .await
        .unwrap();
        let snapshot = claude_snapshot_from(&home).await;
        assert_eq!(
            snapshot["plugins"][0]["selector"],
            "agent-sdk-dev@claude-plugins-official"
        );
        assert_eq!(snapshot["plugins"][0]["status"]["available"], true);
        tokio::fs::remove_dir_all(home).await.ok();
    }

    #[tokio::test]
    async fn reads_claude_plugin_manifest_icon() {
        let home = temp_home("claude-icon");
        let root = home
            .join(".claude")
            .join("plugins")
            .join("marketplaces")
            .join("official");
        let marketplace = root.join(".claude-plugin").join("marketplace.json");
        let plugin_root = root.join("plugins").join("demo");
        tokio::fs::create_dir_all(marketplace.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::create_dir_all(plugin_root.join(".claude-plugin"))
            .await
            .unwrap();
        tokio::fs::write(
            &marketplace,
            r#"{"name":"official","plugins":[{"name":"demo","source":"./plugins/demo"}]}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            plugin_root.join(".claude-plugin").join("plugin.json"),
            r#"{"name":"demo","interface":{"displayName":"Demo","icon":"data:image/svg+xml;base64,AAAA"}}"#,
        )
        .await
        .unwrap();
        let snapshot = claude_snapshot_from(&home).await;
        assert_eq!(snapshot["plugins"][0]["displayName"], "Demo");
        assert_eq!(
            snapshot["plugins"][0]["icon"],
            "data:image/svg+xml;base64,AAAA"
        );
        tokio::fs::remove_dir_all(home).await.ok();
    }

    #[tokio::test]
    async fn reads_codex_official_registry_without_cli() {
        let home = temp_home("codex");
        let registry = home
            .join(".codex")
            .join(".tmp")
            .join("plugins")
            .join(".agents")
            .join("plugins")
            .join("api_marketplace.json");
        tokio::fs::create_dir_all(registry.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &registry,
            r#"{"name":"openai-api-curated","plugins":[{"name":"game-studio","source":{"path":"./plugins/game-studio"}}]}"#,
        )
        .await
        .unwrap();
        let snapshot = codex_snapshot_from_codex_dir(&home.join(".codex")).await;
        assert_eq!(
            snapshot["plugins"][0]["selector"],
            "game-studio@openai-api-curated"
        );
        assert_eq!(snapshot["plugins"][0]["status"]["available"], true);
        tokio::fs::remove_dir_all(home).await.ok();
    }

    #[tokio::test]
    async fn falls_back_to_codex_marketplace_registry() {
        let home = temp_home("codex-fallback");
        let registry = home
            .join(".codex")
            .join(".tmp")
            .join("plugins")
            .join(".agents")
            .join("plugins")
            .join("marketplace.json");
        tokio::fs::create_dir_all(registry.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &registry,
            r#"{"name":"openai-curated","plugins":[{"name":"demo","source":{"path":"./plugins/demo"}}]}"#,
        )
        .await
        .unwrap();
        let snapshot = codex_snapshot_from_codex_dir(&home.join(".codex")).await;
        assert_eq!(snapshot["plugins"][0]["selector"], "demo@openai-curated");
        assert_eq!(
            snapshot["marketplaces"][0]["path"],
            registry.to_string_lossy().as_ref()
        );
        tokio::fs::remove_dir_all(home).await.ok();
    }

    #[test]
    fn resolves_personal_plugin_paths_from_plugins_prefix() {
        let marketplace = PathBuf::from(r"C:\Users\Admin\.agents\plugins\marketplace.json");
        let root = PathBuf::from(r"C:\Users\Admin\plugins");
        assert_eq!(
            personal_plugin_source_path(&marketplace, &root, r".\plugins\demo"),
            root.join("demo")
        );
    }

    #[test]
    fn codex_personal_plugins_use_agents_marketplace() {
        let home = PathBuf::from(r"C:\Users\Admin");
        let (root, marketplace) = codex_personal_paths(&home);
        assert_eq!(root, home.join("plugins"));
        assert_eq!(
            marketplace,
            home.join(".agents")
                .join("plugins")
                .join("marketplace.json")
        );
        assert!(!marketplace.starts_with(home.join(".codex")));
    }
}
