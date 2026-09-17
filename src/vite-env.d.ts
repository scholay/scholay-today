/// <reference types="vite/client" />

declare module "react-vertical-timeline-component" {
  import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

  export function VerticalTimeline(props: {
    animate?: boolean;
    className?: string;
    layout?: "1-column-left" | "1-column" | "2-columns" | "1-column-right";
    lineColor?: string;
    children?: ReactNode;
  }): ReactNode;

  export function VerticalTimelineElement(props: {
    children?: ReactNode;
    className?: string;
    contentArrowStyle?: CSSProperties;
    contentStyle?: CSSProperties;
    date?: ReactNode;
    dateClassName?: string;
    icon?: ReactNode;
    iconClassName?: string;
    iconStyle?: CSSProperties;
    iconOnClick?: MouseEventHandler;
    onTimelineElementClick?: MouseEventHandler;
    id?: string;
    position?: string;
    style?: CSSProperties;
    textClassName?: string;
    visible?: boolean;
    shadowSize?: "small" | "medium" | "large";
  }): ReactNode;
}
