import type { StageLinkReason } from './stageSegment'

/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 巡测队断面测次：记录测流时段、实测流量，并向水位站过程段挂接点据水位 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /**
   * 点据水位（m）：只能由覆盖测流时段的水位过程段取得。
   * null 表示挂接失败、等待水位站补录，不能用邻段或巡测队手填水位顶替。
   */
  linkedStageM: number | null
  /** 实测流量（m³/s），由垂线测点汇总或巡测队登记 */
  measuredFlowM3s: number | null
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /** 测流开始时刻 */
  startedAt: string
  /** 测流结束时刻 */
  endedAt: string
  /** 当前挂接的水位过程段；失败但已识别过程段时也保留，便于补录后自动重取 */
  stageSegmentId: string | null
  /** 最近一次巡测队对账是否成功 */
  linkOk: boolean
  /** 挂接失败原因 / 成功说明 */
  linkReason: StageLinkReason | ''
  /** 最近一次由巡测队发起对账的时刻 */
  reconciledAt: string | null
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
  /** 只看待挂接测次 */
  pendingOnly: boolean
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null,
    pendingOnly: false
  }
}
