import type { CalendarMedia } from "./types";

/**
 * Small, editorially reviewed image batch. Keep this out of the source JSON:
 * the raw historical records remain facts and citations, while media can be
 * replaced or withdrawn without changing either. Only assets with a clear
 * source credit and reuse basis may be placed here.
 */
export const HISTORY_MEDIA_BY_TITLE: Readonly<Record<string, CalendarMedia>> = {
  "Voyager 2 发射": {
    imageUrl: "https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia01/pia01480/PIA01480.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg",
    sourcePage: "https://science.nasa.gov/photojournal/voyager-2-launch/",
    credit: "NASA/JPL",
    alt: "旅行者 2 号发射照片",
    reuseStatus: "cleared",
    reviewedAt: "2026-09-27",
  },
  "Voyager 2 首次飞掠天王星": {
    imageUrl: "https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia01/pia01391/PIA01391.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg",
    sourcePage: "https://science.nasa.gov/photojournal/uranus/",
    credit: "NASA/JPL",
    alt: "旅行者 2 号拍摄的天王星",
    reuseStatus: "cleared",
    reviewedAt: "2026-09-27",
  },
  "Voyager 1 拍下“暗淡蓝点”": {
    imageUrl: "https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia23/pia23645/PIA23645.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg",
    sourcePage: "https://science.nasa.gov/resource/voyager-pale-blue-dot-download/",
    credit: "NASA/JPL-Caltech",
    alt: "旅行者 1 号拍摄的暗淡蓝点中的地球",
    reuseStatus: "cleared",
    reviewedAt: "2026-09-27",
  },
  "Apollo 8 成为首个进入月球轨道的载人任务": {
    imageUrl: "https://assets.science.nasa.gov/content/dam/science/psd/lunar-science/2023/08/apollo8_earthrise_1200.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg",
    sourcePage: "https://science.nasa.gov/resource/the-rising-earth-as-seen-by-apollo-8/",
    credit: "NASA",
    alt: "阿波罗 8 号在月球轨道拍摄的地出",
    reuseStatus: "cleared",
    reviewedAt: "2026-09-27",
  },
  "Mariner 2 首次成功飞掠另一颗行星": {
    imageUrl: "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/p/2/P2345B_opt.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg",
    sourcePage: "https://science.nasa.gov/resource/mariner-2-first-to-explore-another-planet/",
    credit: "NASA/JPL-Caltech",
    alt: "水手 2 号传回的金星飞掠数据打印图",
    reuseStatus: "cleared",
    reviewedAt: "2026-09-27",
    fit: "contain",
  },
  "LIGO 宣布首次直接探测到引力波": {
    imageUrl: "https://www.ligo.caltech.edu/system/avm_image_sqls/binaries/45/medium/ligo20160211a.jpg",
    sourcePage: "https://www.ligo.caltech.edu/MIT/image/ligo20160211a",
    credit: "Courtesy Caltech/MIT/LIGO Laboratory",
    alt: "LIGO 首次引力波探测发布图表",
    reuseStatus: "cleared",
    reviewedAt: "2026-09-27",
    fit: "contain",
  },
};
