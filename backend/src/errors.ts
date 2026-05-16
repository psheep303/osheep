export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errors = {
  invalidPath: (msg = "路径格式非法") => new ApiError(400, "INVALID_PATH", msg),
  pathOutside: () =>
    new ApiError(403, "PATH_OUTSIDE_WORKSPACE", "路径越出工作区边界"),
  workspaceNotFound: (id: string) =>
    new ApiError(404, "WORKSPACE_NOT_FOUND", `工作区不存在: ${id}`),
  notFound: (msg = "目标不存在") => new ApiError(404, "NOT_FOUND", msg),
  parentNotFound: () =>
    new ApiError(404, "PARENT_NOT_FOUND", "父目录不存在"),
  isDirectory: () => new ApiError(400, "IS_A_DIRECTORY", "目标是目录"),
  notDirectory: () => new ApiError(400, "NOT_A_DIRECTORY", "目标不是目录"),
  entryExists: () => new ApiError(409, "ENTRY_EXISTS", "同名条目已存在"),
  dirNotEmpty: () => new ApiError(409, "DIR_NOT_EMPTY", "目录非空且未带 recursive"),
  fileTooLarge: (limit: number) =>
    new ApiError(413, "FILE_TOO_LARGE", `文件超过上限 ${limit} 字节`),
  ioError: (msg: string) => new ApiError(500, "IO_ERROR", msg),
  unsupportedShell: (id: string) =>
    new ApiError(400, "UNSUPPORTED_SHELL", `服务器未探测到 shell: ${id}`),
  sessionNotFound: (id: string) =>
    new ApiError(404, "SESSION_NOT_FOUND", `终端会话不存在: ${id}`),
  invalidSize: () =>
    new ApiError(400, "INVALID_SIZE", "cols / rows 必须在 1..1000 之间"),
  ptySpawnFailed: (msg: string) =>
    new ApiError(500, "PTY_SPAWN_FAILED", `PTY 启动失败: ${msg}`),
  tooManySessions: (limit: number) =>
    new ApiError(429, "TOO_MANY_SESSIONS", `并发会话数达到上限 ${limit}`),
};
