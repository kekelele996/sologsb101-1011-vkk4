/**
 * useRatingFit：水位流量点据拟合、残差与工作定线状态管理。
 * 只使用已挂接水位的点据；待水位站补录的点据不参与曲线和残差。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import {
  curveFlow,
  fitPowerCurve,
  type Rating,
  type RatingFitResult
} from '@/types/rating'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  pending: boolean
  /** 曲线流量 */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  fit: RatingFitResult
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  /** 参与定线的定线号列表 */
  lineNos: ComputedRef<string[]>
  /** 当前选中定线号 */
  activeLineNo: Ref<string>
  /** 当前定线的拟合结果 */
  fit: ComputedRef<RatingFitResult>
  /** 全部定线的拟合结果 */
  allFits: ComputedRef<RatingFitResult[]>
  /** 当前定线的点据（含待挂接点据） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 当前定线的曲线采样点，用于绘制曲线 */
  curveSamples: ComputedRef<CurveSample[]>
  /** 超限点据清单 */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  /** 按当前点据重算定线参数并回写 store */
  refit: () => RatingFitResult
}

/**
 * 组合式函数：按定线号分组拟合幂函数 Q = a×(H-H0)^b，并给出逐点残差。
 */
export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string => {
    const station = ratingStore.stations.find((item) => item.id === stationId)
    return station ? station.name : '未知测站'
  }

  const usablePoints = (lineNo: string) =>
    ratings.value
      .filter((rating) => rating.lineNo === lineNo && rating.stageM !== null && rating.flowM3s > 0)
      .map((rating) => ({ stageM: rating.stageM as number, flowM3s: rating.flowM3s }))

  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => fitPowerCurve(usablePoints(lineNo), lineNo))
  )

  const fit = computed<RatingFitResult>(() => {
    const found = allFits.value.find((item) => item.lineNo === activeLineNo.value)
    if (found) return found
    return fitPowerCurve([], activeLineNo.value)
  })

  const toRow = (rating: Rating, current: RatingFitResult): RatingPointRow => {
    const pending = rating.stageM === null
    const predicted = !pending && current.valid ? curveFlow(current, rating.stageM as number) : 0
    const residualPct =
      !pending && current.valid && rating.flowM3s > 0
        ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
        : 0
    return {
      rating,
      stationName: stationNameOf(rating.stationId),
      pending,
      curveFlowM3s: predicted,
      residualPct,
      fit: current
    }
  }

  const pointRows = computed<RatingPointRow[]>(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => (a.stageM ?? Number.POSITIVE_INFINITY) - (b.stageM ?? Number.POSITIVE_INFINITY))
      .map((rating) => toRow(rating, fit.value))
  )

  const curveSamples = computed<CurveSample[]>(() => {
    const current = fit.value
    const rows = pointRows.value.filter((row) => !row.pending)
    if (!current.valid || rows.length === 0) return []
    const stages = rows.map((row) => row.rating.stageM as number)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(current, stageM) }
    })
  })

  const overLimitRows = computed<RatingPointRow[]>(() =>
    allFits.value.flatMap((item) =>
      ratings.value
        .filter((rating) => rating.lineNo === item.lineNo && rating.stageM !== null)
        .map((rating) => toRow(rating, item))
        .filter((row) => Math.abs(row.residualPct) > ratingStore.deviationLimitPct)
    )
  )

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function refit(): RatingFitResult {
    const result = fitPowerCurve(usablePoints(activeLineNo.value), activeLineNo.value)
    ratingStore.setFit(result)
    return result
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    fit,
    allFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
