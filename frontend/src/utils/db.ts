/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 水位过程/断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating, RatingVersion } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { WaterLevelSegment } from '@/types/waterLevel'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
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
  waterLevelSegments: WaterLevelSegment[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  ratingVersions: RatingVersion[]
  compares: Compare[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  waterLevelSegments!: Table<WaterLevelSegment, string>
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
        const stamps: Array<[string, () => Record<string, unknown>]> = [
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

    // v3：水位站分段过程、巡测队测流时段、点据挂接与定案版本分离
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        waterLevelSegments: 'id, stationId, startsAt, endsAt, updatedAt',
        sections:
          'id, stationId, measureNo, method, stageM, measuredAt, measureStartAt, measureEndAt, measuredFlowM3s, lineNo, linkageStatus, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings:
          'id, stationId, sectionId, segmentId, lineNo, stageM, flowM3s, measuredAt, linkageStatus, updatedAt',
        ratingVersions: 'id, lineNo, finalizedAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1/v2 的补字段迁移保持幂等；v3 再补测流时段、实测流量与挂接元数据。
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
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

        const legacyRatings = (await tx.table('ratings').toArray()) as Rating[]
        await tx
          .table('sections')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const now = Date.now()
            if (typeof row.createdAt !== 'number') row.createdAt = now
            if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            const measuredAt = typeof row.measuredAt === 'string' ? row.measuredAt : new Date().toISOString()
            const rating = legacyRatings.find(
              (item) => item.measureNo === row.measureNo && item.stationId === row.stationId
            )
            row.measureStartAt = measuredAt
            row.measureEndAt = measuredAt
            row.measuredFlowM3s = rating?.flowM3s ?? 0
            row.lineNo = rating?.lineNo ?? 'A'
            row.linkageStatus = 'manual'
            row.linkageMessage = '历史测次沿用旧台账水位'
            row.linkedAt = null
          })

        await tx
          .table('ratings')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const now = Date.now()
            if (typeof row.createdAt !== 'number') row.createdAt = now
            if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            if (!('measureNo' in row)) row.measureNo = ''
            if (!('lineNo' in row)) row.lineNo = 'A'
            row.sectionId = null
            row.segmentId = null
            row.linkageStatus = 'manual'
            row.stageTakenAt = null
            row.linkageMessage = '历史点据沿用旧台账水位'
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
  segments: Array<Omit<WaterLevelSegment, 'createdAt' | 'updatedAt'>>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

const reading = (observedAt: string, stageM: number | null) => ({ observedAt, stageM })

/**
 * 播种演示数据：3 个测站、7 段自记水位过程、5 个断面测次、8 条垂线、16 个流速测点，
 * 其中青矶站 2024-09 测次因过程段读数为空保持待挂接。
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
        remark: '基本水文站，缆道测流，断面稳定'
      },
      segments: [
        {
          id: 'wls_lh_apr',
          stationId: 'stn_lh01',
          startsAt: '2024-04-08T06:00:00.000Z',
          endsAt: '2024-04-08T10:00:00.000Z',
          readings: [
            reading('2024-04-08T06:00:00.000Z', 3.96),
            reading('2024-04-08T07:00:00.000Z', 3.99),
            reading('2024-04-08T08:00:00.000Z', 4.01),
            reading('2024-04-08T09:00:00.000Z', 4.03),
            reading('2024-04-08T10:00:00.000Z', 4.05)
          ],
          remark: '自记水位计正常'
        },
        {
          id: 'wls_lh_jun',
          stationId: 'stn_lh01',
          startsAt: '2024-06-12T06:00:00.000Z',
          endsAt: '2024-06-12T11:00:00.000Z',
          readings: [
            reading('2024-06-12T06:00:00.000Z', 5.35),
            reading('2024-06-12T07:00:00.000Z', 5.39),
            reading('2024-06-12T08:00:00.000Z', 5.42),
            reading('2024-06-12T09:00:00.000Z', 5.45),
            reading('2024-06-12T10:00:00.000Z', 5.41),
            reading('2024-06-12T11:00:00.000Z', 5.39)
          ],
          remark: '水位站分段记录'
        },
        {
          id: 'wls_lh_jul',
          stationId: 'stn_lh01',
          startsAt: '2024-07-18T07:00:00.000Z',
          endsAt: '2024-07-18T11:00:00.000Z',
          readings: [
            reading('2024-07-18T07:00:00.000Z', 6.08),
            reading('2024-07-18T08:00:00.000Z', 6.12),
            reading('2024-07-18T09:00:00.000Z', 6.15),
            reading('2024-07-18T10:00:00.000Z', 6.19),
            reading('2024-07-18T11:00:00.000Z', 6.17)
          ],
          remark: '水位站分段记录'
        }
      ],
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          measuredFlowM3s: 217.2,
          lineNo: 'A',
          linkageStatus: 'linked',
          linkageMessage: '已按测流时段挂接水位过程段',
          linkedAt: '2024-06-12T09:00:00.000Z',
          method: '流速仪',
          measureStartAt: '2024-06-12T08:00:00.000Z',
          measureEndAt: '2024-06-12T08:30:00.000Z',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          measuredFlowM3s: 298.5,
          lineNo: 'A',
          linkageStatus: 'linked',
          linkageMessage: '已按测流时段挂接水位过程段',
          linkedAt: '2024-07-18T10:00:00.000Z',
          method: 'ADCP',
          measureStartAt: '2024-07-18T09:00:00.000Z',
          measureEndAt: '2024-07-18T09:30:00.000Z',
          measuredAt: '2024-07-18T09:10:00.000Z'
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
        remark: '小河站，浮标法为主，洪水期加测'
      },
      segments: [
        {
          id: 'wls_qj_may',
          stationId: 'stn_qj02',
          startsAt: '2024-05-22T06:00:00.000Z',
          endsAt: '2024-05-22T09:00:00.000Z',
          readings: [
            reading('2024-05-22T06:00:00.000Z', 3.14),
            reading('2024-05-22T07:00:00.000Z', 3.16),
            reading('2024-05-22T08:00:00.000Z', 3.2),
            reading('2024-05-22T09:00:00.000Z', 3.17)
          ],
          remark: '水位站分段记录'
        },
        {
          id: 'wls_qj_aug',
          stationId: 'stn_qj02',
          startsAt: '2024-08-09T05:00:00.000Z',
          endsAt: '2024-08-09T08:00:00.000Z',
          readings: [
            reading('2024-08-09T05:00:00.000Z', 4.32),
            reading('2024-08-09T06:00:00.000Z', 4.36),
            reading('2024-08-09T07:00:00.000Z', 4.36),
            reading('2024-08-09T08:00:00.000Z', 4.38)
          ],
          remark: '水位站分段记录'
        },
        {
          id: 'wls_qj_sep_missing',
          stationId: 'stn_qj02',
          startsAt: '2024-09-10T07:00:00.000Z',
          endsAt: '2024-09-10T10:00:00.000Z',
          readings: [
            reading('2024-09-10T07:00:00.000Z', 3.95),
            reading('2024-09-10T08:00:00.000Z', null),
            reading('2024-09-10T09:00:00.000Z', 4.03),
            reading('2024-09-10T10:00:00.000Z', 4.06)
          ],
          remark: '08:00 读数待补录'
        }
      ],
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          measuredFlowM3s: 56.1,
          lineNo: 'B',
          linkageStatus: 'linked',
          linkageMessage: '已按测流时段挂接水位过程段',
          linkedAt: '2024-05-22T08:30:00.000Z',
          method: '浮标',
          measureStartAt: '2024-05-22T07:00:00.000Z',
          measureEndAt: '2024-05-22T08:00:00.000Z',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          measuredFlowM3s: 115.6,
          lineNo: 'B',
          linkageStatus: 'linked',
          linkageMessage: '已按测流时段挂接水位过程段',
          linkedAt: '2024-08-09T07:30:00.000Z',
          method: '流速仪',
          measureStartAt: '2024-08-09T06:00:00.000Z',
          measureEndAt: '2024-08-09T07:00:00.000Z',
          measuredAt: '2024-08-09T06:40:00.000Z'
        },
        {
          id: 'sec_qj_2409',
          stationId: 'stn_qj02',
          measureNo: '2024-09-007',
          startDistanceM: 4.2,
          measuredFlowM3s: 91.2,
          lineNo: 'B',
          linkageStatus: 'pending',
          linkageMessage: '测流时段内有 1 个水位读数为空，等待水位站补录',
          linkedAt: null,
          method: '流速仪',
          measureStartAt: '2024-09-10T08:00:00.000Z',
          measureEndAt: '2024-09-10T09:00:00.000Z',
          measuredAt: '2024-09-10T09:00:00.000Z'
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
        remark: '巡测断面，与龙门站比测'
      },
      segments: [
        {
          id: 'wls_bs_jun',
          stationId: 'stn_bs03',
          startsAt: '2024-06-20T08:00:00.000Z',
          endsAt: '2024-06-20T12:00:00.000Z',
          readings: [
            reading('2024-06-20T08:00:00.000Z', 5.3),
            reading('2024-06-20T09:00:00.000Z', 5.33),
            reading('2024-06-20T10:00:00.000Z', 5.36),
            reading('2024-06-20T11:00:00.000Z', 5.39),
            reading('2024-06-20T12:00:00.000Z', 5.37)
          ],
          remark: '水位站分段记录'
        }
      ],
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          measuredFlowM3s: 203.5,
          lineNo: 'C',
          linkageStatus: 'linked',
          linkageMessage: '已按测流时段挂接水位过程段',
          linkedAt: '2024-06-20T11:00:00.000Z',
          method: 'ADCP',
          measureStartAt: '2024-06-20T10:00:00.000Z',
          measureEndAt: '2024-06-20T10:30:00.000Z',
          measuredAt: '2024-06-20T10:05:00.000Z'
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

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:00:00.000Z', sectionId: 'sec_lh_2406', segmentId: 'wls_lh_jun', linkageStatus: 'linked', stageTakenAt: '2024-06-12T09:00:00.000Z' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:00:00.000Z', sectionId: 'sec_lh_2407', segmentId: 'wls_lh_jul', linkageStatus: 'linked', stageTakenAt: '2024-07-18T10:00:00.000Z' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:00:00.000Z', sectionId: 'sec_qj_2405', segmentId: 'wls_qj_may', linkageStatus: 'linked', stageTakenAt: '2024-05-22T08:30:00.000Z' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:00:00.000Z', sectionId: 'sec_qj_2408', segmentId: 'wls_qj_aug', linkageStatus: 'linked', stageTakenAt: '2024-08-09T07:30:00.000Z' },
    { id: 'rat_qj_b5_pending', stationId: 'stn_qj02', stageM: null, flowM3s: 91.2, lineNo: 'B', measureNo: '2024-09-007', measuredAt: '2024-09-10T08:00:00.000Z', sectionId: 'sec_qj_2409', segmentId: null, linkageStatus: 'pending', stageTakenAt: null, linkageMessage: '测流时段内有 1 个水位读数为空，等待水位站补录' },
    // C 线：含两个明显偏离点，用于演示超限挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:00:00.000Z', sectionId: 'sec_bs_2406', segmentId: 'wls_bs_jun', linkageStatus: 'linked', stageTakenAt: '2024-06-20T11:00:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z', sectionId: null, segmentId: null, linkageStatus: 'manual', stageTakenAt: null, linkageMessage: '历史点据沿用旧台账水位' }
  ]

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
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await db.waterLevelSegments.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.segments.map((segment) => ({ ...segment, ...stamp(segment) }))
        )
      )
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        )
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )
      await db.ratings.bulkPut(ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))

      // 比测记录：按当前点据拟合曲线流量后计算偏差与判定；待补录点据不参与。
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
      db.waterLevelSegments,
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
        db.waterLevelSegments.clear(),
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
  const [stations, waterLevelSegments, sections, verticals, points, ratings, ratingVersions, compares] =
    await Promise.all([
      db.stations.count(),
      db.waterLevelSegments.count(),
      db.sections.count(),
      db.verticals.count(),
      db.points.count(),
      db.ratings.count(),
      db.ratingVersions.count(),
      db.compares.count()
    ])
  return { stations, waterLevelSegments, sections, verticals, points, ratings, ratingVersions, compares }
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
