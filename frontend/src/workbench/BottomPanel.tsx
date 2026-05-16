interface BottomPanelProps {
  onClose: () => void;
}

export function BottomPanel({ onClose }: BottomPanelProps) {
  return (
    <div className="bottom-panel">
      <div className="bottom-panel__tabs">
        <div className="bottom-panel__tab is-active">终端</div>
        <div className="bottom-panel__tab">日志</div>
        <div className="bottom-panel__tab">任务</div>
        <button className="icon-btn bottom-panel__close" title="关闭面板" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="bottom-panel__body">
        <div className="muted">终端 / 日志 / 任务状态将在后续阶段接入。</div>
      </div>
    </div>
  );
}
