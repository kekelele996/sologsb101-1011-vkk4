/**
 * 对账挂接 store：整编定线前，把巡测队测次挂到完整覆盖测流时段的水位过程段上。
 * 水位过程段缺失或读数为空时，点据保持 pending；重试由巡测队触发，水位过程不改动。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db, createId } from '@/utils/db'
import type { Section } from '@/types/section'
import type { Rating } from '@/types/rating'
import type { WaterLevelSegment } from '@/types/waterLevel'
import { matchSectionToSegment, type LinkageResult } from '@/types/waterLevel'

export interface LinkageOutcome {
  section: Section
  rating: Rating
  result: LinkageResult
}

export const useLinkageStore = defineStore('linkage', () => {
  const retrying = ref(false)

  function findRatingBySection(ratings: Rating[], section: Section): Rating | undefined {
    return (
      ratings.find((rating) => rating.sectionId === section.id) ??
      ratings.find((rating) => rating.stationId === section.stationId && rating.measureNo === section.measureNo)
    )
  }

  async function upsertRatingForSection(section: Section, result: LinkageResult): Promise<Rating> {
    const ratings = await db.ratings.toArray()
    const existing = findRatingBySection(ratings, section)
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const linked = result.ok
    const next: Rating = {
      id: existing?.id ?? createId('rat'),
      stationId: section.stationId,
      stageM: linked ? result.match.stageM : null,
      flowM3s: section.measuredFlowM3s,
      lineNo: section.lineNo || 'A',
      measureNo: section.measureNo,
      measuredAt: section.measureStartAt,
      sectionId: section.id,
      segmentId: linked ? result.match.segment.id : null,
      linkageStatus: linked ? 'linked' : 'pending',
      stageTakenAt: linked ? nowIso : null,
      linkageMessage: result.message,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await db.ratings.put(next)

    await db.sections.update(section.id, {
      linkageStatus: linked ? 'linked' : 'pending',
      linkageMessage: result.message,
      linkedAt: linked ? nowIso : null,
      updatedAt: now
    } as never)
    return next
  }

  /** 对单个巡测测次重试挂接；只读水位过程，不修改过程段与读数。 */
  async function reconcileSection(
    section: Section,
    segmentsOverride?: WaterLevelSegment[]
  ): Promise<LinkageOutcome> {
    const segments = segmentsOverride ?? (await db.waterLevelSegments.toArray())
    const result = matchSectionToSegment(
      segments,
      section.stationId,
      section.measureStartAt,
      section.measureEndAt
    )
    const rating = await upsertRatingForSection(section, result)
    return { section, rating, result }
  }

  /** 巡测队手动重试待挂接测次，可传单个 id 或重试某站全部 pending 测次。 */
  async function retryPending(stationId?: string, sectionId?: string): Promise<{ linked: number; pending: number }> {
    retrying.value = true
    try {
      const [sections, segments] = await Promise.all([db.sections.toArray(), db.waterLevelSegments.toArray()])
      const targets = sections.filter((section) => {
        if (section.linkageStatus === 'linked') return false
        if (sectionId) return section.id === sectionId
        if (stationId) return section.stationId === stationId
        return true
      })
      let linked = 0
      let pending = 0
      for (const section of targets) {
        const outcome = await reconcileSection(section, segments)
        if (outcome.result.ok) linked += 1
        else pending += 1
      }
      return { linked, pending }
    } finally {
      retrying.value = false
    }
  }

  /** 水位站新增 / 修改 / 删除过程段后，对同站非历史测次重新取水位。 */
  async function refreshForStation(stationId: string): Promise<void> {
    if (!stationId) return
    const sections = await db.sections.where('stationId').equals(stationId).toArray()
    const segments = await db.waterLevelSegments.where('stationId').equals(stationId).toArray()
    for (const section of sections) {
      if (section.linkageStatus === 'manual') continue
      await reconcileSection(section, segments)
    }
  }

  return {
    retrying,
    reconcileSection,
    retryPending,
    refreshForStation
  }
})
