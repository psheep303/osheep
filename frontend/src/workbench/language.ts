export function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cc: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "powershell",
    psm1: "powershell",
    psd1: "powershell",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    sql: "sql",
    xml: "xml",
    vue: "html",
    svelte: "html",
    dockerfile: "dockerfile",
  };
  return map[ext] ?? "plaintext";
}

export function languageLabelFromPath(path: string): string {
  const language = languageFromPath(path);
  const labels: Record<string, string> = {
    plaintext: "Plain Text",
    powershell: "PowerShell",
    typescript: "TypeScript",
    javascript: "JavaScript",
    json: "JSON",
    markdown: "Markdown",
    python: "Python",
    rust: "Rust",
    go: "Go",
    shell: "Shell Script",
  };
  return labels[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}
