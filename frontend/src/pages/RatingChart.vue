<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据、工作定线与定案版本
 * 待水位补录的点据保留显示但不参与拟合；定案版本保存点据快照，不随后续补录改写。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Lock, Plus, Refresh, Stamp, TrendCharts } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import type { Rating } from '@/types/rating'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const finalizeVisible = ref(false)
const finalizing = ref(false)
const finalizeForm = reactive({ stationId: '', operator: '林昭' })

const fit = computed(() => ratingStore.activeFit)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))

/** 当前定线号下的点据（含待水位补录点据） */
const pointRows = computed(() =>
  ratingStore.ratings
    .filter((rating) => rating.lineNo === ratingStore.activeLineNo)
    .sort((a, b) => (a.stageM ?? Number.POSITIVE_INFINITY) - (b.stageM ?? Number.POSITIVE_INFINITY))
    .map((rating) => {
      const pending = rating.stageM === null
      const predicted = !pending && fit.value.valid ? Number((fit.value.a * Math.pow(Math.max((rating.stageM as number) - fit.value.h0, 1e-6), fit.value.b)).toFixed(2)) : 0
      const residualPct =
        !pending && fit.value.valid && rating.flowM3s > 0
          ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
          : 0
      const compare = ratingStore.compares.find((item) => item.ratingId === rating.id)
      return {
        rating,
        stationName: ratingStore.stationNameOf(rating.stationId),
        pending,
        predicted,
        residualPct,
        verdict: pending ? '待挂接' : compare?.verdict ?? (Math.abs(residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
      }
    })
)

const visibleRows = computed(() =>
  pointRows.value.filter((row) => ratingStore.filter.includePending || !row.pending)
)

const versions = computed(() => ratingStore.versionsOfLine(ratingStore.activeLineNo))

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts,
  includePending: ratingStore.filter.includePending
}))

