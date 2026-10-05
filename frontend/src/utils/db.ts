/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 水位站维护 stageSegments（过程段与逐时读数）
 * - 巡测队维护 sections / verticals / points，并在对账后生成 ratings
 * - ratingVersions 保存已经定案的定线快照，后续补录或重算不回写
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating, RatingVersion } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { StageReading, StageSegment } from '@/types/stageSegment'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
import { resolveStageFromSegments } from '@/types/stageSegment'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round } from '@/utils/flow'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  stageSegments: StageSegment[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  ratingVersions: RatingVersion[]
  compares: Compare[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  stageSegments!: Table<StageSegment, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  ratingVersions!: Table<RatingVersion, string>
  compares!: Table<Compare, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与判定结论，避免列表排序与筛选拿到 undefined
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString() })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }
      })

    // v3：水位站过程段、巡测队测流时段、点据挂接状态、定案定线版本
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, ratingLineNo, catchmentKm2, updatedAt',
        stageSegments: 'id, stationId, segmentNo, startedAt, endedAt, updatedAt',
        sections:
          'id, stationId, measureNo, method, linkedStageM, measuredFlowM3s, startedAt, endedAt, stageSegmentId, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings:
          'id, stationId, lineNo, stageM, flowM3s, sourceSectionId, stageSegmentId, measuredAt, updatedAt',
        ratingVersions: 'id, stationId, lineNo, versionNo, finalizedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        await tx
          .table('stations')
          .toCollection()
          .modify((station: Record<string, unknown>) => {
            if (typeof station.ratingLineNo !== 'string') station.ratingLineNo = 'A'
            station.updatedAt = now
          })

        const oldSections = await tx.table('sections').toArray()
        const segments: StageSegment[] = []
        const sectionMap = new Map<string, Record<string, unknown>>()
        oldSections.forEach((raw: unknown, index: number) => {
          const row = raw as Record<string, unknown>
          const measuredAt = typeof row.measuredAt === 'string' ? row.measuredAt : new Date(now).toISOString()
          const start = Date.parse(measuredAt)
          const endedAt = new Date(Number.isFinite(start) ? start + 60 * 60 * 1000 : now).toISOString()
          const stationId = String(row.stationId ?? '')
          const stageM = typeof row.stageM === 'number' ? row.stageM : null
          const segmentId = `seg_legacy_${String(row.id ?? index)}`
          if (stageM !== null) {
            segments.push({
              id: segmentId,
              stationId,
              segmentNo: `历史-${String(index + 1).padStart(2, '0')}`,
              startedAt: measuredAt,
              endedAt,
              readings: [
                { at: measuredAt, stageM },
                { at: endedAt, stageM }
              ],
              note: 'v3 迁移：由旧版测次水位补齐的历史过程段',
              createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
              updatedAt: now
            })
          }
          row.startedAt = measuredAt
          row.endedAt = endedAt
          row.linkedStageM = stageM
          row.measuredFlowM3s = null
          row.stageSegmentId = stageM === null ? null : segmentId
          row.linkOk = stageM !== null
          row.linkReason = stageM === null ? '缺少覆盖测流时段的水位过程段' : ''
          row.reconciledAt = stageM === null ? null : measuredAt
          row.updatedAt = now
          sectionMap.set(String(row.measureNo ?? ''), row)
        })
        if (segments.length > 0) await tx.table('stageSegments').bulkPut(segments)
        await tx.table('sections').bulkPut(oldSections)

        await tx
          .table('ratings')
          .toCollection()
          .modify((raw: unknown) => {
            const rating = raw as Record<string, unknown>
            const section = sectionMap.get(String(rating.measureNo ?? ''))
            rating.sourceSectionId = section?.id ? String(section.id) : null
            rating.stageSegmentId = section?.stageSegmentId ? String(section.stageSegmentId) : null
            rating.updatedAt = now
          })
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  segments: Array<Omit<StageSegment, 'createdAt' | 'updatedAt'>>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

function reading(start: string, values: Array<number | null>): StageReading[] {
  const base = Date.parse(start)
  return values.map((stageM, index) => ({ at: new Date(base + index * 3600_000).toISOString(), stageM }))
}

