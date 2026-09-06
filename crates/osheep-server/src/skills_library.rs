use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const HOME_URL: &str = "https://skills.sh/";
const SITEMAP_URL: &str = "https://skills.sh/sitemap.xml";

#[derive(Clone)]
pub(crate) struct SkillsLibrary {
    cache_path: PathBuf,
    state: Arc<Mutex<LibraryState>>,
}

struct LibraryState {
    skills: Vec<Value>,
    expires_at: Instant,
}

impl SkillsLibrary {
    pub(crate) async fn new(data_root: &Path) -> Self {
        let cache_path = data_root.join("skills-library.json");
        let skills = read_cache(&cache_path)
            .await
            .filter(|items| items.len() >= 50)
            .unwrap_or_else(fallback_catalog);
        Self {
            cache_path,
            state: Arc::new(Mutex::new(LibraryState {
                skills,
                expires_at: Instant::now(),
            })),
        }
    }

    pub(crate) async fn search(&self, query: &str) -> Vec<Value> {
        let should_refresh = {
            let state = self.state.lock().await;
            state.expires_at <= Instant::now()
        };
        if should_refresh {
            if let Ok(skills) = self.fetch().await {
                let _ = write_cache(&self.cache_path, &skills).await;
                let mut state = self.state.lock().await;
                state.skills = skills;
                state.expires_at = Instant::now() + CACHE_TTL;
            } else {
                self.state.lock().await.expires_at = Instant::now() + Duration::from_secs(30);
            }
        }

        let needle = query.trim().to_lowercase();
        let state = self.state.lock().await;
        let mut matches = state
            .skills
            .iter()
            .filter(|item| {
                needle.is_empty()
                    || ["name", "owner", "repo", "source", "description"]
                        .iter()
                        .filter_map(|key| item.get(key).and_then(Value::as_str))
                        .any(|value| value.to_lowercase().contains(&needle))
            })
            .cloned()
            .collect::<Vec<_>>();
        if !needle.is_empty() {
            matches.sort_by(|left, right| {
                right["installCount"]
                    .as_u64()
                    .cmp(&left["installCount"].as_u64())
                    .then_with(|| left["name"].as_str().cmp(&right["name"].as_str()))
            });
        }
        matches.truncate(50);
        matches
    }

    async fn fetch(&self) -> Result<Vec<Value>, std::io::Error> {
        let homepage = fetch_text(HOME_URL).await?;
        let ranked = parse_homepage(&homepage);
        let indexed = match fetch_text(SITEMAP_URL).await {
            Ok(xml) => {
                let direct = parse_sitemap(&xml);
                if direct.is_empty() {
                    let children = sitemap_children(&xml);
                    futures_util::future::join_all(children.iter().map(|url| fetch_text(url)))
                        .await
                        .into_iter()
                        .filter_map(Result::ok)
                        .flat_map(|xml| parse_sitemap(&xml))
                        .collect()
                } else {
                    direct
                }
            }
            Err(_) => Vec::new(),
        };
        let mut merged: Vec<Value> = Vec::new();
        let mut positions = HashMap::<String, usize>::new();
        for item in ranked.into_iter().chain(indexed) {
            let key = format!(
                "{}/{}",
                item["source"].as_str().unwrap_or_default(),
                item["name"].as_str().unwrap_or_default()
            );
            if let Some(index) = positions.get(&key).copied() {
                if merged[index]["installCount"].as_u64().unwrap_or(0)
                    < item["installCount"].as_u64().unwrap_or(0)
                {
                    merged[index] = item;
                }
            } else {
                positions.insert(key, merged.len());
                merged.push(item);
            }
        }
        if merged.is_empty() {
            return Ok(fallback_catalog());
        }
        Ok(merged)
    }
}

