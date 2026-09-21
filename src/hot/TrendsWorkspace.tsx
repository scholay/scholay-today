import { useEffect, useState } from "react";
import HotBoard from "./HotBoard";
import LabelBoard from "../labels/LabelBoard";
import { saveTrendsSection, type TrendsSection } from "./trendsSection";

export default function TrendsWorkspace({ active, section }: { active: boolean; section: TrendsSection }) {
  const [labelsVisited, setLabelsVisited] = useState(section === "labels");
  const [hotVisited, setHotVisited] = useState(section === "hot");
  useEffect(() => { saveTrendsSection(section); }, [section]);
  useEffect(() => { if (section === "labels") setLabelsVisited(true); else setHotVisited(true); }, [section]);
  return <div className="trends-panels">
    <div className={`workspace-panel ${section !== "hot" ? "is-inactive" : ""}`} aria-hidden={section !== "hot"} inert={section !== "hot"}>
      {hotVisited && <HotBoard active={active && section === "hot"}/>}
    </div>
    <div className={`workspace-panel ${section !== "labels" ? "is-inactive" : ""}`} aria-hidden={section !== "labels"} inert={section !== "labels"}>
      {labelsVisited && <LabelBoard active={active && section === "labels"}/>}
    </div>
  </div>;
}
