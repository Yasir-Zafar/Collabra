import { useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

export default function Canvas({ shapes, tool, onShapeAdd, onShapeUpdate, onShapeDelete, locked, myColor }) {
  const svgRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null);   // { shapeId, ox, oy }
  const [drawing, setDrawing] = useState(null);     // { shape, startX, startY }

  function getPos(e) {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hitTest(pos) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === "rect" || s.type === "diamond") {
        if (pos.x >= s.x && pos.x <= s.x + s.w && pos.y >= s.y && pos.y <= s.y + s.h) return s.id;
      } else if (s.type === "ellipse") {
        const dx = (pos.x - s.cx) / s.rx;
        const dy = (pos.y - s.cy) / s.ry;
        if (dx * dx + dy * dy <= 1) return s.id;
      } else if (s.type === "line") {
        const d = ptSegDist(pos, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
        if (d < 8) return s.id;
      } else if (s.type === "text") {
        if (pos.x >= s.x && pos.x <= s.x + 200 && pos.y >= s.y - s.fontSize && pos.y <= s.y + 6) return s.id;
      }
    }
    return null;
  }

  function ptSegDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }

  function onMouseDown(e) {
    if (locked) return;
    const pos = getPos(e);

    if (tool === "select") {
      const hit = hitTest(pos);
      setSelected(hit);
      if (hit) {
        const s = shapes.find(x => x.id === hit);
        const ox = pos.x - (s.x ?? s.cx ?? s.x1);
        const oy = pos.y - (s.y ?? s.cy ?? s.y1);
        setDragging({ shapeId: hit, ox, oy });
      }
      return;
    }

    if (tool === "delete") {
      const hit = hitTest(pos);
      if (hit) onShapeDelete(hit);
      return;
    }

    // Start drawing a new shape
    let shape;
    if (tool === "rect") {
      shape = { id: uuidv4(), type: "rect", x: pos.x, y: pos.y, w: 2, h: 2, fill: myColor, stroke: "#1e293b", sw: 2 };
    } else if (tool === "ellipse") {
      shape = { id: uuidv4(), type: "ellipse", cx: pos.x, cy: pos.y, rx: 2, ry: 2, fill: myColor, stroke: "#1e293b", sw: 2 };
    } else if (tool === "line") {
      shape = { id: uuidv4(), type: "line", x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y, stroke: myColor, sw: 3 };
    } else if (tool === "diamond") {
      shape = { id: uuidv4(), type: "diamond", x: pos.x, y: pos.y, w: 2, h: 2, fill: myColor, stroke: "#1e293b", sw: 2 };
    } else if (tool === "text") {
      const text = window.prompt("Enter text:", "Label");
      if (text) {
        const shape = { id: uuidv4(), type: "text", x: pos.x, y: pos.y, text, fontSize: 20, fill: myColor };
        onShapeAdd(shape);
      }
      return;
    }
    if (shape) setDrawing({ shape, startX: pos.x, startY: pos.y });
  }

  function onMouseMove(e) {
    const pos = getPos(e);

    if (dragging) {
      const s = shapes.find(x => x.id === dragging.shapeId);
      if (!s) return;
      let changes = {};
      if (s.type === "rect" || s.type === "diamond") {
        changes = { x: pos.x - dragging.ox, y: pos.y - dragging.oy };
      } else if (s.type === "ellipse") {
        changes = { cx: pos.x - dragging.ox, cy: pos.y - dragging.oy };
      } else if (s.type === "line") {
        const dx = pos.x - dragging.ox - s.x1;
        const dy = pos.y - dragging.oy - s.y1;
        changes = { x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
      } else if (s.type === "text") {
        changes = { x: pos.x - dragging.ox, y: pos.y - dragging.oy };
      }
      onShapeUpdate(dragging.shapeId, changes);
      return;
    }

    if (drawing) {
      const { startX, startY, shape } = drawing;
      const dx = pos.x - startX, dy = pos.y - startY;
      let updated;
      if (shape.type === "rect" || shape.type === "diamond") {
        const x = dx < 0 ? pos.x : startX;
        const y = dy < 0 ? pos.y : startY;
        updated = { ...shape, x, y, w: Math.abs(dx) || 2, h: Math.abs(dy) || 2 };
      } else if (shape.type === "ellipse") {
        updated = { ...shape, rx: Math.max(2, Math.abs(dx)), ry: Math.max(2, Math.abs(dy)) };
      } else if (shape.type === "line") {
        updated = { ...shape, x2: pos.x, y2: pos.y };
      }
      setDrawing(d => ({ ...d, shape: updated }));
    }
  }

  function onMouseUp() {
    if (drawing) {
      onShapeAdd(drawing.shape);
      setDrawing(null);
    }
    if (dragging) setDragging(null);
  }

  function renderShape(s, isPreview = false) {
    const isSel = !isPreview && s.id === selected;
    const selStyle = isSel ? { filter: "drop-shadow(0 0 5px #6366f1)" } : {};

    if (s.type === "rect") return (
      <rect key={s.id} x={s.x} y={s.y} width={s.w} height={s.h}
        fill={s.fill} stroke={isSel ? "#6366f1" : s.stroke} strokeWidth={isSel ? 3 : s.sw}
        rx={4} style={{ cursor: "move", ...selStyle }} />
    );
    if (s.type === "diamond") {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const pts = `${cx},${s.y} ${s.x + s.w},${cy} ${cx},${s.y + s.h} ${s.x},${cy}`;
      return <polygon key={s.id} points={pts} fill={s.fill}
        stroke={isSel ? "#6366f1" : s.stroke} strokeWidth={isSel ? 3 : s.sw}
        style={{ cursor: "move", ...selStyle }} />;
    }
    if (s.type === "ellipse") return (
      <ellipse key={s.id} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry}
        fill={s.fill} stroke={isSel ? "#6366f1" : s.stroke} strokeWidth={isSel ? 3 : s.sw}
        style={{ cursor: "move", ...selStyle }} />
    );
    if (s.type === "line") return (
      <line key={s.id} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
        stroke={isSel ? "#6366f1" : s.stroke} strokeWidth={isSel ? 4 : s.sw}
        strokeLinecap="round" style={{ cursor: "move", ...selStyle }} />
    );
    if (s.type === "text") return (
      <text key={s.id} x={s.x} y={s.y} fontSize={s.fontSize} fill={s.fill}
        fontFamily="system-ui,sans-serif" style={{ cursor: "move", ...selStyle }}
        stroke={isSel ? "#6366f1" : "none"} strokeWidth={isSel ? 0.4 : 0}>
        {s.text}
      </text>
    );
    return null;
  }

  const cursor = locked ? "not-allowed" : tool === "select" ? "default" : tool === "delete" ? "crosshair" : "crosshair";

  return (
    <svg
      ref={svgRef}
      className="canvas-svg"
      style={{ cursor }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <defs>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#e2e8f0" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
      {shapes.map(s => renderShape(s))}
      {drawing && renderShape(drawing.shape, true)}
    </svg>
  );
}
