import { useEffect } from "react";
import HotBoard from "./HotBoard";
import LabelBoard from "../labels/LabelBoard";
import { saveTrendsSection, type TrendsSection } from "./trendsSection";

export default function TrendsWorkspace({ active, section }: { active: boolean; section: TrendsSection }) {
  useEffect(() => { saveTrendsSection(section); }, [section]);
  return section === "labels"
    ? <LabelBoard active={active}/>
    : <HotBoard active={active}/>;
}
