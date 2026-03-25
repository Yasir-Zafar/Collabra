import { useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

export default function Canvas({ shapes, tool, myColor, locked, onAcquireLock, onShapeAdd, onShapeUpdate, onShapeMoveStart, onShapeDelete }) {
  const svgRef  = useRef(null);
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null); // { shapeId, ox, oy }
  const [drawing,  setDrawing]  = useState(null); // { shape, startX, startY }

  function getPos(e) {
    const r = svgRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitTest(pos) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === "rect" || s.type === "diamond" || s.type === "image") {
        if (pos.x >= s.x && pos.x <= s.x + s.w && pos.y >= s.y && pos.y <= s.y + s.h) return s.id;
      } else if (s.type === "ellipse") {
        const dx = (pos.x - s.cx) / s.rx, dy = (pos.y - s.cy) / s.ry;
        if (dx*dx + dy*dy <= 1) return s.id;
      } else if (s.type === "line") {
        if (ptSegDist(pos, {x:s.x1,y:s.y1}, {x:s.x2,y:s.y2}) < 8) return s.id;
      } else if (s.type === "text") {
        if (pos.x >= s.x && pos.x <= s.x+200 && pos.y >= s.y-s.fontSize && pos.y <= s.y+6) return s.id;
      }
    }
    return null;
  }

  function ptSegDist(p, a, b) {
    const dx = b.x-a.x, dy = b.y-a.y;
    const len2 = dx*dx+dy*dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/len2));
    return Math.hypot(p.x-a.x-t*dx, p.y-a.y-t*dy);
  }

  function onMouseDown(e) {
    if (locked) return;
    const pos = getPos(e);

    if (tool === "select") {
      const hit = hitTest(pos);
      setSelected(hit);
      if (hit) {
        if (!onAcquireLock()) return;
        onShapeMoveStart && onShapeMoveStart(hit);
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

    // Drawing tools
    let shape = null;
    if (tool === "rect") {
      shape = { id: uuidv4(), type:"rect", x:pos.x, y:pos.y, w:2, h:2, fill:myColor, stroke:"#1e293b", sw:2 };
    } else if (tool === "ellipse") {
      shape = { id: uuidv4(), type:"ellipse", cx:pos.x, cy:pos.y, rx:2, ry:2, fill:myColor, stroke:"#1e293b", sw:2 };
    } else if (tool === "line") {
      shape = { id: uuidv4(), type:"line", x1:pos.x, y1:pos.y, x2:pos.x, y2:pos.y, stroke:myColor, sw:3 };
    } else if (tool === "diamond") {
      shape = { id: uuidv4(), type:"diamond", x:pos.x, y:pos.y, w:2, h:2, fill:myColor, stroke:"#1e293b", sw:2 };
    } else if (tool === "text") {
      const text = window.prompt("Enter text:", "Label");
      if (text) onShapeAdd({ id: uuidv4(), type:"text", x:pos.x, y:pos.y, text, fontSize:20, fill:myColor });
      return;
    }

    if (shape) {
      if (!onAcquireLock()) return;
      setDrawing({ shape, startX: pos.x, startY: pos.y });
    }
  }

  function onMouseMove(e) {
    const pos = getPos(e);

    if (dragging) {
      const s = shapes.find(x => x.id === dragging.shapeId);
      if (!s) return;
      let changes = {};
      if (s.type === "rect" || s.type === "diamond" || s.type === "image") {
        changes = { x: pos.x - dragging.ox, y: pos.y - dragging.oy };
      } else if (s.type === "ellipse") {
        changes = { cx: pos.x - dragging.ox, cy: pos.y - dragging.oy };
      } else if (s.type === "line") {
        const dx = pos.x - dragging.ox - s.x1, dy = pos.y - dragging.oy - s.y1;
        changes = { x1: s.x1+dx, y1: s.y1+dy, x2: s.x2+dx, y2: s.y2+dy };
      } else if (s.type === "text") {
        changes = { x: pos.x - dragging.ox, y: pos.y - dragging.oy };
      }
      onShapeUpdate(dragging.shapeId, changes);
      return;
    }

    if (drawing) {
      const { startX, startY, shape } = drawing;
      const dx = pos.x - startX, dy = pos.y - startY;
      let updated = shape;
      if (shape.type === "rect" || shape.type === "diamond") {
        updated = { ...shape, x: dx<0?pos.x:startX, y: dy<0?pos.y:startY, w: Math.max(2,Math.abs(dx)), h: Math.max(2,Math.abs(dy)) };
      } else if (shape.type === "ellipse") {
        updated = { ...shape, rx: Math.max(2,Math.abs(dx)), ry: Math.max(2,Math.abs(dy)) };
      } else if (shape.type === "line") {
        updated = { ...shape, x2: pos.x, y2: pos.y };
      }
      setDrawing(d => ({ ...d, shape: updated }));
    }
  }

  function onMouseUp() {
    if (drawing) { onShapeAdd(drawing.shape); setDrawing(null); }
    if (dragging) setDragging(null);
  }

  function renderShape(s, preview = false) {
    const sel = !preview && s.id === selected;
    const selStroke     = sel ? "#6366f1" : undefined;
    const selSW         = sel ? 2 : undefined;
    const selDash       = sel ? "5,3" : undefined;
    const moveStyle     = { cursor: "move" };

    if (s.type === "rect") return (
        <rect key={s.id} x={s.x} y={s.y} width={s.w} height={s.h} rx={4}
              fill={s.fill} stroke={sel ? selStroke : s.stroke} strokeWidth={sel ? selSW : s.sw}
              strokeDasharray={selDash} style={moveStyle} />
    );
    if (s.type === "diamond") {
      const cx = s.x+s.w/2, cy = s.y+s.h/2;
      return <polygon key={s.id} style={moveStyle}
                      points={`${cx},${s.y} ${s.x+s.w},${cy} ${cx},${s.y+s.h} ${s.x},${cy}`}
                      fill={s.fill} stroke={sel ? selStroke : s.stroke} strokeWidth={sel ? selSW : s.sw}
                      strokeDasharray={selDash} />;
    }
    if (s.type === "ellipse") return (
        <ellipse key={s.id} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry}
                 fill={s.fill} stroke={sel ? selStroke : s.stroke} strokeWidth={sel ? selSW : s.sw}
                 strokeDasharray={selDash} style={moveStyle} />
    );
    if (s.type === "line") return (
        <line key={s.id} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
              stroke={sel ? selStroke : s.stroke} strokeWidth={sel ? selSW : s.sw}
              strokeLinecap="round" style={moveStyle} />
    );
    if (s.type === "text") return (
        <text key={s.id} x={s.x} y={s.y} fontSize={s.fontSize} fill={s.fill}
              fontFamily="system-ui,sans-serif" style={moveStyle}
              stroke={sel ? selStroke : "none"} strokeWidth={sel ? 0.4 : 0}>
          {s.text}
        </text>
    );
    if (s.type === "image") return (
        <g key={s.id} style={moveStyle}>
          <image href={s.href} x={s.x} y={s.y} width={s.w} height={s.h} />
          {sel && <rect x={s.x} y={s.y} width={s.w} height={s.h}
                        fill="none" stroke="#6366f1" strokeWidth={2} strokeDasharray="5,3" />}
        </g>
    );
    return null;
  }

  const cursor = locked ? "not-allowed" : tool === "select" ? "default" : "crosshair";

  return (
      <svg ref={svgRef} className="canvas-svg" style={{ cursor }}
           onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
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