fn parse_homepage(html: &str) -> Vec<Value> {
    let card = Regex::new(r#"(?s)<a class="group grid[^"]*" href="/([^"?#]+)"[^>]*>(.*?)</a>"#)
        .expect("valid card regex");
    let name = Regex::new(r#"<h3[^>]*>([^<]+)</h3>"#).expect("valid name regex");
    let source = Regex::new(r#"<p[^>]*>([^<]+)</p>"#).expect("valid source regex");
    let count = Regex::new(
        r#"(?s)<div class="lg:col-span-2 text-right[^"]*">.*?<span class="font-mono text-sm text-foreground">([^<]+)</span>"#,
    )
    .expect("valid count regex");
    let mut result = Vec::new();
    for capture in card.captures_iter(html) {
        let route = capture.get(1).map_or("", |value| value.as_str());
        let body = capture.get(2).map_or("", |value| value.as_str());
        let Some(skill_name) = name.captures(body).and_then(|item| item.get(1)) else {
            continue;
        };
        let Some(skill_source) = source.captures(body).and_then(|item| item.get(1)) else {
            continue;
        };
        let Some(install_count) = count.captures(body).and_then(|item| item.get(1)) else {
            continue;
        };
        let name = decode_html(skill_name.as_str()).trim().to_owned();
        let source = decode_html(skill_source.as_str()).trim().to_owned();
        let parts = route
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if name.is_empty() || source.is_empty() || parts.len() < 3 {
            continue;
        }
        result.push(library_item(
            &name,
            &source,
            parse_count(install_count.as_str()),
        ));
    }
    result
}

fn parse_sitemap(xml: &str) -> Vec<Value> {
    let locations = Regex::new(r#"(?i)<loc>\s*https?://[^<]+?/([^<?#]+)\s*</loc>"#)
        .expect("valid sitemap regex");
    let mut result = Vec::new();
    for capture in locations.captures_iter(xml) {
        let route = capture
            .get(1)
            .map_or("", |value| value.as_str())
            .trim_matches('/');
        let parts = route
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if parts.len() < 3 {
            continue;
        }
        let name = parts.last().copied().unwrap_or_default();
        let source = if parts[0] == "site" {
            parts[1].to_owned()
        } else {
            parts[..parts.len() - 1].join("/")
        };
        if valid_component(name) && valid_component(source.rsplit('/').next().unwrap_or_default()) {
            result.push(library_item(name, &source, 0));
        }
    }
    result
}

fn sitemap_children(xml: &str) -> Vec<String> {
    let locations = Regex::new(r#"(?i)<loc>\s*(https?://[^<]*sitemap[^<]*)\s*</loc>"#)
        .expect("valid sitemap index regex");
    locations
        .captures_iter(xml)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().trim().to_owned()))
        .take(50)
        .collect()
}

fn library_item(name: &str, source: &str, install_count: u64) -> Value {
    let parts = source.split('/').collect::<Vec<_>>();
    let github = parts.len() > 1 && !source.contains('.');
    serde_json::json!({
        "name": name,
        "owner": github.then(|| parts[0]),
        "repo": github.then(|| parts[1]),
        "description": Value::Null,
        "installCount": install_count,
        "source": source,
        "url": if github { format!("https://github.com/{source}") } else { format!("https://{source}") }
    })
}

fn parse_count(value: &str) -> u64 {
    let normalized = value.trim().replace(',', "");
    let multiplier = match normalized.chars().last() {
        Some('K' | 'k') => 1_000.0,
        Some('M' | 'm') => 1_000_000.0,
        Some('B' | 'b') => 1_000_000_000.0,
        _ => 1.0,
    };
    normalized
        .trim_end_matches(|character: char| character.is_ascii_alphabetic())
        .parse::<f64>()
        .map_or(0, |count| (count * multiplier).round() as u64)
}

fn decode_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

async fn read_cache(path: &Path) -> Option<Vec<Value>> {
    let data = tokio::fs::read(path).await.ok()?;
    let value: Value = serde_json::from_slice(&data).ok()?;
    value.get("skills")?.as_array().cloned()
}

async fn write_cache(path: &Path, skills: &[Value]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({"skills": skills}))
        .map_err(std::io::Error::other)?;
    tokio::fs::write(path, bytes).await
}

async fn fetch_text(url: &str) -> std::io::Result<String> {
    const SCRIPT: &str = "fetch(process.argv[1],{headers:{accept:'text/html,application/xml'}}).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);process.stdout.write(await r.text())}).catch(e=>{console.error(e.message);process.exit(1)})";
    let mut command = tokio::process::Command::new("node");
    command.args(["-e", SCRIPT, url]).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "skills.sh timed out"))??;
    if !output.status.success() {
        return Err(std::io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    String::from_utf8(output.stdout).map_err(std::io::Error::other)
}

fn fallback_catalog() -> Vec<Value> {
    const SKILLS: &[(&str, &str)] = &[
        ("frontend-design", "anthropics/skills"),
        ("pdfs", "anthropics/skills"),
        ("spreadsheets", "anthropics/skills"),
        ("webapp-testing", "anthropics/skills"),
        ("docs", "anthropics/skills"),
        ("slides", "anthropics/skills"),
        ("skill-creator", "anthropics/skills"),
        ("mcp-builder", "anthropics/skills"),
        ("canvas-design", "anthropics/skills"),
        ("internal-comms", "anthropics/skills"),
        ("brand-guidelines", "anthropics/skills"),
        ("theme-factory", "anthropics/skills"),
        ("algorithmic-art", "anthropics/skills"),
        ("slack-gif-creator", "anthropics/skills"),
        ("artifacts-builder", "anthropics/skills"),
        ("playwright", "microsoft/playwright"),
        ("react-best-practices", "vercel-labs/agent-skills"),
        ("web-design-guidelines", "vercel-labs/agent-skills"),
        ("nextjs", "vercel-labs/agent-skills"),
        ("typescript", "wshobson/agents"),
        ("python", "wshobson/agents"),
        ("rust", "wshobson/agents"),
        ("code-review", "wshobson/agents"),
        ("security-review", "wshobson/agents"),
        ("test-driven-development", "wshobson/agents"),
        ("systematic-debugging", "obra/superpowers"),
        ("brainstorming", "obra/superpowers"),
        ("writing-plans", "obra/superpowers"),
        ("executing-plans", "obra/superpowers"),
        ("verification-before-completion", "obra/superpowers"),
        ("using-git-worktrees", "obra/superpowers"),
        ("requesting-code-review", "obra/superpowers"),
        ("receiving-code-review", "obra/superpowers"),
        ("dispatching-parallel-agents", "obra/superpowers"),
        ("subagent-driven-development", "obra/superpowers"),
        ("finishing-a-development-branch", "obra/superpowers"),
        ("seo-audit", "coreyhaines31/marketingskills"),
        ("copywriting", "coreyhaines31/marketingskills"),
        ("content-strategy", "coreyhaines31/marketingskills"),
        ("analytics-tracking", "coreyhaines31/marketingskills"),
        ("programmatic-seo", "coreyhaines31/marketingskills"),
        ("schema-markup", "coreyhaines31/marketingskills"),
        ("email-sequence", "coreyhaines31/marketingskills"),
        ("launch-strategy", "coreyhaines31/marketingskills"),
        ("pricing-strategy", "coreyhaines31/marketingskills"),
        ("competitor-alternatives", "coreyhaines31/marketingskills"),
        ("social-content", "coreyhaines31/marketingskills"),
        ("paid-ads", "coreyhaines31/marketingskills"),
        ("page-cro", "coreyhaines31/marketingskills"),
        ("form-cro", "coreyhaines31/marketingskills"),
    ];
    SKILLS
        .iter()
        .enumerate()
        .map(|(index, (name, source))| library_item(name, source, (SKILLS.len() - index) as u64))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranked_homepage_cards() {
        let html = r#"<a class="group grid x" href="/anthropics/skills/frontend-design"><h3>frontend-design</h3><p>anthropics/skills</p><div class="lg:col-span-2 text-right x"><span class="font-mono text-sm text-foreground">12.5K</span></div></a>"#;
        let parsed = parse_homepage(html);
        assert_eq!(parsed[0]["name"], "frontend-design");
        assert_eq!(parsed[0]["installCount"], 12_500);
    }

    #[test]
    fn parses_searchable_sitemap_entries() {
        let parsed = parse_sitemap("<url><loc>https://skills.sh/acme/tools/deploy</loc></url>");
        assert_eq!(parsed[0]["name"], "deploy");
        assert_eq!(parsed[0]["source"], "acme/tools");
    }

    #[test]
    fn offline_catalog_always_has_fifty_entries() {
        assert_eq!(fallback_catalog().len(), 50);
    }
}
