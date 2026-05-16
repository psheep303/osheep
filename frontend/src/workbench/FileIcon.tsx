import type { ReactNode } from "react";

// Original SVG icons authored for osheep. Colours follow common conventions
// from GitHub linguist where applicable, but every path is drawn from scratch
// using generic geometric primitives.

const COL = {
  // scripting / web
  json: "#cbcb41",
  js: "#f1e05a",
  jsx: "#519aba",
  ts: "#3178c6",
  tsx: "#519aba",
  vue: "#41b883",
  svelte: "#ff3e00",
  astro: "#ff5d01",
  solid: "#2c4f7c",
  qwik: "#ac7ef4",
  angular: "#dd0031",

  // markup / styling
  md: "#519aba",
  mdx: "#519aba",
  rst: "#85c1c9",
  tex: "#3d6117",
  html: "#e44d26",
  xml: "#0060ac",
  css: "#42a5f5",
  scss: "#c6538c",
  less: "#1d365d",
  stylus: "#ff6347",

  // backend / systems
  python: "#3572a5",
  java: "#b07219",
  c: "#599eff",
  cpp: "#f34b7d",
  csharp: "#178600",
  go: "#00add8",
  rust: "#dea584",
  ruby: "#cc342d",
  php: "#777bb4",
  swift: "#fa7343",
  kotlin: "#7f52ff",
  dart: "#00d2b8",
  scala: "#dc322f",
  lua: "#3b6deb",
  perl: "#39457e",
  r: "#276dc3",
  julia: "#9558b2",
  haskell: "#5e5086",
  elixir: "#6e4a7e",
  erlang: "#a90533",
  clojure: "#5881d8",
  fsharp: "#b845fc",
  groovy: "#4298b8",
  vb: "#945db7",
  pascal: "#cdcd00",
  fortran: "#4d41b1",
  nim: "#ffc200",
  zig: "#f7a41d",
  v: "#4f87c4",
  crystal: "#bfbfbf",
  d: "#ba595e",
  ocaml: "#ee8500",
  lisp: "#3fb68b",
  scheme: "#1e4aec",
  coffee: "#244776",
  elm: "#60b5cc",
  objc: "#438eff",
  reason: "#dd4b39",

  // shell / config
  shell: "#89e051",
  powershell: "#3577ba",
  bat: "#c1f12e",
  yaml: "#cb171e",
  toml: "#9c4221",
  ini: "#9c4221",
  env: "#ecd53f",
  editorconfig: "#909090",

  // data / docs
  sql: "#e38c00",
  db: "#1ba1e2",
  graphql: "#e535ab",
  proto: "#6e6e6e",
  csv: "#83a93c",

  // media / images / archives
  image: "#a074c4",
  audio: "#52b788",
  video: "#e76f51",
  archive: "#ddb84a",
  pdf: "#db5860",
  font: "#fc7d28",

  // text / generic
  text: "#cccccc",
  log: "#a8a8a8",

  // toolchain / lockfile / special names
  npm: "#cb3837",
  yarn: "#2c8ebb",
  pnpm: "#f9ad00",
  lock: "#ddb84a",
  docker: "#2496ed",
  git: "#f14e32",
  vite: "#bd34fe",
  webpack: "#1c78c0",
  rollup: "#ef3335",
  eslint: "#4b32c3",
  prettier: "#c596c7",
  tailwind: "#38bdf8",
  postcss: "#dd3a0a",
  babel: "#f5da55",
  esbuild: "#fcc02d",
  vitest: "#fcc72b",
  jest: "#c63d14",

  // fallback
  default: "#9d9d9d",
};

