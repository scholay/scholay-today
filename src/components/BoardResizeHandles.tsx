import ResizeHandle from "./ResizeHandle";
import { BOARD_PANE_BOUNDS } from "../lib/boardPanes";
import type { useBoardPanes } from "../hooks/useBoardPanes";

export default function BoardResizeHandles({ panes, hasList, label }: {
  panes: ReturnType<typeof useBoardPanes>; hasList: boolean; label: string;
}) {
  return <>
    <div className="resize-handle-slot board-resize-slot" data-pane="sidebar" style={{ left: panes.widths.sidebarWidth }}>
      <ResizeHandle width={panes.widths.sidebarWidth} side="right" min={BOARD_PANE_BOUNDS.sidebar.min}
        max={panes.sidebarMax} onResize={width => panes.resize("sidebar", width)} label={`调整${label}侧栏宽度`}/>
    </div>
    {hasList && <div className="resize-handle-slot board-resize-slot" style={{ left: panes.widths.sidebarWidth + panes.widths.listWidth }}>
      <ResizeHandle width={panes.widths.listWidth} side="right" min={BOARD_PANE_BOUNDS.list.min}
        max={panes.listMax} onResize={width => panes.resize("list", width)} label={`调整${label}列表宽度`}/>
    </div>}
  </>;
}
