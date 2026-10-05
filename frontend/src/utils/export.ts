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
import type { RatingVersion } from '@/types/rating'

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'stations',
  'stageSegments',
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
  const [stations, stageSegments, sections, verticals, points, ratings, ratingVersions, compares] = await Promise.all([
    db.stations.toArray(),
    db.stageSegments.toArray(),
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
    stageSegments,
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
  for (const key of BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    stations: obj.stations ?? [],
    stageSegments: obj.stageSegments ?? [],
    sections: obj.sections ?? [],
    verticals: obj.verticals ?? [],
    points: obj.points ?? [],
    ratings: obj.ratings ?? [],
    ratingVersions: obj.ratingVersions ?? [],
    compares: obj.compares ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    stations: payload.stations.length,
    stageSegments: payload.stageSegments.length,
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
      db.stageSegments,
      db.sections,
      db.verticals,
      db.points,
      db.ratings,
      db.ratingVersions,
      db.compares
    ],
    async () => {
      await db.stations.bulkPut(payload.stations)
      await db.stageSegments.bulkPut(payload.stageSegments)
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
  const stageSegments = payload.stageSegments.map((segment) => {
    const id = createId('seg')
    segmentMap.set(segment.id, id)
    return { ...segment, id, stationId: stationMap.get(segment.stationId) ?? segment.stationId }
  })
  const sections = payload.sections.map((section) => {
    const id = createId('sec')
    sectionMap.set(section.id, id)
    return {
      ...section,
      id,
      stationId: stationMap.get(section.stationId) ?? section.stationId,
      stageSegmentId: section.stageSegmentId ? segmentMap.get(section.stageSegmentId) ?? null : null
    }
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
      sourceSectionId: rating.sourceSectionId ? sectionMap.get(rating.sourceSectionId) ?? null : null,
      stageSegmentId: rating.stageSegmentId ? segmentMap.get(rating.stageSegmentId) ?? null : null
    }
  })
  const remapVersion = (version: RatingVersion): RatingVersion => ({
    ...version,
    id: createId('ver'),
    stationId: stationMap.get(version.stationId) ?? version.stationId,
    points: version.points.map((point) => ({
      ...point,
      ratingId: ratingMap.get(point.ratingId) ?? point.ratingId
    }))
  })
  const compares = payload.compares.map((compare) => ({
    ...compare,
    id: createId('cmp'),
    ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId
  }))
  return { ...payload, stations, stageSegments, sections, verticals, points, ratings, ratingVersions: payload.ratingVersions.map(remapVersion), compares }
}

/**
 * 生成结论文本：按测站输出最新已挂接水位、断面测次、工作定线、已定案版本与超限点据。
 */
export interface ConclusionLine {
  stationId: string
  stationName: string
  river: string
  sectionCount: number
  pendingCount: number
  latestStageM: number | null
  ratingCount: number
  overLimitCount: number
  finalizedCount: number
  fitText: string
}

export function buildConclusionLines(
  payload: BackupPayload,
  fits: Array<{ lineNo: string; valid: boolean; a: number; b: number; h0: number; meanResidualPct: number; sampleCount: number }>
): ConclusionLine[] {
  return payload.stations.map((station) => {
    const sections = payload.sections.filter((section) => section.stationId === station.id)
    const latest = sections.reduce<number | null>((acc, section) => {
      if (section.linkedStageM === null) return acc
      if (acc === null) return section.linkedStageM
      return section.linkedStageM > acc ? section.linkedStageM : acc
    }, null)
    const ratings = payload.ratings.filter((rating) => rating.stationId === station.id)
    const ratingIds = new Set(ratings.map((rating) => rating.id))
    const overLimitCount = payload.compares.filter(
      (compare) => ratingIds.has(compare.ratingId) && compare.verdict === '超限'
    ).length
    const pendingCount = ratings.filter((rating) => rating.stageM === null).length
    const lines = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
    const fitParts = lines.map((lineNo) => {
      const fit = fits.find((item) => item.lineNo === lineNo)
      if (!fit || !fit.valid) return `${lineNo} 工作线未定`
      return `${lineNo} 工作线 Q=${fit.a}·(H-${fit.h0})^${fit.b}，残差 ${fit.meanResidualPct}%（${fit.sampleCount} 点）`
    })
    const finalizedCount = payload.ratingVersions.filter(
      (version) => version.stationId === station.id
    ).length
    return {
      stationId: station.id,
      stationName: station.name,
      river: station.river,
      sectionCount: sections.length,
      pendingCount,
      latestStageM: latest,
      ratingCount: ratings.length,
      overLimitCount,
      finalizedCount,
      fitText: fitParts.length > 0 ? fitParts.join('；') : '暂无关系点据'
    }
  })
}