function Wrap({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      style={{ display: "block", flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

function Letters({
  text,
  color,
  size,
  y = 12,
}: {
  text: string;
  color: string;
  size?: number;
  y?: number;
}) {
  const fs =
    size ??
    (text.length === 1
      ? 9
      : text.length === 2
      ? 6
      : text.length === 3
      ? 4.6
      : 3.8);
  return (
    <text
      x="8"
      y={y}
      fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      fontSize={fs}
      fontWeight={800}
      fill={color}
      textAnchor="middle"
    >
      {text}
    </text>
  );
}

const L = (text: string, color: string, size?: number, y?: number) => (
  <Wrap>
    <Letters text={text} color={color} size={size} y={y} />
  </Wrap>
);

// ── shared graphic primitives ─────────────────────────────────────────

function GenericPaper({ color = COL.default }: { color?: string }) {
  return (
    <>
      <path
        d="M3.5 1.5h6L12.5 4.5V14a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"
        fill="none"
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 1.5V5h3"
        fill="none"
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </>
  );
}

function Braces({ color }: { color: string }) {
  return (
    <>
      <path
        d="M5.5 2.5C4 2.5 3.5 3.3 3.5 4.7v1.8C3.5 7 3 7.5 2 7.5v1c1 0 1.5.5 1.5 1v1.8c0 1.4.5 2.2 2 2.2"
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 2.5c1.5 0 2 .8 2 2.2v1.8c0 .5.5 1 1.5 1v1c-1 0-1.5.5-1.5 1v1.8c0 1.4-.5 2.2-2 2.2"
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

function Brackets({ color }: { color: string }) {
  return (
    <path
      d="M4 4l-2 4 2 4M12 4l2 4-2 4M9.8 3l-3.6 10"
      stroke={color}
      strokeWidth="1.4"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function Terminal({ color }: { color: string }) {
  return (
    <path
      d="M3 5l3 3-3 3M7 11h6"
      stroke={color}
      strokeWidth="1.5"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function Cylinder({ color }: { color: string }) {
  return (
    <>
      <ellipse
        cx="8"
        cy="4"
        rx="5"
        ry="1.5"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <path
        d="M3 4v8c0 .9 2.2 1.5 5 1.5s5-.6 5-1.5V4"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <path
        d="M3 8c0 .9 2.2 1.5 5 1.5s5-.6 5-1.5"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
    </>
  );
}

function Picture({ color }: { color: string }) {
  return (
    <>
      <rect
        x="2"
        y="3.5"
        width="12"
        height="9"
        rx="1"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <circle cx="5" cy="6" r="0.9" fill={color} />
      <path
        d="M3 12l3-3 2.5 2.5L11 8.5l2 2"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </>
  );
}

function Box3D({ color }: { color: string }) {
  return (
    <>
      <path
        d="M2 5l6-3 6 3v6l-6 3-6-3z"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M2 5l6 3 6-3M8 8v6"
        stroke={color}
        strokeWidth="1.2"
        fill="none"
      />
    </>
  );
}

function Padlock({ color }: { color: string }) {
  return (
    <>
      <rect x="3" y="7.5" width="10" height="6.5" rx="1" fill={color} />
      <path
        d="M5 7.5V5.5a3 3 0 0 1 6 0v2"
        fill="none"
        stroke={color}
        strokeWidth="1.4"
      />
    </>
  );
}

function MusicNote({ color }: { color: string }) {
  return (
    <>
      <path
        d="M6 12V4l6-1.5V11"
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="5" cy="12" r="1.8" fill={color} />
      <circle cx="11" cy="11" r="1.8" fill={color} />
    </>
  );
}

function FilmReel({ color }: { color: string }) {
  return (
    <>
      <rect
        x="2"
        y="3.5"
        width="12"
        height="9"
        rx="1"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <path
        d="M2 5.5h2M2 8h2M2 10.5h2M12 5.5h2M12 8h2M12 10.5h2"
        stroke={color}
        strokeWidth="1.2"
      />
      <path
        d="M6 6l4 2-4 2z"
        fill={color}
      />
    </>
  );
}

function Book({ color }: { color: string }) {
  return (
    <>
      <path
        d="M3 3.5C3 3.2 3.2 3 3.5 3H8v10H3.5a.5.5 0 0 1-.5-.5V3.5z"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <path
        d="M13 3.5c0-.3-.2-.5-.5-.5H8v10h4.5a.5.5 0 0 0 .5-.5V3.5z"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <path
        d="M5 6h2M5 8h2M9 6h2M9 8h2"
        stroke={color}
        strokeWidth="0.8"
        strokeLinecap="round"
      />
    </>
  );
}

function Lines({ color }: { color: string }) {
  return (
    <>
      <GenericPaper color={color} />
      <path
        d="M5.5 8h5M5.5 10h5M5.5 12h3"
        stroke={color}
        strokeWidth="0.8"
        strokeLinecap="round"
      />
    </>
  );
}

function Diff({ colorPlus, colorMinus }: { colorPlus: string; colorMinus: string }) {
  return (
    <>
      <GenericPaper color="#6e6e6e" />
      <path d="M5 7h5M7.5 4.5v5" stroke={colorPlus} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M5 12h5" stroke={colorMinus} strokeWidth="1.2" strokeLinecap="round" />
    </>
  );
}

// ── matching helpers ──────────────────────────────────────────────────

function matchSpecialName(lower: string): ReactNode | null {
  // package managers / lock files
  if (lower === "package.json" || lower === "package-lock.json") {
    return L("npm", COL.npm, 5);
  }
  if (lower === "yarn.lock" || lower === ".yarnrc" || lower === ".yarnrc.yml") {
    return L("yarn", COL.yarn, 4.6);
  }
  if (lower === "pnpm-lock.yaml" || lower === "pnpm-workspace.yaml") {
    return L("pnpm", COL.pnpm, 4.6);
  }
  if (lower === ".npmrc") return L("npm", COL.npm, 5);

  // language toolchains by filename
  if (lower === "cargo.toml" || lower === "cargo.lock") return L("Rs", COL.rust);
  if (lower === "go.mod" || lower === "go.sum" || lower === "go.work") return L("GO", COL.go);
  if (lower === "gemfile" || lower === "gemfile.lock") return L("Rb", COL.ruby);
  if (lower === "composer.json" || lower === "composer.lock") return L("php", COL.php, 4.6);
  if (
    lower === "requirements.txt" ||
    lower === "pipfile" ||
    lower === "pipfile.lock" ||
    lower === "pyproject.toml" ||
    lower === "setup.py" ||
    lower === "setup.cfg"
  ) {
    return L("py", COL.python);
  }
  if (lower === "tsconfig.json" || lower.startsWith("tsconfig.")) return L("ts", COL.ts);
  if (lower === "jsconfig.json" || lower.startsWith("jsconfig.")) return L("js", COL.js);

  // build tools
  if (lower.startsWith("vite.config.") || lower === "vite.config") return L("vi", COL.vite);
  if (lower.startsWith("webpack.config.")) return L("wp", COL.webpack, 5);
  if (lower.startsWith("rollup.config.")) return L("rl", COL.rollup);
  if (lower.startsWith("esbuild.config.")) return L("esb", COL.esbuild, 4.6);
  if (lower.startsWith("vitest.config.")) return L("vt", COL.vitest);
  if (lower.startsWith("jest.config.")) return L("jt", COL.jest);
  if (lower.startsWith("tailwind.config.")) return L("tw", COL.tailwind);
  if (lower.startsWith("postcss.config.")) return L("pc", COL.postcss);
  if (lower.startsWith("babel.config.") || lower === ".babelrc" || lower.startsWith(".babelrc.")) {
    return L("bb", COL.babel);
  }
  if (
    lower === ".eslintrc" ||
    lower.startsWith(".eslintrc.") ||
    lower.startsWith("eslint.config.")
  ) {
    return L("es", COL.eslint);
  }
  if (
    lower === ".prettierrc" ||
    lower.startsWith(".prettierrc.") ||
    lower.startsWith("prettier.config.")
  ) {
    return L("pr", COL.prettier);
  }
  if (lower === ".editorconfig") return L("ec", COL.editorconfig);
  if (lower === "makefile" || lower === "gnumakefile") return L("mk", "#e62e2e");
  if (lower === "cmakelists.txt") return L("cm", "#064f8c");

  // git / docker / env
  if (
    lower === ".gitignore" ||
    lower === ".gitattributes" ||
    lower === ".gitmodules" ||
    lower === ".gitkeep" ||
    lower === ".gitconfig"
  ) {
    return L("git", COL.git, 5);
  }
  if (
    lower === "dockerfile" ||
    lower.startsWith("dockerfile.") ||
    lower.endsWith(".dockerfile") ||
    lower === ".dockerignore" ||
    lower === "docker-compose.yml" ||
    lower === "docker-compose.yaml" ||
    lower.startsWith("docker-compose.")
  ) {
    return L("dk", COL.docker);
  }
  if (lower === ".env" || lower.startsWith(".env.")) return L(".E", COL.env);

  // README / LICENSE / CHANGELOG
  if (
    lower === "readme" ||
    lower === "readme.md" ||
    lower === "readme.markdown" ||
    lower === "readme.txt" ||
    lower === "readme.rst"
  ) {
    return (
      <Wrap>
        <Book color={COL.md} />
      </Wrap>
    );
  }
  if (
    lower === "license" ||
    lower === "license.md" ||
    lower === "license.txt" ||
    lower === "licence" ||
    lower === "copying"
  ) {
    return L("§", "#7cb342", 9);
  }
  if (lower.startsWith("changelog") || lower.startsWith("history") || lower === "news.md") {
    return L("CH", "#519aba");
  }
  if (lower.startsWith("contributing")) return L("CN", "#ec407a");

  return null;
}

function matchByExtension(ext: string): ReactNode | null {
  switch (ext) {
    // ── markup / data ─────────────────────────────────────
    case "json":
    case "jsonc":
    case "json5":
      return (
        <Wrap>
          <Braces color={COL.json} />
        </Wrap>
      );
    case "html":
    case "htm":
      return (
        <Wrap>
          <Brackets color={COL.html} />
        </Wrap>
      );
    case "xml":
    case "xsl":
    case "xsd":
    case "plist":
      return (
        <Wrap>
          <Brackets color={COL.xml} />
        </Wrap>
      );
    case "yml":
    case "yaml":
      return L("Y", COL.yaml);
    case "toml":
      return L("toml", COL.toml, 3.8);
    case "ini":
    case "conf":
    case "cfg":
    case "properties":
      return L("ini", COL.ini, 5);
    case "csv":
    case "tsv":
      return L("csv", COL.csv, 4.6);
    case "graphql":
    case "gql":
      return L("GQL", COL.graphql, 4.6);
    case "proto":
      return L("pb", COL.proto);

    // ── frontend ──────────────────────────────────────────
    case "js":
    case "mjs":
    case "cjs":
      return L("JS", COL.js);
    case "jsx":
      return L("JSX", COL.jsx);
    case "ts":
    case "mts":
    case "cts":
      return L("TS", COL.ts);
    case "tsx":
      return L("TSX", COL.tsx);
    case "vue":
      return L("V", COL.vue);
    case "svelte":
      return L("S", COL.svelte);
    case "astro":
      return L("As", COL.astro);
    case "md":
    case "markdown":
      return L("MD", COL.md);
    case "mdx":
      return L("MDX", COL.mdx, 4.6);
    case "rst":
      return L("rst", COL.rst, 4.6);
    case "tex":
    case "latex":
    case "ltx":
      return L("TeX", COL.tex, 4.6);
    case "adoc":
    case "asciidoc":
      return L("Ad", "#519aba");

    // ── styles ────────────────────────────────────────────
    case "css":
      return L("#", COL.css, 10, 12.5);
    case "scss":
    case "sass":
      return L("SS", COL.scss);
    case "less":
      return L("LS", COL.less);
    case "styl":
    case "stylus":
      return L("St", COL.stylus);
    case "pcss":
    case "postcss":
      return L("pc", COL.postcss);

    // ── backend / systems ─────────────────────────────────
    case "py":
    case "pyi":
    case "pyw":
      return L("py", COL.python);
    case "ipynb":
      return L("py", "#ff8000");
    case "java":
    case "jav":
      return L("Jv", COL.java);
    case "class":
    case "jar":
      return L("jar", COL.java, 4.6);
    case "c":
    case "h":
      return L("C", COL.c);
    case "cpp":
    case "hpp":
    case "cc":
    case "cxx":
    case "hxx":
    case "c++":
      return L("C+", COL.cpp);
    case "cs":
    case "csx":
      return L("C#", COL.csharp);
    case "go":
      return L("GO", COL.go);
    case "rs":
      return L("Rs", COL.rust);
    case "rb":
    case "rake":
    case "gemspec":
      return L("Rb", COL.ruby);
    case "php":
    case "phtml":
    case "php5":
    case "php7":
      return L("php", COL.php, 4.6);
    case "swift":
      return L("Sw", COL.swift);
    case "kt":
    case "kts":
      return L("Kt", COL.kotlin);
    case "dart":
      return L("Dt", COL.dart);
    case "scala":
    case "sc":
      return L("Sc", COL.scala);
    case "lua":
      return L("Lu", COL.lua);
    case "pl":
    case "pm":
    case "t":
      return L("Pl", COL.perl);
    case "r":
    case "rmd":
      return L("R", COL.r);
    case "jl":
      return L("Jl", COL.julia);
    case "hs":
    case "lhs":
      return L("Hs", COL.haskell);
    case "ex":
    case "exs":
      return L("Ex", COL.elixir);
    case "erl":
    case "hrl":
      return L("Er", COL.erlang);
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return L("Cj", COL.clojure);
    case "fs":
    case "fsx":
    case "fsi":
      return L("F#", COL.fsharp);
    case "groovy":
    case "gradle":
      return L("Gr", COL.groovy);
    case "vb":
    case "vbs":
      return L("VB", COL.vb);
    case "pas":
    case "pp":
      return L("Pa", COL.pascal);
    case "f":
    case "for":
    case "f90":
    case "f95":
    case "f03":
      return L("Fr", COL.fortran);
    case "nim":
    case "nims":
      return L("Nm", COL.nim);
    case "zig":
      return L("Zg", COL.zig);
    case "v":
    case "vsh":
      return L("V", COL.v);
    case "cr":
      return L("Cr", COL.crystal);
    case "d":
    case "di":
      return L("D", COL.d);
    case "ml":
    case "mli":
      return L("ML", COL.ocaml);
    case "lisp":
    case "cl":
    case "el":
      return L("Ls", COL.lisp);
    case "scm":
    case "ss":
    case "rkt":
      return L("Sc", COL.scheme);
    case "coffee":
      return L("Co", COL.coffee);
    case "elm":
      return L("Em", COL.elm);
    case "re":
    case "rei":
      return L("Re", COL.reason);
    case "m":
    case "mm":
      return L("ObjC", COL.objc, 3.8);

    // ── shell / scripts ───────────────────────────────────
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
      return (
        <Wrap>
          <Terminal color={COL.shell} />
        </Wrap>
      );
    case "ps1":
    case "psm1":
    case "psd1":
      return (
        <Wrap>
          <Terminal color={COL.powershell} />
        </Wrap>
      );
    case "bat":
    case "cmd":
      return L("bat", COL.bat, 4.6);

    // ── data / db ─────────────────────────────────────────
    case "sql":
      return (
        <Wrap>
          <Cylinder color={COL.sql} />
        </Wrap>
      );
    case "db":
    case "sqlite":
    case "sqlite3":
      return (
        <Wrap>
          <Cylinder color={COL.db} />
        </Wrap>
      );

    // ── images ────────────────────────────────────────────
    case "svg":
      return L("svg", COL.image, 4.6);
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "ico":
    case "bmp":
    case "avif":
    case "tif":
    case "tiff":
    case "heic":
    case "heif":
      return (
        <Wrap>
          <Picture color={COL.image} />
        </Wrap>
      );

    // ── audio ─────────────────────────────────────────────
    case "mp3":
    case "wav":
    case "flac":
    case "ogg":
    case "m4a":
    case "opus":
    case "aac":
    case "wma":
      return (
        <Wrap>
          <MusicNote color={COL.audio} />
        </Wrap>
      );

    // ── video ─────────────────────────────────────────────
    case "mp4":
    case "mkv":
    case "webm":
    case "avi":
    case "mov":
    case "wmv":
    case "flv":
    case "m4v":
    case "mpg":
    case "mpeg":
      return (
        <Wrap>
          <FilmReel color={COL.video} />
        </Wrap>
      );

    // ── archives ──────────────────────────────────────────
    case "zip":
    case "tar":
    case "gz":
    case "tgz":
    case "7z":
    case "rar":
    case "bz2":
    case "xz":
    case "lz":
    case "zst":
    case "iso":
    case "dmg":
      return (
        <Wrap>
          <Box3D color={COL.archive} />
        </Wrap>
      );

    // ── documents ─────────────────────────────────────────
    case "pdf":
      return L("PDF", COL.pdf, 4.6);
    case "doc":
    case "docx":
    case "odt":
    case "rtf":
      return L("W", "#185abd");
    case "xls":
    case "xlsx":
    case "ods":
      return L("X", "#107c41");
    case "ppt":
    case "pptx":
    case "odp":
      return L("P", "#b7472a");

    // ── fonts ─────────────────────────────────────────────
    case "ttf":
    case "otf":
    case "woff":
    case "woff2":
    case "eot":
      return L("Aa", COL.font);

    // ── text / log / patch ────────────────────────────────
    case "txt":
    case "text":
      return (
        <Wrap>
          <Lines color={COL.text} />
        </Wrap>
      );
    case "log":
      return (
        <Wrap>
          <Lines color={COL.log} />
        </Wrap>
      );
    case "diff":
    case "patch":
      return (
        <Wrap>
          <Diff colorPlus="#7cb342" colorMinus="#ef5350" />
        </Wrap>
      );

    // ── lock files (generic) ──────────────────────────────
    case "lock":
      return (
        <Wrap>
          <Padlock color={COL.lock} />
        </Wrap>
      );

    default:
      return null;
  }
}

export function FileIcon({ name }: { name: string }) {
  const lower = (name || "").toLowerCase();
  const special = matchSpecialName(lower);
  if (special) return <>{special}</>;

  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const byExt = matchByExtension(ext);
  if (byExt) return <>{byExt}</>;

  return (
    <Wrap>
      <GenericPaper />
    </Wrap>
  );
}
