import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { errors } from "./errors.js";

export interface TemplateRegistrySource {
	type: "github" | "cdn";
	repo: string;
	path?: string;
}

export interface TemplateRegistryEntry {
	id: string;
	name: string;
	description: string;
	source: TemplateRegistrySource;
	version: string;
}

export interface TemplateRegistry {
	version: string;
	templates: TemplateRegistryEntry[];
}

export interface TemplateRegistryOptions {
	registryUrl?: string;
	destinationRoot?: string;
	fetchImpl?: typeof fetch;
}

const DEFAULT_REGISTRY_URL =
	"https://raw.githubusercontent.com/psheep303/osheep-template-registry/main/registry.json";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REQUIRED_FILES = ["workflow.json", "README.md"] as const;
const ICON_NAMES = [
	"icon.png",
	"icon.jpg",
	"icon.jpeg",
	"icon.webp",
	"icon.gif",
	"icon.svg",
];

function normalizeSourcePath(value: string | undefined): string | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const normalized = value.replace(/^\/+|\/+$/g, "");
	if (
		!normalized ||
		normalized.includes("\\") ||
		normalized.split("/").some((part) => part === ".." || part === ".")
	) {
		return undefined;
	}
	return normalized;
}

function opts(value: TemplateRegistryOptions = {}) {
	return {
		registryUrl:
			value.registryUrl ?? config.templateRegistryUrl ?? DEFAULT_REGISTRY_URL,
		destinationRoot: value.destinationRoot ?? config.systemTemplatesRoot,
		fetchImpl: value.fetchImpl ?? fetch,
	};
}

function parseRegistry(raw: unknown): TemplateRegistry {
	if (!raw || typeof raw !== "object")
		throw errors.ioError("template registry is invalid");
	const value = raw as { version?: unknown; templates?: unknown };
	if (typeof value.version !== "string" || !Array.isArray(value.templates)) {
		throw errors.ioError("template registry is invalid");
	}
	const templates: TemplateRegistryEntry[] = [];
	for (const item of value.templates) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		const source = candidate.source as Record<string, unknown> | undefined;
		if (
			typeof candidate.id !== "string" ||
			!ID_RE.test(candidate.id) ||
			typeof candidate.name !== "string" ||
			typeof candidate.description !== "string" ||
			typeof candidate.version !== "string" ||
			!source ||
			(source.type !== "github" && source.type !== "cdn") ||
			typeof source.repo !== "string" ||
			!REPO_RE.test(source.repo) ||
			(source.path !== undefined && typeof source.path !== "string")
		) {
			continue;
		}
		const sourcePath = normalizeSourcePath(
			typeof source.path === "string" ? source.path : undefined,
		);
		if (typeof source.path === "string" && source.path.trim() && !sourcePath)
			continue;
		templates.push({
			id: candidate.id,
			name: candidate.name,
			description: candidate.description,
			source: {
				type: source.type,
				repo: source.repo,
				path: sourcePath,
			},
			version: candidate.version,
		});
	}
	return { version: value.version, templates };
}

async function fetchText(
	url: string,
	fetchImpl: typeof fetch,
): Promise<string> {
	const response = await fetchImpl(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok)
		throw errors.upstreamFailed(
			`template registry request failed (${response.status})`,
		);
	return await response.text();
}

export async function loadTemplateRegistry(
	value: TemplateRegistryOptions = {},
): Promise<TemplateRegistry> {
	const { registryUrl, fetchImpl } = opts(value);
	return parseRegistry(JSON.parse(await fetchText(registryUrl, fetchImpl)));
}

export function templateFileUrls(
	entry: TemplateRegistryEntry,
	file: string,
): string[] {
	const prefix = entry.source.path ? `${entry.source.path}/` : "";
	const encodedPath = `${prefix}${file}`
		.split("/")
		.map(encodeURIComponent)
		.join("/");
	const refs = [entry.version];
	if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(entry.version))
		refs.push(`v${entry.version}`);
	refs.push("main", "master");
	const urls: string[] = [];
	for (const ref of refs) {
		const encodedRef = encodeURIComponent(ref);
		const cdn = `${config.templateCdnBaseUrl.replace(/\/$/, "")}/${entry.source.repo}@${encodedRef}/${encodedPath}`;
		const github = `https://raw.githubusercontent.com/${entry.source.repo}/${encodedRef}/${encodedPath}`;
		urls.push(...(entry.source.type === "cdn" ? [cdn, github] : [github, cdn]));
	}
	return [...new Set(urls)];
}

async function fetchFile(
	entry: TemplateRegistryEntry,
	file: string,
	fetchImpl: typeof fetch,
): Promise<Uint8Array> {
	let lastStatus = 0;
	for (const url of templateFileUrls(entry, file)) {
		try {
			const response = await fetchImpl(url, {
				signal: AbortSignal.timeout(30_000),
			});
			if (response.ok) return new Uint8Array(await response.arrayBuffer());
			lastStatus = response.status;
		} catch {
			// Try the alternate source.
		}
	}
	throw errors.upstreamFailed(
		`template file unavailable: ${file} (${lastStatus || "network error"})`,
	);
}

function safeEntryPath(root: string, id: string): string {
	if (!ID_RE.test(id)) throw errors.invalidPath("template id is invalid");
	return path.join(root, id);
}

export async function installRegistryTemplate(
	entryOrId: TemplateRegistryEntry | string,
	value: TemplateRegistryOptions = {},
): Promise<{ id: string; directory: string }> {
	const settings = opts(value);
	const entry =
		typeof entryOrId === "string"
			? (await loadTemplateRegistry(settings)).templates.find(
					(item) => item.id === entryOrId,
				)
			: entryOrId;
	if (!entry)
		throw errors.notFound(
			`template not found: ${typeof entryOrId === "string" ? entryOrId : entryOrId.id}`,
		);
	const directory = safeEntryPath(settings.destinationRoot, entry.id);
	const files = new Map<string, Uint8Array>();
	for (const file of REQUIRED_FILES)
		files.set(file, await fetchFile(entry, file, settings.fetchImpl));
	for (const icon of ICON_NAMES) {
		try {
			files.set(icon, await fetchFile(entry, icon, settings.fetchImpl));
			break;
		} catch {
			// Icons are optional.
		}
	}
	let workflow: Record<string, unknown>;
	try {
		workflow = JSON.parse(
			new TextDecoder().decode(files.get("workflow.json")),
		) as Record<string, unknown>;
	} catch {
		throw errors.invalidPath("workflow.json is invalid");
	}
	if (
		!workflow ||
		typeof workflow !== "object" ||
		!Array.isArray(workflow.nodes) ||
		!Array.isArray(workflow.edges)
	) {
		throw errors.invalidPath("workflow.json must contain nodes and edges");
	}
	const readme = new TextDecoder().decode(files.get("README.md"));
	const iconFile = ICON_NAMES.find((name) => files.has(name));
	const template = {
		id: entry.id,
		source: "system",
		title: entry.name,
		description: entry.description,
		version: entry.version,
		readme,
		iconFile,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		nodes: workflow.nodes,
		edges: workflow.edges,
	};
	await fs.rm(directory, { recursive: true, force: true });
	await fs.mkdir(directory, { recursive: true });
	for (const [name, data] of files)
		await fs.writeFile(path.join(directory, name), data);
	await fs.writeFile(
		path.join(directory, "template.json"),
		JSON.stringify(template, null, 2),
		"utf8",
	);
	return { id: entry.id, directory };
}

export { DEFAULT_REGISTRY_URL };
