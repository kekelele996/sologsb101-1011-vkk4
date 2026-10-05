/**
 * 定线 store：维护水位流量关系点据、比测记录、工作定线与已定案定线版本。
 * 待挂接点据保留但不参与定线；定案版本一经保存不随后续补录改写。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult, RatingVersion, RatingVersionPoint } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow, fitPowerCurve, type RatingFilterState } from '@/types/rating'
import type { Station } from '@/types/station'

export interface FinalizeInput {
  stationId: string
  lineNo: string
  operator: string
}

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const ratingVersions = ref<RatingVersion[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号与工作定线参数（跨页保留） */
  const activeLineNo = ref<string>('A')
  const fits = ref<RatingFitResult[]>([])
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
    watchTable<RatingVersion>(() => db.ratingVersions).subscribe((rows) => {
      ratingVersions.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add('A')
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  const usableRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => rating.stageM !== null && rating.flowM3s > 0)
  )

  const pendingRatings = computed<Rating[]>(() => ratings.value.filter((rating) => rating.stageM === null))

  /** 逐定线号的工作拟合结果（幂函数定线），待挂接点据不参与 */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = usableRatings.value
        .filter((rating) => rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM as number, flowM3s: rating.flowM3s }))
      return fitPowerCurve(points, lineNo)
    })
  )

  const activeFit = computed<RatingFitResult>(() => {
    const cached = fits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (cached) return cached
    const computedFit = allFits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (computedFit) return computedFit
    return fitPowerCurve([], activeLineNo.value)
  })

  /** 点据 + 曲线流量 + 残差；待挂接点据保留在表内并显示补录原因 */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => (a.stageM ?? Number.POSITIVE_INFINITY) - (b.stageM ?? Number.POSITIVE_INFINITY))
      .map((rating) => {
        const pending = rating.stageM === null
        const predicted = !pending && activeFit.value.valid ? curveFlow(activeFit.value, rating.stageM as number) : 0
        const residualPct =
          !pending && activeFit.value.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, pending, predicted, residualPct }
      })
  )

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (rating.stageM === null && !filter.value.includePending) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：比测记录 + 点据 + 测站名，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比，不含等待水位补录的点据 */
  const fitQuality = computed(() => {
    const valid = allFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      pendingCount: pendingRatings.value.length,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function versionsOfLine(lineNo: string): RatingVersion[] {
    return ratingVersions.value
      .filter((version) => version.lineNo === lineNo)
      .sort((a, b) => Date.parse(b.finalizedAt) - Date.parse(a.finalizedAt))
  }

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setFit(fit: RatingFitResult): void {
    const others = fits.value.filter((item) => item.lineNo !== fit.lineNo)
    fits.value = [...others, fit]
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  /** 手工新增的独立点据；巡测队测次生成的点据不在本表单编辑 */
  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt' | 'sourceSectionId' | 'stageSegmentId'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = {
      ...payload,
      sourceSectionId: null,
      stageSegmentId: null,
      id: createId('rat'),
      createdAt: now,
      updatedAt: now
    }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    const current = await db.ratings.get(id)
    if (current?.sourceSectionId) {
      throw new Error('测次生成的点据由巡测队对账自动维护，不能手工改水位')
    }
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    const current = ratings.value.find((rating) => rating.id === id)
    if (current?.sourceSectionId) {
      throw new Error('请删除或修改来源断面测次，点据随测次级联处理')
    }
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /**
   * 由当前已挂接点据生成 / 刷新工作定线比测记录。
   * 待补录水位的点据不生成比测；已删除点据的旧比测记录清掉。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const freshRatings = await db.ratings.toArray()
    const points = freshRatings
      .filter((rating) => rating.lineNo === targetLine && rating.stageM !== null && rating.flowM3s > 0)
      .map((rating) => ({ stageM: rating.stageM as number, flowM3s: rating.flowM3s }))
    const fit = fitPowerCurve(points, targetLine)
    setFit(fit)
    const targets = freshRatings.filter(
      (rating) => rating.lineNo === targetLine && rating.stageM !== null && rating.flowM3s > 0
    )

    const validIds = new Set(targets.map((rating) => rating.id))
    const stale = compares.value.filter((compare) => {
      const rating = ratings.value.find((item) => item.id === compare.ratingId)
      return rating?.lineNo === targetLine && !validIds.has(compare.ratingId)
    })

    const now = Date.now()
    const rows: Compare[] = targets.map((rating) => {
      const stageM = rating.stageM as number
      const predicted = fit.valid ? curveFlow(fit, stageM) : rating.flowM3s
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      const existing = compares.value.find((item) => item.ratingId === rating.id)
      return {
        id: existing?.id ?? createId('cmp'),
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct, deviationLimitPct.value),
        operator: existing?.operator ?? '林昭',
        comparedAt: existing?.comparedAt ?? rating.measuredAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
    })
    await db.transaction('rw', [db.compares], async () => {
      if (stale.length > 0) await db.compares.bulkDelete(stale.map((item) => item.id))
      if (rows.length > 0) await db.compares.bulkPut(rows)
    })
    return rows.length
  }

  /** 把当前工作定线按点据快照定案；之后补录水位只更新工作线，不改这版 */
  async function finalizeCurrentLine(input: FinalizeInput): Promise<RatingVersion> {
    const freshRatings = await db.ratings.toArray()
    const samples = freshRatings
      .filter((rating) => rating.stationId === input.stationId && rating.lineNo === input.lineNo && rating.stageM !== null)
      .map((rating) => ({ stageM: rating.stageM as number, flowM3s: rating.flowM3s }))
    const fit = fitPowerCurve(samples, input.lineNo)
    if (!fit.valid) throw new Error(fit.message || '当前点据不足以定案')

    const now = Date.now()
    const points: RatingVersionPoint[] = freshRatings
      .filter((rating) => rating.stationId === input.stationId && rating.lineNo === input.lineNo && rating.stageM !== null)
      .map((rating) => {
        const stageM = rating.stageM as number
        const predicted = curveFlow(fit, stageM)
        return {
          ratingId: rating.id,
          stageM,
          flowM3s: rating.flowM3s,
          measureNo: rating.measureNo,
          measuredAt: rating.measuredAt,
          residualPct: calcDeviationPct(rating.flowM3s, predicted)
        }
      })
      .sort((a, b) => a.stageM - b.stageM)

    const sequence = ratingVersions.value.filter((version) => version.lineNo === input.lineNo).length + 1
    const row: RatingVersion = {
      id: createId('ver'),
      stationId: input.stationId,
      lineNo: input.lineNo,
      versionNo: `${input.lineNo}-v${sequence}`,
      a: fit.a,
      b: fit.b,
      h0: fit.h0,
      sampleCount: fit.sampleCount,
      meanResidualPct: fit.meanResidualPct,
      maxResidualPct: fit.maxResidualPct,
      r2: fit.r2,
      points,
      finalizedAt: new Date(now).toISOString(),
      operator: input.operator || '整编人',
      createdAt: now,
      updatedAt: now
    }
    await db.ratingVersions.put(row)
    return row
  }

  async function removeRatingVersion(id: string): Promise<void> {
    await db.ratingVersions.delete(id)
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function updateCompare(id: string, patch: Partial<Compare>): Promise<void> {
    await db.compares.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  return {
    ratings,
    compares,
    stations,
    ratingVersions,
    ready,
    error,
    filter,
    activeLineNo,
    activeFit,
    fits,
    deviationLimitPct,
    lineNos,
    allFits,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    pendingRatings,
    start,
    stationNameOf,
    versionsOfLine,
    patchFilter,
    resetFilter,
    setActiveLine,
    setFit,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildCompares,
    finalizeCurrentLine,
    removeRatingVersion,
    createCompare,
    updateCompare,
    removeCompare
  }
})
