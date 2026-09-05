use regex::{Regex, RegexBuilder};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use thiserror::Error;
use tokio::sync::Semaphore;

const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".vite",
    ".cache",
];
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SNIFF_BYTES: usize = 8 * 1024;
const MAX_PREVIEW_UTF16_LEN: usize = 400;

#[derive(Debug, Clone)]
pub struct SearchServiceConfig {
    pub max_parallel_searches: usize,
}

impl Default for SearchServiceConfig {
    fn default() -> Self {
        Self {
            max_parallel_searches: 2,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub max_files: usize,
    pub max_matches_per_file: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchLine {
    pub line: usize,
    pub column: usize,
    pub preview: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchFileMatch {
    pub path: String,
    pub lines: Vec<SearchMatchLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchFileMatch>,
    pub truncated: bool,
    pub files_scanned: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Error)]
pub enum SearchError {
    #[error("{0}")]
    InvalidQuery(String),
    #[error("搜索已取消")]
    Cancelled,
    #[error("搜索任务失败: {0}")]
    Join(String),
}

#[derive(Debug, Clone)]
pub struct SearchService {
    searches: Arc<Semaphore>,
}

impl SearchService {
    pub fn new(config: SearchServiceConfig) -> Self {
        Self {
            searches: Arc::new(Semaphore::new(config.max_parallel_searches.max(1))),
        }
    }

    pub async fn search(
        &self,
        workspace_root: &Path,
        options: SearchOptions,
    ) -> Result<SearchResult, SearchError> {
        let started = Instant::now();
        if options.query.is_empty() {
            return Ok(SearchResult {
                matches: Vec::new(),
                truncated: false,
                files_scanned: 0,
                elapsed_ms: 0,
            });
        }
        let pattern = build_pattern(&options)?;
        let include = build_globs(&options.include)?;
        let exclude = build_globs(&options.exclude)?;
        let permit = self
            .searches
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| SearchError::Join(error.to_string()))?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_on_drop = CancelOnDrop(cancelled.clone());
        let root = workspace_root.to_owned();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            search_sync(
                &root, &options, &pattern, &include, &exclude, &cancelled, started,
            )
        });
        let result = task
            .await
            .map_err(|error| SearchError::Join(error.to_string()))?;
        drop(cancel_on_drop);
        result
    }
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn build_pattern(options: &SearchOptions) -> Result<Regex, SearchError> {
    let source = if options.regex {
        options.query.clone()
    } else {
        regex::escape(&options.query)
    };
    RegexBuilder::new(&source)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|error| SearchError::InvalidQuery(error.to_string()))
}

fn build_globs(globs: &[String]) -> Result<Vec<Regex>, SearchError> {
    globs
        .iter()
        .map(|glob| {
            Regex::new(&glob_regex_source(glob))
                .map_err(|error| SearchError::InvalidQuery(error.to_string()))
        })
        .collect()
}

fn glob_regex_source(glob: &str) -> String {
    let chars = glob.trim().chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return "(?:)".into();
    }
    let mut source = String::from("^");
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                source.push_str(".*");
                index += 2;
                if chars.get(index) == Some(&'/') {
                    index += 1;
                }
            }
            '*' => {
                source.push_str("[^/]*");
                index += 1;
            }
            '?' => {
                source.push_str("[^/]");
                index += 1;
            }
            '.' => {
                source.push_str("\\.");
                index += 1;
            }
            value if "+()|^$[]{}\\".contains(value) => {
                source.push('\\');
                source.push(value);
                index += 1;
            }
            value => {
                source.push(value);
                index += 1;
            }
        }
    }
    source.push('$');
    source
}