/**
 * 播种演示数据：3 个测站、7 个测次，其中 2 个待补录水位；
 * 成功挂接的测次生成水位流量关系点据，待挂接测次保留但不参与定线。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        ratingLineNo: 'A',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      segments: [
        {
          id: 'seg_lh_apr',
          stationId: 'stn_lh01',
          segmentNo: '2024-04-S1',
          startedAt: '2024-04-08T07:00:00.000Z',
          endedAt: '2024-04-08T10:00:00.000Z',
          readings: reading('2024-04-08T07:00:00.000Z', [3.98, 4.01, 4.01, 4.04]),
          note: '水位站自记，过程完整'
        },
        {
          id: 'seg_lh_may',
          stationId: 'stn_lh01',
          segmentNo: '2024-05-S1',
          startedAt: '2024-05-16T07:00:00.000Z',
          endedAt: '2024-05-16T10:00:00.000Z',
          readings: reading('2024-05-16T07:00:00.000Z', [4.48, 4.52, 4.52, 4.56]),
          note: '水位站自记，过程完整'
        },
        {
          id: 'seg_lh_jun',
          stationId: 'stn_lh01',
          segmentNo: '2024-06-S1',
          startedAt: '2024-06-12T07:30:00.000Z',
          endedAt: '2024-06-12T10:30:00.000Z',
          readings: reading('2024-06-12T07:30:00.000Z', [5.4, 5.4, 5.44, 5.48]),
          note: '水位站自记，过程完整'
        },
        {
          id: 'seg_lh_jul',
          stationId: 'stn_lh01',
          segmentNo: '2024-07-S1',
          startedAt: '2024-07-18T08:10:00.000Z',
          endedAt: '2024-07-18T11:10:00.000Z',
          readings: reading('2024-07-18T08:10:00.000Z', [6.1, 6.15, 6.15, 6.2]),
          note: '水位站自记，过程完整'
        },
        {
          id: 'seg_lh_aug',
          stationId: 'stn_lh01',
          segmentNo: '2024-08-S1',
          startedAt: '2024-08-21T07:20:00.000Z',
          endedAt: '2024-08-21T10:20:00.000Z',
          readings: reading('2024-08-21T07:20:00.000Z', [6.98, 7.03, 7.08, 7.12]),
          note: '水位站自记，过程完整'
        }
      ],
      sections: [
        {
          id: 'sec_lh_2404',
          stationId: 'stn_lh01',
          measureNo: '2024-04-001',
          startDistanceM: 12.5,
          linkedStageM: 4.01,
          measuredFlowM3s: 97.5,
          method: '流速仪',
          startedAt: '2024-04-08T08:00:00.000Z',
          endedAt: '2024-04-08T09:00:00.000Z',
          stageSegmentId: 'seg_lh_apr',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-04-08T09:05:00.000Z'
        },
        {
          id: 'sec_lh_2405',
          stationId: 'stn_lh01',
          measureNo: '2024-05-002',
          startDistanceM: 12.5,
          linkedStageM: 4.52,
          measuredFlowM3s: 138.7,
          method: '流速仪',
          startedAt: '2024-05-16T08:00:00.000Z',
          endedAt: '2024-05-16T09:00:00.000Z',
          stageSegmentId: 'seg_lh_may',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-05-16T09:05:00.000Z'
        },
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          linkedStageM: 5.42,
          measuredFlowM3s: 217.2,
          method: '流速仪',
          startedAt: '2024-06-12T08:30:00.000Z',
          endedAt: '2024-06-12T09:30:00.000Z',
          stageSegmentId: 'seg_lh_jun',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-06-12T09:35:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          linkedStageM: 6.15,
          measuredFlowM3s: 298.5,
          method: 'ADCP',
          startedAt: '2024-07-18T09:10:00.000Z',
          endedAt: '2024-07-18T10:10:00.000Z',
          stageSegmentId: 'seg_lh_jul',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-07-18T10:15:00.000Z'
        },
        {
          id: 'sec_lh_2408p',
          stationId: 'stn_lh01',
          measureNo: '2024-08-007',
          startDistanceM: 12.5,
          linkedStageM: null,
          measuredFlowM3s: 356.4,
          method: 'ADCP',
          startedAt: '2024-08-30T08:00:00.000Z',
          endedAt: '2024-08-30T09:00:00.000Z',
          stageSegmentId: null,
          linkOk: false,
          linkReason: '缺少覆盖测流时段的水位过程段',
          reconciledAt: '2024-08-30T09:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        ratingLineNo: 'B',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      segments: [
        {
          id: 'seg_qj_may',
          stationId: 'stn_qj02',
          segmentNo: '2024-05-S1',
          startedAt: '2024-05-22T06:50:00.000Z',
          endedAt: '2024-05-22T09:50:00.000Z',
          readings: reading('2024-05-22T06:50:00.000Z', [3.14, 3.18, 3.18, 3.21]),
          note: '水位站自记'
        },
        {
          id: 'seg_qj_aug',
          stationId: 'stn_qj02',
          segmentNo: '2024-08-S1',
          startedAt: '2024-08-09T05:40:00.000Z',
          endedAt: '2024-08-09T08:40:00.000Z',
          readings: reading('2024-08-09T05:40:00.000Z', [4.31, 4.36, 4.36, 4.39]),
          note: '水位站自记'
        }
      ],
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          linkedStageM: 3.18,
          measuredFlowM3s: 56.1,
          method: '浮标',
          startedAt: '2024-05-22T07:50:00.000Z',
          endedAt: '2024-05-22T08:50:00.000Z',
          stageSegmentId: 'seg_qj_may',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-05-22T08:55:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          linkedStageM: 4.36,
          measuredFlowM3s: 115.6,
          method: '流速仪',
          startedAt: '2024-08-09T06:40:00.000Z',
          endedAt: '2024-08-09T07:40:00.000Z',
          stageSegmentId: 'seg_qj_aug',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-08-09T07:45:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        ratingLineNo: 'C',
        remark: '巡测断面，与龙门站比测'
      },
      segments: [
        {
          id: 'seg_bs_jun',
          stationId: 'stn_bs03',
          segmentNo: '2024-06-S1',
          startedAt: '2024-06-20T09:05:00.000Z',
          endedAt: '2024-06-20T12:05:00.000Z',
          readings: reading('2024-06-20T09:05:00.000Z', [5.31, 5.36, 5.36, 5.4]),
          note: '水位站自记'
        },
        {
          id: 'seg_bs_jul',
          stationId: 'stn_bs03',
          segmentNo: '2024-07-S1',
          startedAt: '2024-07-25T08:30:00.000Z',
          endedAt: '2024-07-25T11:30:00.000Z',
          readings: reading('2024-07-25T08:30:00.000Z', [5.84, 5.88, 5.88, 5.93]),
          note: '水位站自记'
        },
        {
          id: 'seg_bs_aug',
          stationId: 'stn_bs03',
          segmentNo: '2024-08-S1',
          startedAt: '2024-08-15T08:40:00.000Z',
          endedAt: '2024-08-15T11:40:00.000Z',
          readings: reading('2024-08-15T08:40:00.000Z', [6.4, null, 6.48, 6.52]),
          note: '09:40 自记读数为空，等待水位站补录'
        }
      ],
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          linkedStageM: 5.36,
          measuredFlowM3s: 203.5,
          method: 'ADCP',
          startedAt: '2024-06-20T10:05:00.000Z',
          endedAt: '2024-06-20T11:05:00.000Z',
          stageSegmentId: 'seg_bs_jun',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-06-20T11:10:00.000Z'
        },
        {
          id: 'sec_bs_2407',
          stationId: 'stn_bs03',
          measureNo: '2024-07-007',
          startDistanceM: 18.0,
          linkedStageM: 5.88,
          measuredFlowM3s: 325.0,
          method: 'ADCP',
          startedAt: '2024-07-25T09:30:00.000Z',
          endedAt: '2024-07-25T10:30:00.000Z',
          stageSegmentId: 'seg_bs_jul',
          linkOk: true,
          linkReason: '',
          reconciledAt: '2024-07-25T10:35:00.000Z'
        },
        {
          id: 'sec_bs_2408',
          stationId: 'stn_bs03',
          measureNo: '2024-08-008',
          startDistanceM: 18.0,
          linkedStageM: null,
          measuredFlowM3s: 288.0,
          method: 'ADCP',
          startedAt: '2024-08-15T09:40:00.000Z',
          endedAt: '2024-08-15T10:40:00.000Z',
          stageSegmentId: 'seg_bs_aug',
          linkOk: false,
          linkReason: '测流时段缺少完整逐时水位读数',
          reconciledAt: '2024-08-15T10:45:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 2024-04/05 等历史点没有在当前演示中断面里重复布设垂线，只作为已定线资料。
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', sourceSectionId: 'sec_lh_2404', stageSegmentId: 'seg_lh_apr', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', sourceSectionId: 'sec_lh_2405', stageSegmentId: 'seg_lh_may', measuredAt: '2024-05-16T08:00:00.000Z' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', sourceSectionId: 'sec_lh_2406', stageSegmentId: 'seg_lh_jun', measuredAt: '2024-06-12T08:30:00.000Z' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', sourceSectionId: 'sec_lh_2407', stageSegmentId: 'seg_lh_jul', measuredAt: '2024-07-18T09:10:00.000Z' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', sourceSectionId: null, stageSegmentId: 'seg_lh_aug', measuredAt: '2024-08-21T08:20:00.000Z' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', sourceSectionId: null, stageSegmentId: null, measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', sourceSectionId: 'sec_qj_2405', stageSegmentId: 'seg_qj_may', measuredAt: '2024-05-22T07:50:00.000Z' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', sourceSectionId: null, stageSegmentId: null, measuredAt: '2024-07-02T08:10:00.000Z' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', sourceSectionId: 'sec_qj_2408', stageSegmentId: 'seg_qj_aug', measuredAt: '2024-08-09T06:40:00.000Z' },
    // C 线：含一个明显偏离点，用于演示超限挂红；另有一个等待空读数补录的挂起测次
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', sourceSectionId: null, stageSegmentId: null, measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', sourceSectionId: 'sec_bs_2406', stageSegmentId: 'seg_bs_jun', measuredAt: '2024-06-20T10:05:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', sourceSectionId: 'sec_bs_2407', stageSegmentId: 'seg_bs_jul', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: null, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', sourceSectionId: 'sec_bs_2408', stageSegmentId: 'seg_bs_aug', measuredAt: '2024-08-15T09:40:00.000Z' },
    { id: 'rat_bs_c4h', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-010', sourceSectionId: null, stageSegmentId: null, measuredAt: '2024-08-18T09:40:00.000Z' },
    { id: 'rat_bs_c5', stationId: 'stn_bs03', stageM: 6.72, flowM3s: 360.0, lineNo: 'C', measureNo: '2024-09-009', sourceSectionId: null, stageSegmentId: null, measuredAt: '2024-09-12T09:20:00.000Z' }
  ]

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
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) })))
      await db.stageSegments.bulkPut(
        stationBundles.flatMap((bundle) => bundle.segments.map((segment) => ({ ...segment, ...stamp(segment) })))
      )
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) => bundle.sections.map((section) => ({ ...section, ...stamp(section) })))
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) => bundle.points.map((point) => ({ ...point, ...stamp(point) })))
      )
      await db.ratings.bulkPut(ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))

      // 工作定线比测记录：待挂接点据不参与；定案版本另存快照，不依赖后续工作点变化
      const compares: Compare[] = []
      const lineGroups = new Map<string, Array<{ stageM: number; flowM3s: number }>>()
      ratingSeeds.forEach((rating) => {
        if (rating.stageM === null) return
        const list = lineGroups.get(rating.lineNo) ?? []
        list.push({ stageM: rating.stageM, flowM3s: rating.flowM3s })
        lineGroups.set(rating.lineNo, list)
      })
      ratingSeeds.forEach((rating) => {
        if (rating.stageM === null) return
        const fit = fitPowerCurve(lineGroups.get(rating.lineNo) ?? [], rating.lineNo)
        if (!fit.valid) return
        const predicted = round(fit.a * Math.pow(Math.max(rating.stageM - fit.h0, 1e-6), fit.b), 2)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        compares.push({
          id: `cmp_${rating.id}`,
          ratingId: rating.id,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: rating.lineNo === 'C' ? '周渝' : '林昭',
          comparedAt: rating.measuredAt,
          createdAt: now,
          updatedAt: now
        })
      })
      await db.compares.bulkPut(compares)
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
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
      await Promise.all([
        db.stations.clear(),
        db.stageSegments.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.ratingVersions.clear(),
        db.compares.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, stageSegments, sections, verticals, points, ratings, ratingVersions, compares] = await Promise.all([
    db.stations.count(),
    db.stageSegments.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.ratingVersions.count(),
    db.compares.count()
  ])
  return { stations, stageSegments, sections, verticals, points, ratings, ratingVersions, compares }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}

export { resolveStageFromSegments }
