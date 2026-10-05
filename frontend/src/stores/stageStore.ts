/**
 * 水位站 store：只维护水位过程段与逐时读数。
 * 过程段补录后由本 store 触发巡测队点据重新取水位；挂接重试不由水位站发起。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, db, watchTable } from '@/utils/db'
import type { StageReading, StageSegment } from '@/types/stageSegment'
import { sortReadings } from '@/types/stageSegment'
import { reconcileAfterSegmentDeleted, reconcileSectionsForSegment } from '@/utils/stageLink'

/** 过程段表单草稿 */
export interface StageSegmentDraft {
  stationId: string
  segmentNo: string
  startedAt: string
  endedAt: string
  readings: StageReading[]
  note: string
}

export function createEmptyStageSegmentDraft(stationId = ''): StageSegmentDraft {
  const start = new Date()
  const end = new Date(start.getTime() + 3 * 3600_000)
  return {
    stationId,
    segmentNo: '',
    startedAt: start.toISOString().slice(0, 16),
    endedAt: end.toISOString().slice(0, 16),
    readings: [],
    note: ''
  }
}

export const useStageStore = defineStore('stage', () => {
  const stageSegments = ref<StageSegment[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<StageSegment>(() => db.stageSegments).subscribe((rows) => {
      stageSegments.value = rows
      ready.value = true
      error.value = null
    })
  }

  function segmentsOfStation(stationId: string | null | undefined): StageSegment[] {
    if (!stationId) return []
    return stageSegments.value
      .filter((segment) => segment.stationId === stationId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  }

  function segmentById(id: string | null | undefined): StageSegment | null {
    if (!id) return null
    return stageSegments.value.find((segment) => segment.id === id) ?? null
  }

  const stationSegmentStats = computed<
    Record<string, { count: number; pendingReadingCount: number; latestEndedAt: string | null }>
  >(() => {
    const stats: Record<string, { count: number; pendingReadingCount: number; latestEndedAt: string | null }> = {}
    stageSegments.value.forEach((segment) => {
      const bucket = stats[segment.stationId] ?? { count: 0, pendingReadingCount: 0, latestEndedAt: null }
      bucket.count += 1
      bucket.pendingReadingCount += segment.readings.filter((reading) => reading.stageM === null).length
      if (bucket.latestEndedAt === null || Date.parse(segment.endedAt) > Date.parse(bucket.latestEndedAt)) {
        bucket.latestEndedAt = segment.endedAt
      }
      stats[segment.stationId] = bucket
    })
    return stats
  })

  async function createSegment(payload: Omit<StageSegment, 'id' | 'createdAt' | 'updatedAt'>): Promise<StageSegment> {
    const now = Date.now()
    const row: StageSegment = {
      ...payload,
      readings: sortReadings(payload.readings),
      id: createId('seg'),
      createdAt: now,
      updatedAt: now
    }
    await db.stageSegments.put(row)
    // 水位站补录新过程段后，挂过该时段的巡测队点据自己重新取水位
    await reconcileSectionsForSegment(row.id)
    return row
  }

  async function updateSegment(id: string, patch: Partial<Omit<StageSegment, 'id' | 'createdAt'>>): Promise<void> {
    const normalized =
      patch.readings !== undefined ? { ...patch, readings: sortReadings(patch.readings) } : patch
    await db.stageSegments.update(id, { ...normalized, updatedAt: Date.now() } as never)
    await reconcileSectionsForSegment(id)
  }

  async function removeSegment(id: string): Promise<void> {
    const segment = stageSegments.value.find((item) => item.id === id)
    await db.stageSegments.delete(id)
    if (segment) {
      await reconcileAfterSegmentDeleted(id, segment.stationId, segment.startedAt, segment.endedAt)
    }
  }

  /** 水位站补录一个空读数；只写水位过程段，不直接改巡测队测次 */
  async function fillReading(segmentId: string, at: string, stageM: number): Promise<void> {
    const segment = await db.stageSegments.get(segmentId)
    if (!segment) return
    const readings = segment.readings.map((reading) =>
      reading.at === at ? { ...reading, stageM } : reading
    )
    await updateSegment(segmentId, { readings })
  }

  return {
    stageSegments,
    ready,
    error,
    start,
    segmentsOfStation,
    segmentById,
    stationSegmentStats,
    createSegment,
    updateSegment,
    removeSegment,
    fillReading
  }
})
