/**
 * 定线 store：维护水位流量关系点据、比测记录、定线参数与残差派生值。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult, RatingVersion } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow, fitPowerCurve, type RatingFilterState } from '@/types/rating'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const versions = ref<RatingVersion[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号与定线参数（跨页保留） */
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
    watchTable<RatingVersion>(() => db.ratingVersions).subscribe((rows) => {
      versions.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 逐定线号的拟合结果（幂函数定线） */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = ratings.value
        .filter((rating) => rating.lineNo === lineNo && rating.stageM !== null)
        .map((rating) => ({ stageM: rating.stageM ?? 0, flowM3s: rating.flowM3s }))
      return fitPowerCurve(points, lineNo)
    })
  )

  /** 当前未定案的试算定线（随点据与补录水位实时重算，不覆盖定案版本） */
  const draftFit = computed<RatingFitResult>(
    () => allFits.value.find((fit) => fit.lineNo === activeLineNo.value) ?? fitPowerCurve([], activeLineNo.value)
  )

  /** 已定案的最新版本；补录水位、刷新点据或再次试算均不会覆盖它 */
  const finalizedFit = computed<RatingFitResult | null>(() => {
    const version = versions.value
      .filter((item) => item.lineNo === activeLineNo.value)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!version) return null
    return {
      lineNo: version.lineNo,
      a: version.a,
      b: version.b,
      h0: version.h0,
      sampleCount: version.sampleCount,
      meanResidualPct: version.meanResidualPct,
      maxResidualPct: version.maxResidualPct,
      r2: version.r2,
      valid: version.valid,
      message: version.message
    }
  })

  const activeFit = computed<RatingFitResult>(() => finalizedFit.value ?? draftFit.value)

  /** 点据 + 曲线流量 + 残差；待挂接点据水位为空，排在最后且不参与定线 */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => {
        if (a.stageM === null && b.stageM === null) return Date.parse(a.measuredAt) - Date.parse(b.measuredAt)
        if (a.stageM === null) return 1
        if (b.stageM === null) return -1
        return a.stageM - b.stageM
      })
      .map((rating) => {
        const useFinalCurve = finalizedFit.value?.valid === true
        const curveFit = useFinalCurve ? finalizedFit.value : draftFit.value
        const predicted =
          curveFit.valid && rating.stageM !== null ? curveFlow(curveFit, rating.stageM) : 0
        const residualPct =
          curveFit.valid && rating.stageM !== null && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, predicted, residualPct }
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

  /** 定线质量派生值：平均残差与合格点占比 */
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
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

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

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = {
      sectionId: null,
      segmentId: null,
      linkageStatus: 'manual',
      stageTakenAt: null,
      ...payload,
      id: createId('rat'),
      createdAt: now,
      updatedAt: now
    }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /**
   * 刷新比测记录：曲线流量默认采用已定案版本；尚无定案版本时使用当前试算。
   * 待挂接点据（水位为空）不生成比测，也不影响已定案版本。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const draft = fitPowerCurve(
      ratings.value
        .filter((rating) => rating.lineNo === targetLine && rating.stageM !== null)
        .map((rating) => ({ stageM: rating.stageM ?? 0, flowM3s: rating.flowM3s })),
      targetLine
    )
    setFit(draft)
    const fit = finalizedVersionOfLine(targetLine) ?? draft
    const lineRatings = ratings.value.filter((rating) => rating.lineNo === targetLine)
    const targets = lineRatings.filter((rating) => rating.stageM !== null)
    const pendingRatings = lineRatings.filter((rating) => rating.stageM === null)
    if (pendingRatings.length > 0) {
      await db.compares
        .where('ratingId')
        .anyOf(pendingRatings.map((rating) => rating.id))
        .delete()
    }
    if (targets.length === 0) return 0
    const now = Date.now()
    const rows: Compare[] = targets.map((rating) => {
      const predicted = fit.valid && rating.stageM !== null ? curveFlow(fit, rating.stageM) : rating.flowM3s
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
    await db.compares.bulkPut(rows)
    return rows.length
  }

  function finalizedVersionOfLine(lineNo: string): RatingFitResult | null {
    if (lineNo === activeLineNo.value && finalizedFit.value) return finalizedFit.value
    const version = versions.value
      .filter((item) => item.lineNo === lineNo)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!version) return null
    return {
      lineNo: version.lineNo,
      a: version.a,
      b: version.b,
      h0: version.h0,
      sampleCount: version.sampleCount,
      meanResidualPct: version.meanResidualPct,
      maxResidualPct: version.maxResidualPct,
      r2: version.r2,
      valid: version.valid,
      message: version.message
    }
  }

  /** 将当前试算定线保存为不可覆盖的定案版本，旧版本原样留存。 */
  async function finalizeCurrentFit(operator = '整编岗'): Promise<RatingVersion> {
    const fit = draftFit.value
    const now = Date.now()
    const version: RatingVersion = {
      id: createId('rv'),
      lineNo: fit.lineNo,
      a: fit.a,
      b: fit.b,
      h0: fit.h0,
      sampleCount: fit.sampleCount,
      meanResidualPct: fit.meanResidualPct,
      maxResidualPct: fit.maxResidualPct,
      r2: fit.r2,
      valid: fit.valid,
      message: fit.message,
      finalizedAt: new Date(now).toISOString(),
      operator,
      createdAt: now,
      updatedAt: now
    }
    await db.ratingVersions.put(version)
    await rebuildCompares(fit.lineNo)
    return version
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
    versions,
    stations,
    ready,
    error,
    filter,
    activeLineNo,
    draftFit,
    finalizedFit,
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
    start,
    stationNameOf,
    patchFilter,
    resetFilter,
    setActiveLine,
    setFit,
    finalizeCurrentFit,
    removeRatingVersion,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildCompares,
    createCompare,
    updateCompare,
    removeCompare
  }
})
