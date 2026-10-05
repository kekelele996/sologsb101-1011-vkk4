/**
 * 巡测队对账动作：按测流时段挂接水位站过程段。
 * 水位过程段只读；失败原因写回测次与由该测次生成的挂起点据，等水位站补录后重试。
 */
import { db } from '@/utils/db'
import type { Section } from '@/types/section'
import { resolveStageFromSegments } from '@/types/stageSegment'

/**
 * 水位站保存 / 补录过程段后调用：只重取挂过该过程段的测次。
 * 若新过程段刚好覆盖原失败测次，也允许重新尝试，不修改任何过程段读数。
 */
export async function reconcileSectionsForSegment(segmentId: string): Promise<Section[]> {
  const segment = await db.stageSegments.get(segmentId)
  if (!segment) return []

  const candidates = await db.sections.where('stationId').equals(segment.stationId).toArray()
  const affected = candidates.filter(
    (section) =>
      section.stageSegmentId === segmentId ||
      (!section.linkOk &&
        Date.parse(section.startedAt) >= Date.parse(segment.startedAt) &&
        Date.parse(section.endedAt) <= Date.parse(segment.endedAt))
  )

  const results: Section[] = []
  for (const section of affected) {
    results.push(await reconcileSectionById(section.id))
  }
  return results
}

/** 巡测队对单个测次重试，或新增 / 修改测流时段后重新取水位 */
export async function reconcileSectionById(sectionId: string): Promise<Section> {
  const [section, segments] = await Promise.all([
    db.sections.get(sectionId),
    db.stageSegments.toArray()
  ])
  if (!section) throw new Error('断面测次不存在')

  const result = resolveStageFromSegments(segments, section.stationId, section.startedAt, section.endedAt)
  const now = Date.now()
  const updated: Section = {
    ...section,
    linkedStageM: result.ok ? result.stageM : null,
    stageSegmentId: result.segmentId,
    linkOk: result.ok,
    linkReason: result.ok ? '' : result.reason,
    reconciledAt: new Date(now).toISOString(),
    updatedAt: now
  }

  await db.transaction('rw', [db.sections, db.ratings], async () => {
    await db.sections.put(updated)
    await db.ratings
      .where('sourceSectionId')
      .equals(section.id)
      .modify((rating) => {
        rating.stageM = updated.linkedStageM
        rating.stageSegmentId = updated.stageSegmentId
        rating.measureNo = updated.measureNo
        rating.measuredAt = updated.startedAt
        rating.flowM3s = updated.measuredFlowM3s ?? rating.flowM3s
        rating.updatedAt = now
      })
  })

  return updated
}

/** 水位站删除过程段后，已挂该段或依赖该时段的测次重新变为待补录状态 */
export async function reconcileAfterSegmentDeleted(
  segmentId: string,
  stationId: string,
  startedAt: string,
  endedAt: string
): Promise<Section[]> {
  const sameStation = await db.sections.where('stationId').equals(stationId).toArray()
  const targetIds = sameStation
    .filter(
      (section) =>
        section.stageSegmentId === segmentId ||
        (Date.parse(section.startedAt) >= Date.parse(startedAt) &&
          Date.parse(section.endedAt) <= Date.parse(endedAt))
    )
    .map((section) => section.id)
  const results: Section[] = []
  for (const id of targetIds) {
    results.push(await reconcileSectionById(id))
  }
  return results
}

/** 巡测队批量重试全部挂接失败的测次 */
export async function retryAllPendingSections(): Promise<{ success: number; failed: number }> {
  const targets = (await db.sections.toArray()).filter((section) => !section.linkOk)
  let success = 0
  let failed = 0
  for (const section of targets) {
    const result = await reconcileSectionById(section.id)
    if (result.linkOk) success += 1
    else failed += 1
  }
  return { success, failed }
}
