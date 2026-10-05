/** 水位站分段记录的逐时读数；空读数必须显式保留，不能用邻段或邻时代替 */
export interface StageReading {
  /** 读数时刻（ISO 字符串） */
  at: string
  /** 水位（m）；null 表示自记水位计该时读数为空，等待水位站补录 */
  stageM: number | null
}

/** 水位过程段：由水位站维护起止时刻与逐时读数 */
export interface StageSegment {
  id: string
  /** 所属测站 */
  stationId: string
  /** 段号，如 2024-06-S1 */
  segmentNo: string
  /** 过程段开始时刻 */
  startedAt: string
  /** 过程段结束时刻 */
  endedAt: string
  /** 逐时水位读数，允许空读数 */
  readings: StageReading[]
  /** 水位站补录备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 测流时段与水位过程段挂接失败原因 */
export type StageLinkReason =
  | '缺少覆盖测流时段的水位过程段'
  | '多个水位过程段同时覆盖测流时段'
  | '水位过程段读数为空'
  | '测流时段缺少完整逐时水位读数'

/** 按测流时段从水位过程段取点据水位的结果 */
export interface StageLinkResult {
  ok: boolean
  segmentId: string | null
  stageM: number | null
  reason: StageLinkReason | ''
}

export const STAGE_LINK_PENDING: StageLinkResult = {
  ok: false,
  segmentId: null,
  stageM: null,
  reason: '缺少覆盖测流时段的水位过程段'
}

/** 读数按时刻升序，空读数原样保留 */
export function sortReadings(readings: StageReading[]): StageReading[] {
  return [...readings].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** 过程段是否完整盖住测流起止时刻 */
export function segmentCoversInterval(
  segment: Pick<StageSegment, 'startedAt' | 'endedAt'>,
  startedAt: string,
  endedAt: string
): boolean {
  const segmentStart = Date.parse(segment.startedAt)
  const segmentEnd = Date.parse(segment.endedAt)
  const measureStart = Date.parse(startedAt)
  const measureEnd = Date.parse(endedAt)
  return (
    Number.isFinite(segmentStart) &&
    Number.isFinite(segmentEnd) &&
    Number.isFinite(measureStart) &&
    Number.isFinite(measureEnd) &&
    segmentStart <= measureStart &&
    segmentEnd >= measureEnd
  )
}

/**
 * 找出唯一完整覆盖测流时段的水位过程段。
 * 邻段不拼接、不外推；若多个段重叠覆盖，交由水位站先修正过程段。
 */
export function findCoveringSegment(
  segments: StageSegment[],
  stationId: string,
  startedAt: string,
  endedAt: string
): StageSegment | null {
  const matched = segments
    .filter((segment) => segment.stationId === stationId)
    .filter((segment) => segmentCoversInterval(segment, startedAt, endedAt))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  if (matched.length === 0) return null
  if (matched.length > 1) return null
  return matched[0]
}

/** 同站覆盖测流时段的过程段数量，用于区分缺段与过程段重叠 */
export function countCoveringSegments(
  segments: StageSegment[],
  stationId: string,
  startedAt: string,
  endedAt: string
): number {
  return segments
    .filter((segment) => segment.stationId === stationId)
    .filter((segment) => segmentCoversInterval(segment, startedAt, endedAt)).length
}

/** 用同一过程段的逐时读数在 [start,end] 上做时间加权（梯形）平均水位 */
function timeWeightedStage(readings: StageReading[], startedAt: string, endedAt: string): number | null {
  const intervalStart = Date.parse(startedAt)
  const intervalEnd = Date.parse(endedAt)
  if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) return null

  const points = sortReadings(readings)
    .map((reading) => ({ t: Date.parse(reading.at), h: reading.stageM }))
    .filter((point) => Number.isFinite(point.t))
  if (points.length === 0) return null

  const before = points.filter((point) => point.t <= intervalStart).at(-1)
  const after = points.find((point) => point.t >= intervalEnd)
  if (!before || !after) return null

  // 只要求覆盖测流时段所需的读数非空；段内其他时段的空读数不影响本测次。
  const needed = points.filter((point) => point.t >= before.t && point.t <= after.t)
  if (needed.some((point) => point.h === null || !Number.isFinite(point.h))) return null
  const values = needed as Array<{ t: number; h: number }>

  let previous = values[0]
  let area = 0
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index]
    const left = Math.max(previous.t, intervalStart)
    const right = Math.min(current.t, intervalEnd)
    if (right > left) area += ((previous.h + current.h) / 2) * (right - left)
    previous = current
  }

  return Number((area / (intervalEnd - intervalStart)).toFixed(3))
}

/**
 * 巡测队对账时只读水位过程段，不修改过程段：
 * 1. 必须由同站且唯一的过程段完整覆盖测流时段；
 * 2. 读数表为空或测流时段内有空读数时挂起，等待水位站补录；
 * 3. 绝不拿邻段水位顶替。
 */
export function resolveStageFromSegments(
  segments: StageSegment[],
  stationId: string,
  startedAt: string,
  endedAt: string
): StageLinkResult {
  const segment = findCoveringSegment(segments, stationId, startedAt, endedAt)
  if (!segment) {
    const reason = countCoveringSegments(segments, stationId, startedAt, endedAt) > 1
      ? '多个水位过程段同时覆盖测流时段'
      : '缺少覆盖测流时段的水位过程段'
    return { ok: false, segmentId: null, stageM: null, reason }
  }
  const readings = sortReadings(segment.readings)
  if (readings.length === 0) {
    return { ok: false, segmentId: segment.id, stageM: null, reason: '水位过程段读数为空' }
  }
  const stageM = timeWeightedStage(readings, startedAt, endedAt)
  if (stageM === null) {
    return { ok: false, segmentId: segment.id, stageM: null, reason: '测流时段缺少完整逐时水位读数' }
  }
  return { ok: true, segmentId: segment.id, stageM, reason: '' }
}
