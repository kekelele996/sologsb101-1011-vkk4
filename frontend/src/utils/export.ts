/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'stations',
  'waterLevelSegments',
  'sections',
  'verticals',
  'points',
  'ratings',
  'ratingVersions',
  'compares'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

/** 各表行数统计（导出页展示与导入结果回执共用） */
export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [stations, waterLevelSegments, sections, verticals, points, ratings, ratingVersions, compares] =
    await Promise.all([
      db.stations.toArray(),
      db.waterLevelSegments.toArray(),
      db.sections.toArray(),
      db.verticals.toArray(),
      db.points.toArray(),
      db.ratings.toArray(),
      db.ratingVersions.toArray(),
      db.compares.toArray()
    ])
  return {
    app: 'gbhydrogaug',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations,
    waterLevelSegments,
    sections,
    verticals,
    points,
    ratings,
    ratingVersions,
    compares
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbhydrogaug' && obj.app !== undefined) {
    errors.push('app 字段应为 gbhydrogaug，文件来源不明')
  }
  const requiredKeys = ['stations', 'sections', 'verticals', 'points', 'ratings', 'compares'] as const
  for (const key of requiredKeys) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const ratings = Array.isArray(obj.ratings) ? (obj.ratings as BackupPayload['ratings']) : []
  const sections = (Array.isArray(obj.sections) ? (obj.sections as BackupPayload['sections']) : []).map((section) => {
    const measuredAt = section.measureStartAt ?? section.measuredAt ?? new Date().toISOString()
    const linkedRating = ratings.find((rating) => rating.measureNo === section.measureNo && rating.stationId === section.stationId)
    return {
      ...section,
      stageM: typeof section.stageM === 'number' ? section.stageM : null,
      measuredFlowM3s: section.measuredFlowM3s ?? linkedRating?.flowM3s ?? 0,
      lineNo: section.lineNo ?? linkedRating?.lineNo ?? 'A',
      linkageStatus: section.linkageStatus ?? 'manual',
      linkageMessage: section.linkageMessage ?? '旧备份导入的历史测次沿用旧台账水位',
      linkedAt: section.linkedAt ?? null,
      measureStartAt: measuredAt,
      measureEndAt: section.measureEndAt ?? measuredAt
    }
  })
  const normalizedRatings = ratings.map((rating) => ({
    ...rating,
    stageM: typeof rating.stageM === 'number' ? rating.stageM : null,
    sectionId: rating.sectionId ?? null,
    segmentId: rating.segmentId ?? null,
    linkageStatus: rating.linkageStatus ?? 'manual',
    stageTakenAt: rating.stageTakenAt ?? null,
    linkageMessage: rating.linkageMessage ?? '旧备份导入的历史点据沿用旧台账水位'
  }))
  const payload: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    stations: obj.stations ?? [],
    waterLevelSegments: obj.waterLevelSegments ?? [],
    sections,
    verticals: obj.verticals ?? [],
    points: obj.points ?? [],
    ratings: normalizedRatings,
    ratingVersions: obj.ratingVersions ?? [],
    compares: obj.compares ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    stations: payload.stations.length,
    waterLevelSegments: payload.waterLevelSegments.length,
    sections: payload.sections.length,
    verticals: payload.verticals.length,
    points: payload.points.length,
    ratings: payload.ratings.length,
    ratingVersions: payload.ratingVersions.length,
    compares: payload.compares.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [
      db.stations,
      db.waterLevelSegments,
      db.sections,
      db.verticals,
      db.points,
      db.ratings,
      db.ratingVersions,
      db.compares
    ],
    async () => {
      await db.stations.bulkPut(payload.stations)
      await db.waterLevelSegments.bulkPut(payload.waterLevelSegments)
      await db.sections.bulkPut(payload.sections)
      await db.verticals.bulkPut(payload.verticals)
      await db.points.bulkPut(payload.points)
      await db.ratings.bulkPut(payload.ratings)
      await db.ratingVersions.bulkPut(payload.ratingVersions)
      await db.compares.bulkPut(payload.compares)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const stationMap = new Map<string, string>()
  const segmentMap = new Map<string, string>()
  const sectionMap = new Map<string, string>()
  const verticalMap = new Map<string, string>()
  const ratingMap = new Map<string, string>()

  const stations = payload.stations.map((station) => {
    const id = createId('stn')
    stationMap.set(station.id, id)
    return { ...station, id }
  })
  const waterLevelSegments = payload.waterLevelSegments.map((segment) => {
    const id = createId('wls')
    segmentMap.set(segment.id, id)
    return { ...segment, id, stationId: stationMap.get(segment.stationId) ?? segment.stationId }
  })
  const sections = payload.sections.map((section) => {
    const id = createId('sec')
    sectionMap.set(section.id, id)
    return { ...section, id, stationId: stationMap.get(section.stationId) ?? section.stationId }
  })
  const verticals = payload.verticals.map((vertical) => {
    const id = createId('vrt')
    verticalMap.set(vertical.id, id)
    return { ...vertical, id, sectionId: sectionMap.get(vertical.sectionId) ?? vertical.sectionId }
  })
  const points = payload.points.map((point) => ({
    ...point,
    id: createId('pnt'),
    verticalId: verticalMap.get(point.verticalId) ?? point.verticalId
  }))
  const ratings = payload.ratings.map((rating) => {
    const id = createId('rat')
    ratingMap.set(rating.id, id)
    return {
      ...rating,
      id,
      stationId: stationMap.get(rating.stationId) ?? rating.stationId,
      sectionId: rating.sectionId ? (sectionMap.get(rating.sectionId) ?? rating.sectionId) : rating.sectionId,
      segmentId: rating.segmentId ? (segmentMap.get(rating.segmentId) ?? rating.segmentId) : rating.segmentId
    }
  })
  const ratingVersions = payload.ratingVersions.map((version) => ({
    ...version,
    id: createId('rv')
  }))
  const compares = payload.compares.map((compare) => ({
    ...compare,
    id: createId('cmp'),
    ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId
  }))
  return {
    ...payload,
    stations,
    waterLevelSegments,
    sections,
    verticals,
    points,
    ratings,
    ratingVersions,
    compares
  }
}

