import { useRef } from "react";

type Axis = "x" | "y";

interface ResizerProps {
  axis: Axis;
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

export function Resizer({
  axis,
  onResize,
  onResizeStart,
  onResizeEnd,
}: ResizerProps) {
  const lastRef = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    lastRef.current = axis === "x" ? e.clientX : e.clientY;
    document.body.classList.add(
      axis === "x" ? "is-resizing-x" : "is-resizing-y"
    );
    onResizeStart?.();

    const onMove = (ev: MouseEvent) => {
      const cur = axis === "x" ? ev.clientX : ev.clientY;
      const delta = cur - lastRef.current;
      lastRef.current = cur;
      if (delta !== 0) onResize(delta);
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing-x", "is-resizing-y");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onResizeEnd?.();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`resizer resizer--${axis}`}
      onMouseDown={onMouseDown}
      role="separator"
    />
  );
}
