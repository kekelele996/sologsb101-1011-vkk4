/** 自记水位计的逐时读数；stageM 为 null 表示该时刻读数待补录 */
export interface WaterLevelReading {
  observedAt: string
  stageM: number | null
}

/** 水位站维护的水位过程段 */
export interface WaterLevelSegment {
  id: string
  stationId: string
  /** 过程段开始时刻 */
  startsAt: string
  /** 过程段结束时刻 */
  endsAt: string
  /** 自记水位计逐时水位读数 */
  readings: WaterLevelReading[]
  /** 仪器或记录备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

export type LinkageStatus = 'linked' | 'pending' | 'manual'

export interface SegmentMatch {
  segment: WaterLevelSegment
  /** 测流时段内参与计算的有效读数 */
  matchedReadings: WaterLevelReading[]
  /** 测流时段内待补录的读数 */
  missingReadings: WaterLevelReading[]
  /** 点据采用水位：测流时段内有效读数的算术平均值 */
  stageM: number
}

export type LinkageResult =
  | { ok: true; match: SegmentMatch; message: string }
  | {
      ok: false
      reason: 'segment-missing' | 'reading-missing' | 'reading-empty' | 'invalid-interval'
      message: string
      segmentId?: string
    }

function timeOf(value: string): number {
  return Date.parse(value)
}

/** 找出完整盖住测流时段的水位过程段；不允许用只重叠或相邻的过程段顶替 */
export function findCoveringSegment(
  segments: WaterLevelSegment[],
  stationId: string,
  measureStartAt: string,
  measureEndAt: string
): WaterLevelSegment | null {
  const start = timeOf(measureStartAt)
  const end = timeOf(measureEndAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null

  return (
    segments
      .filter((segment) => {
        if (segment.stationId !== stationId) return false
        const segmentStart = timeOf(segment.startsAt)
        const segmentEnd = timeOf(segment.endsAt)
        return segmentStart <= start && segmentEnd >= end
      })
      // 多个过程段均覆盖时，取时间跨度最小、起止最贴近测流时段的一段
      .sort((a, b) => {
        const spanA = timeOf(a.endsAt) - timeOf(a.startsAt)
        const spanB = timeOf(b.endsAt) - timeOf(b.startsAt)
        if (spanA !== spanB) return spanA - spanB
        return timeOf(a.startsAt) - timeOf(b.startsAt)
      })[0] ?? null
  )
}

/**
 * 按测流时段与水位过程段对账。
 * 只有完整覆盖测流时段、且时段内读数均非空时才挂接成功；
 * 缺段、空读数均保持待挂接，绝不取用邻段水位。
 */
export function matchSectionToSegment(
  segments: WaterLevelSegment[],
  stationId: string,
  measureStartAt: string,
  measureEndAt: string
): LinkageResult {
  const start = timeOf(measureStartAt)
  const end = timeOf(measureEndAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return { ok: false, reason: 'invalid-interval', message: '测流起止时刻无效' }
  }

  const segment = findCoveringSegment(segments, stationId, measureStartAt, measureEndAt)
  if (!segment) {
    return { ok: false, reason: 'segment-missing', message: '缺少完整覆盖测流时段的水位过程段，等待水位站补录' }
  }

  const inWindow = segment.readings.filter((reading) => {
    const at = timeOf(reading.observedAt)
    return at >= start && at <= end
  })
  const missingReadings = inWindow.filter((reading) => reading.stageM === null)
  if (inWindow.length === 0) {
    return {
      ok: false,
      reason: 'reading-empty',
      segmentId: segment.id,
      message: '覆盖测流时段的水位过程段没有逐时读数，等待水位站补录'
    }
  }
  if (missingReadings.length > 0) {
    return {
      ok: false,
      reason: 'reading-missing',
      segmentId: segment.id,
      message: `测流时段内有 ${missingReadings.length} 个水位读数为空，等待水位站补录`
    }
  }

  const stageM = Number(
    (inWindow.reduce((sum, reading) => sum + (reading.stageM ?? 0), 0) / inWindow.length).toFixed(3)
  )
  return {
    ok: true,
    match: { segment, matchedReadings: inWindow, missingReadings: [], stageM },
    message: `已挂接过程段，点据水位取测流时段内 ${inWindow.length} 个读数的平均值 ${stageM.toFixed(3)} m`
  }
}

/** 按过程段起止时刻生成整小时读数时刻（含首尾整点） */
export function buildHourlyTimes(startsAt: string, endsAt: string): string[] {
  const start = Date.parse(startsAt)
  const end = Date.parse(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return []
  const hour = 3600_000
  const first = Math.ceil(start / hour) * hour
  const last = Math.floor(end / hour) * hour
  const times: string[] = []
  for (let at = first; at <= last; at += hour) {
    times.push(new Date(at).toISOString().slice(0, 16))
  }
  return times
}