/** 关系曲线坐标：横轴水位、纵轴流量；待挂接点据不入图 */
const chart = computed(() => {
  const rows = pointRows.value.filter((row) => !row.pending)
  if (rows.length === 0) {
    return { samples: '', points: [] as Array<{ id: string; cx: number; cy: number; verdict: string }>, stageMin: 0, stageMax: 0, flowMax: 0 }
  }
  const stages = rows.map((row) => row.rating.stageM as number)
  const flows = rows.map((row) => row.rating.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const sampleCount = 13
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
    const value = fit.value.valid ? fit.value.a * Math.pow(Math.max(stageM - fit.value.h0, 1e-6), fit.value.b) : 0
    return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
  }).join(' ')
  return {
    samples,
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM as number),
      cy: toY(row.rating.flowM3s),
      verdict: row.verdict
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  const last = pointRows.value.filter((row) => !row.pending).at(-1)
  form.stageM = last ? Number(((last.rating.stageM as number) + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.rating.flowM3s * 1.2).toFixed(1)) : 50
  form.measureNo = `手工-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  if (rating.sourceSectionId) {
    ElMessage.info('测次生成的点据请到断面测次页修改测流时段或重试水位挂接')
    return
  }
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM ?? 0
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('手工点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('手工点据已新增，正在重算工作定线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  if (rating.sourceSectionId) {
    ElMessage.warning('测次生成的点据不能在本页删除，请到断面测次页处理来源测次')
    return
  }
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM?.toFixed(2)} m 处的手工点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.rebuildCompares(rating.lineNo)
  ElMessage.success('点据已删除并重算定线')
}

async function refit(): Promise<void> {
  await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  const result = ratingStore.activeFit
  if (result.valid) {
    ElMessage.success(
      `工作定线完成：Q = ${result.a}×(H-${result.h0})^${result.b}，平均残差 ${result.meanResidualPct}%`
    )
  } else {
    ElMessage.warning(result.message || '当前已挂接点据不足以定线')
  }
}

function openFinalize(): void {
  if (!fit.value.valid) {
    ElMessage.warning(fit.value.message || '当前工作定线无效，不能定案')
    return
  }
  finalizeForm.stationId = stationStore.stations.find((station) => station.ratingLineNo === ratingStore.activeLineNo)?.id
    ?? stationStore.stations[0]?.id
    ?? ''
  finalizeVisible.value = true
}

async function submitFinalize(): Promise<void> {
  if (!finalizeForm.stationId) {
    ElMessage.warning('请选择定案测站')
    return
  }
  finalizing.value = true
  try {
    const version = await ratingStore.finalizeCurrentLine({
      stationId: finalizeForm.stationId,
      lineNo: ratingStore.activeLineNo,
      operator: finalizeForm.operator
    })
    finalizeVisible.value = false
    ElMessage.success(`${version.versionNo} 已定案，后续水位补录不会改写这版`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定案失败')
  } finally {
    finalizing.value = false
  }
}

async function removeVersion(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('删除该定案版本不会影响当前工作定线与其他版本，确认删除？', '删除定案版本', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await ratingStore.removeRatingVersion(id)
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(model?: FilterModel): void {
  if (model) {
    ratingStore.patchFilter({
      keyword: typeof model.keyword === 'string' ? model.keyword : '',
      stationIds: Array.isArray(model.stationIds) ? model.stationIds : [],
      lineNos: Array.isArray(model.lineNos) ? model.lineNos : [],
      verdicts: Array.isArray(model.verdicts) ? (model.verdicts as Array<'合格' | '超限'>) : [],
      includePending: Boolean(model.includePending)
    })
  }
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {}),
      ...(ratingStore.filter.includePending ? { pending: '1' } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : [],
    includePending: query.pending === '1'
  })
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线</h2>
        <p class="gb-hint">
          点据水位由测流时段挂接水位过程段取得；缺段或空读数的点据挂起不参与定线。定案后照原样保留，补录只刷新工作线。
        </p>
      </div>
      <div class="page__actions">
        <el-select :model-value="ratingStore.activeLineNo" class="page__line-select" @change="handleLineChange">
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Refresh" @click="refit">重算工作线</el-button>
        <el-button type="warning" :icon="Stamp" @click="openFinalize">定案当前线</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">手工点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        { key: 'verdicts', label: '判定', options: [{ label: '合格', value: '合格' }, { label: '超限', value: '超限' }] }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    >
      <template #extra>
        <el-checkbox
          :model-value="ratingStore.filter.includePending"
          @update:model-value="(value: string | number | boolean) => { ratingStore.patchFilter({ includePending: Boolean(value) }); handleFilterChange() }"
        >
          显示待挂接点据
        </el-checkbox>
      </template>
    </FilterBar>

    <div class="gb-stats-row">
      <StatBadge label="工作线点据" :value="pointRows.filter((row) => !row.pending).length" suffix="点" icon="DataLine" />
      <StatBadge label="待补录点据" :value="pointRows.filter((row) => row.pending).length" suffix="点" tone="warning" icon="WarningFilled" />
      <StatBadge
        label="工作线平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="Histogram"
      />
      <StatBadge label="已定案版本" :value="versions.length" suffix="版" tone="info" icon="Lock" />
    </div>

    <el-alert
      v-if="!fit.valid"
      type="warning"
      show-icon
      :closable="false"
      :title="fit.message || '当前定线号下已挂接点据不足，至少需要 3 个实测点才能定线'"
    />
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      :title="`${fit.lineNo} 工作线：Q = ${fit.a} × (H - ${fit.h0})^${fit.b}；样本 ${fit.sampleCount} 点，平均残差 ${fit.meanResidualPct}%，最大残差 ${fit.maxResidualPct}%`"
    />

    <div class="page__grid">
      <EmptyPanel
        v-if="visibleRows.length === 0"
        title="该定线号下没有可显示的点据"
        description="可在断面测次页新增测次并完成水位挂接；等待水位补录时请勾选「显示待挂接点据」。"
        action-text="手工点据"
        @action="openCreate"
      />

      <el-table v-else :data="visibleRows" border stripe class="gb-table-compact">
        <el-table-column label="水位 (m)" width="110" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.pending" type="danger" effect="plain">待补录</el-tag>
            <span v-else class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差 / 状态" width="190">
          <template #default="{ row }">
            <DeviationTag v-if="!row.pending" :deviation-pct="row.residualPct" :limit="ratingStore.deviationLimitPct" />
            <el-tag v-else type="danger" effect="plain">等待水位站补录</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="190">
          <template #default="{ row }">
            <div>{{ row.stationName }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
            <el-tag v-if="row.rating.sourceSectionId" size="small" effect="plain">巡测测次挂接</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">手工点据</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="page__side">
        <el-card shadow="never" class="page__chart-card">
          <div class="gb-panel-title">
            <h3>{{ ratingStore.activeLineNo }} 工作线关系曲线</h3>
            <el-icon><TrendCharts /></el-icon>
          </div>
          <svg v-if="pointRows.some((row) => !row.pending)" viewBox="0 0 360 220" class="page__chart">
            <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
            <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
            <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
            <text x="14" y="194" class="gb-chart-axis">0</text>
            <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
            <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
            <polyline v-if="fit.valid" :points="chart.samples" fill="none" stroke="#0f4c75" stroke-width="2" />
            <circle
              v-for="point in chart.points"
              :key="point.id"
              :cx="point.cx"
              :cy="point.cy"
              r="4.5"
              :fill="point.verdict === '超限' ? '#c0392b' : '#7fd1e8'"
              :stroke="point.verdict === '超限' ? '#7b241c' : '#0f4c75'"
            />
          </svg>
          <EmptyPanel v-else title="暂无可绘制的已挂接点据" description="待补录点据不参与曲线绘制。" compact />
        </el-card>

        <el-card shadow="never" class="page__version-card">
          <div class="gb-panel-title">
            <h3>已定案版本</h3>
            <el-icon><Lock /></el-icon>
          </div>
          <EmptyPanel v-if="versions.length === 0" title="尚未定案" description="当前工作线确认后可定案，定案快照不受后续补录影响。" compact />
          <div v-else class="page__versions">
            <div v-for="version in versions" :key="version.id" class="page__version">
              <div class="page__version-head">
                <strong>{{ version.versionNo }}</strong>
                <el-button text type="danger" size="small" :icon="Delete" @click="removeVersion(version.id)" />
              </div>
              <div class="gb-mono">Q = {{ version.a }}×(H-{{ version.h0 }})^{{ version.b }}</div>
              <div class="gb-hint">
                {{ version.sampleCount }} 点 · 平均残差 {{ version.meanResidualPct }}% · {{ version.operator }} ·
                {{ new Date(version.finalizedAt).toLocaleString('zh-CN') }}
              </div>
            </div>
          </div>
        </el-card>
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑手工关系点据' : '新增手工关系点据'" width="560px" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" title="巡测测次生成的点据请到断面测次页维护；本弹窗只登记手工资料点。" class="page__dialog-alert" />
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="手工点据编号" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存并重算</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="finalizeVisible" title="定案当前工作定线" width="460px">
      <el-alert
        type="warning"
        :closable="false"
        title="定案会冻结当前已挂接点据与参数。以后水位站补录只刷新工作线和新点据，不会改写这一版。"
        class="page__dialog-alert"
      />
      <el-form label-width="92px">
        <el-form-item label="所属测站" required>
          <el-select v-model="finalizeForm.stationId" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="整编人">
          <el-input v-model="finalizeForm.operator" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="finalizeVisible = false">取消</el-button>
        <el-button type="warning" :loading="finalizing" @click="submitFinalize">确认定案</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}
.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.page__line-select {
  width: 110px;
}
.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}
.page__side {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page__chart-card,
.page__version-card {
  border: 1px solid #d8e4ec;
}
.page__chart {
  width: 100%;
  height: 240px;
}
.page__versions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.page__version {
  padding: 10px;
  border: 1px solid #d8e4ec;
  border-radius: 8px;
  background: #fbfdff;
}
.page__version-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}
.page__full {
  width: 100%;
}
.page__dialog-alert {
  margin-bottom: 12px;
}
@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
