import type { LinkageStatus } from './waterLevel'

/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 断面测次：巡测队记录的一次完整流量测验 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /**
   * 历史字段：巡测队旧台账中的现场水位。
   * v3 起点据水位只取自水位站过程段，新增测次不再使用该字段。
   */
  stageM?: number | null
  /** 实测断面流量（m³/s），由垂线测点汇总或手工确认 */
  measuredFlowM3s: number
  /** 该测次整编到的定线号 */
  lineNo: string
  /** 水位过程挂接状态 */
  linkageStatus: LinkageStatus
  /** 挂接失败原因 */
  linkageMessage?: string
  /** 最近一次挂接尝试时间；由巡测侧重试，不改动水位过程 */
  linkedAt?: string | null
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /** 测流开始时刻 */
  measureStartAt: string
  /** 测流结束时刻 */
  measureEndAt: string
  /** 历史字段：旧版单一测流时间 */
  measuredAt?: string
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m）；对待挂接测次不参与水位筛选 */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