fn search_sync(
    workspace_root: &Path,
    options: &SearchOptions,
    pattern: &Regex,
    include: &[Regex],
    exclude: &[Regex],
    cancelled: &AtomicBool,
    started: Instant,
) -> Result<SearchResult, SearchError> {
    let ignored = IGNORED_DIRECTORIES.iter().copied().collect::<HashSet<_>>();
    let mut stack = vec![(workspace_root.to_owned(), String::new())];
    let mut matches = Vec::new();
    let mut files_scanned = 0;
    let mut truncated = false;

    while let Some((directory, relative_directory)) = stack.pop() {
        check_cancelled(cancelled)?;
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries {
            check_cancelled(cancelled)?;
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if relative_directory.is_empty() {
                name.clone()
            } else {
                format!("{relative_directory}/{name}")
            };
            if file_type.is_dir() {
                if ignored.contains(name.as_str())
                    || matches_any(&relative, exclude)
                    || matches_any(&format!("{relative}/"), exclude)
                {
                    continue;
                }
                stack.push((entry.path(), relative));
                continue;
            }
            if !file_type.is_file() || matches_any(&relative, exclude) {
                continue;
            }
            if files_scanned >= options.max_files {
                truncated = true;
                stack.clear();
                break;
            }
            if !include.is_empty() && !matches_any(&relative, include) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            if looks_binary(&bytes) {
                continue;
            }
            files_scanned += 1;
            let text = String::from_utf8_lossy(&bytes);
            let mut file_lines = Vec::new();
            for (line_index, raw_line) in text.split('\n').enumerate() {
                check_cancelled(cancelled)?;
                if file_lines.len() >= options.max_matches_per_file {
                    truncated = true;
                    break;
                }
                let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
                for found in pattern.find_iter(line) {
                    check_cancelled(cancelled)?;
                    if found.is_empty()
                        || (options.whole_word
                            && !has_ascii_word_boundaries(line, found.start(), found.end()))
                    {
                        continue;
                    }
                    let match_start = line[..found.start()].encode_utf16().count();
                    let match_end = match_start + found.as_str().encode_utf16().count();
                    let preview = trim_preview(line, match_start, match_end);
                    file_lines.push(SearchMatchLine {
                        line: line_index + 1,
                        column: match_start + 1,
                        preview: preview.text,
                        match_start: preview.match_start,
                        match_end: preview.match_end,
                    });
                    if file_lines.len() >= options.max_matches_per_file {
                        truncated = true;
                        break;
                    }
                }
            }
            if !file_lines.is_empty() {
                matches.push(SearchFileMatch {
                    path: relative.replace('\\', "/"),
                    lines: file_lines,
                });
            }
        }
    }
    matches.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(SearchResult {
        matches,
        truncated,
        files_scanned,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), SearchError> {
    if cancelled.load(Ordering::Acquire) {
        Err(SearchError::Cancelled)
    } else {
        Ok(())
    }
}

fn matches_any(path: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|pattern| pattern.is_match(path))
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sniff = &bytes[..bytes.len().min(SNIFF_BYTES)];
    let suspicious = sniff
        .iter()
        .filter(|byte| **byte < 7 || (**byte > 13 && **byte < 32))
        .count();
    sniff.contains(&0) || suspicious as f64 / sniff.len().max(1) as f64 > 0.3
}

fn has_ascii_word_boundaries(line: &str, start: usize, end: usize) -> bool {
    let before = line[..start].chars().next_back();
    let after = line[end..].chars().next();
    !before.is_some_and(is_ascii_word) && !after.is_some_and(is_ascii_word)
}

fn is_ascii_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

struct Preview {
    text: String,
    match_start: usize,
    match_end: usize,
}

fn trim_preview(line: &str, match_start: usize, match_end: usize) -> Preview {
    let utf16 = line.encode_utf16().collect::<Vec<_>>();
    if utf16.len() <= MAX_PREVIEW_UTF16_LEN {
        return Preview {
            text: line.to_owned(),
            match_start,
            match_end,
        };
    }
    let window_start = match_start.saturating_sub(80);
    let window_end = utf16.len().min(window_start + MAX_PREVIEW_UTF16_LEN);
    let has_prefix = window_start > 0;
    let has_suffix = window_end < utf16.len();
    let content_start = window_start + usize::from(has_prefix);
    let content_end = window_end.saturating_sub(usize::from(has_suffix));
    let mut text = String::new();
    if has_prefix {
        text.push('\u{2026}');
    }
    text.push_str(&String::from_utf16_lossy(
        &utf16[content_start..content_end],
    ));
    if has_suffix {
        text.push('\u{2026}');
    }
    Preview {
        text,
        match_start: match_start - window_start + usize::from(has_prefix),
        match_end: match_end - window_start + usize::from(has_prefix),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "osheep-search-{label}-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time after Unix epoch")
                .as_nanos(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ))
    }

    fn options(query: &str) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: Vec::new(),
            exclude: Vec::new(),
            max_files: 5000,
            max_matches_per_file: 100,
        }
    }

    #[tokio::test]
    async fn search_honors_globs_boundaries_binary_detection_and_utf16_columns() {
        let root = temp_root("contract");
        fs::create_dir_all(root.join("src/ignored")).expect("create source tree");
        fs::create_dir_all(root.join("node_modules/package")).expect("create ignored tree");
        fs::write(
            root.join("src/main.ts"),
            "Alpha beta\nalpha alphabet\nemoji \u{1f600} alpha",
        )
        .expect("write source");
        fs::write(root.join("src/ignored/skip.ts"), "alpha").expect("write excluded source");
        fs::write(root.join("src/binary.ts"), [b'a', 0, b'l']).expect("write binary source");
        fs::write(
            root.join("src/large.ts"),
            vec![b'a'; MAX_FILE_BYTES as usize + 1],
        )
        .expect("write oversized source");
        fs::write(root.join("node_modules/package/index.ts"), "alpha")
            .expect("write ignored dependency");
        let service = SearchService::new(SearchServiceConfig::default());
        let mut search = options("alpha");
        search.whole_word = true;
        search.include = vec!["src/**/*.ts".into()];
        search.exclude = vec!["src/ignored/**".into()];

        let result = service.search(&root, search).await.expect("search");

        assert_eq!(result.files_scanned, 1);
        assert!(!result.truncated);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "src/main.ts");
        assert_eq!(result.matches[0].lines.len(), 3);
        assert_eq!(result.matches[0].lines[2].column, 10);
        assert_eq!(result.matches[0].lines[2].match_start, 9);
        fs::remove_dir_all(root).expect("remove root");
    }

    #[tokio::test]
    async fn search_reports_invalid_regex_and_match_truncation() {
        let root = temp_root("limits");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("note.txt"), "one one one").expect("write note");
        fs::write(root.join("other.txt"), "one").expect("write other note");
        let service = SearchService::new(SearchServiceConfig::default());
        let mut invalid = options("[");
        invalid.regex = true;
        assert!(matches!(
            service.search(&root, invalid).await,
            Err(SearchError::InvalidQuery(_))
        ));

        let mut limited = options("one");
        limited.max_matches_per_file = 2;
        let result = service.search(&root, limited).await.expect("search");
        assert!(result.truncated);
        assert_eq!(result.matches[0].lines.len(), 2);

        let mut file_limited = options("one");
        file_limited.max_files = 1;
        let result = service
            .search(&root, file_limited)
            .await
            .expect("file-limited search");
        assert!(result.truncated);
        assert_eq!(result.files_scanned, 1);
        fs::remove_dir_all(root).expect("remove root");
    }

    #[tokio::test]
    async fn dropping_a_search_releases_its_worker_permit() {
        let root = temp_root("cancellation");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("large.txt"), vec![b'a'; MAX_FILE_BYTES as usize])
            .expect("write large text");
        let service = SearchService::new(SearchServiceConfig {
            max_parallel_searches: 1,
        });
        let mut search = options("a");
        search.max_matches_per_file = usize::MAX;
        let task_service = service.clone();
        let task_root = root.clone();
        let task = tokio::spawn(async move { task_service.search(&task_root, search).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while service.searches.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("search acquired permit");
        task.abort();
        let _ = task.await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while service.searches.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled worker released permit");
        fs::remove_dir_all(root).expect("remove root");
    }

    #[test]
    fn long_previews_keep_utf16_highlight_offsets_bounded() {
        let line = format!("{}needle{}", "x".repeat(200), "y".repeat(500));
        let preview = trim_preview(&line, 200, 206);
        assert_eq!(preview.text.encode_utf16().count(), MAX_PREVIEW_UTF16_LEN);
        assert_eq!(preview.match_start, 81);
        assert_eq!(preview.match_end, 87);
        assert!(preview.text.starts_with('\u{2026}'));
        assert!(preview.text.ends_with('\u{2026}'));
    }
}