/**
 * 生成结论文本：按测站输出最新水位、断面测次、定线参数与超限点据。
 * 供导出页的「检测结论」区域使用。
 */
export interface ConclusionLine {
  stationId: string
  stationName: string
  river: string
  sectionCount: number
  latestStageM: number | null
  ratingCount: number
  overLimitCount: number
  fitText: string
}

export function buildConclusionLines(
  payload: BackupPayload,
  fits: Array<{ lineNo: string; valid: boolean; a: number; b: number; h0: number; meanResidualPct: number; sampleCount: number }>
): ConclusionLine[] {
  return payload.stations.map((station) => {
    const sections = payload.sections.filter((section) => section.stationId === station.id)
    const linkedRatingBySection = new Map(
      payload.ratings.map((rating) => [rating.sectionId, rating] as const)
    )
    const latest = sections.reduce<number | null>((acc, section) => {
      const linkedStage = linkedRatingBySection.get(section.id)?.stageM ?? section.stageM ?? null
      if (acc === null) return linkedStage
      return linkedStage !== null && linkedStage > acc ? linkedStage : acc
    }, null)
    const ratings = payload.ratings.filter((rating) => rating.stationId === station.id)
    const ratingIds = new Set(ratings.map((rating) => rating.id))
    const overLimitCount = payload.compares.filter(
      (compare) => ratingIds.has(compare.ratingId) && compare.verdict === '超限'
    ).length
    const lines = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
    const fitParts = lines.map((lineNo) => {
      const fit = fits.find((item) => item.lineNo === lineNo)
      if (!fit || !fit.valid) return `${lineNo} 线未定线`
      return `${lineNo} 线 Q=${fit.a}·(H-${fit.h0})^${fit.b}，残差 ${fit.meanResidualPct}%（${fit.sampleCount} 点）`
    })
    return {
      stationId: station.id,
      stationName: station.name,
      river: station.river,
      sectionCount: sections.length,
      latestStageM: latest,
      ratingCount: ratings.length,
      overLimitCount,
      fitText: fitParts.length > 0 ? fitParts.join('；') : '暂无关系点据'
    }
  })
}
