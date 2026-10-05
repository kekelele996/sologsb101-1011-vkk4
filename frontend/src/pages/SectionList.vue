<script setup lang="ts">
/**
 * 模块 2：/stations/:id/sections 断面测次列表与测法标记
 * 新增测次后回显当前水位；深链访问时若测站不存在给出友好空态。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshRight, Right, Timer } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useLinkageStore } from '@/stores/linkageStore'
import { MEASURE_METHODS, type MeasureMethod, type Section } from '@/types/section'
import type { LinkageStatus } from '@/types/waterLevel'
import { initDatabase } from '@/utils/db'
import { fromLocalDateTimeInput, toLocalDateTimeInput } from '@/utils/time'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const linkageStore = useLinkageStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  measureNo: '',
  startDistanceM: 0,
  measuredFlowM3s: 0,
  lineNo: 'A',
  method: '流速仪' as MeasureMethod,
  measureStartAt: toLocalDateTimeInput(new Date()),
  measureEndAt: toLocalDateTimeInput(new Date(Date.now() + 30 * 60000))
})

const sectionRows = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  return list
    .filter((section) => {
      const keyword = sectionStore.filter.keyword.trim()
      if (keyword.length > 0 && !`${section.measureNo}${section.method}`.includes(keyword)) return false
      if (sectionStore.filter.methods.length > 0 && !sectionStore.filter.methods.includes(section.method)) return false
      const stage = sectionStore.stageOfSection(section)
      if (sectionStore.filter.minStageM !== null && (stage === null || stage < sectionStore.filter.minStageM)) return false
      return true
    })
    .map((section) => ({
      section,
      stageM: sectionStore.stageOfSection(section),
      linkageStatus: sectionStore.linkageStatusOfSection(section),
      rating: sectionStore.ratingOfSection(section.id)
    }))
})

const filterModel = computed<FilterModel>(() => ({
  keyword: sectionStore.filter.keyword,
  methods: sectionStore.filter.methods,
  minStageM: sectionStore.filter.minStageM
}))

const stats = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  const stages = list.map((section) => sectionStore.stageOfSection(section)).filter((stage): stage is number => stage !== null)
  const pendingCount = list.filter((section) => sectionStore.linkageStatusOfSection(section) === 'pending').length
  const verticalCount = list.reduce(
    (sum, section) => sum + (sectionStore.sectionVerticalCounts[section.id] ?? 0),
    0
  )
  const timeOf = (section: Section): number => Date.parse(section.measureStartAt ?? section.measuredAt ?? '')
  return {
    count: list.length,
    pendingCount,
    maxStageM: stages.length ? Math.max(...stages) : null,
    minStageM: stages.length ? Math.min(...stages) : null,
    latest: list.reduce<Section | null>((acc, section) => {
      if (!acc) return section
      return timeOf(section) > timeOf(acc) ? section : acc
    }, null),
    verticalCount,
    currentStageM: list.length ? sectionStore.stageOfSection(list[0]) : null
  }
})

function openCreate(): void {
  editingId.value = null
  form.measureNo = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(
    stats.value.count + 1
  ).padStart(3, '0')}`
  form.startDistanceM = stats.value.latest?.startDistanceM ?? 0
  form.measuredFlowM3s = stats.value.latest?.measuredFlowM3s ?? 0
  form.lineNo = 'A'
  form.method = '流速仪'
  form.measureStartAt = toLocalDateTimeInput(new Date())
  form.measureEndAt = toLocalDateTimeInput(new Date(Date.now() + 30 * 60000))
  dialogVisible.value = true
}

function openEdit(row: { section: Section }): void {
  const section = row.section
  editingId.value = section.id
  form.measureNo = section.measureNo
  form.startDistanceM = section.startDistanceM
  form.measuredFlowM3s = section.measuredFlowM3s
  form.lineNo = section.lineNo
  form.method = section.method
  form.measureStartAt = toLocalDateTimeInput(section.measureStartAt ?? section.measuredAt ?? new Date())
  form.measureEndAt = toLocalDateTimeInput(section.measureEndAt)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.measureNo.trim()) {
    ElMessage.warning('请填写测次号')
    return
  }
  if (!Number.isFinite(form.measuredFlowM3s) || form.measuredFlowM3s <= 0) {
    ElMessage.warning('实测流量应为大于 0 的数字（m³/s）')
    return
  }
  if (!form.lineNo.trim()) {
    ElMessage.warning('请填写定线号')
    return
  }
  const start = Date.parse(fromLocalDateTimeInput(form.measureStartAt))
  const end = Date.parse(fromLocalDateTimeInput(form.measureEndAt))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    ElMessage.warning('测流开始时刻不能晚于结束时刻')
    return
  }
  if (!Number.isFinite(form.startDistanceM) || form.startDistanceM < 0) {
    ElMessage.warning('起点距应为非负数字（m）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: stationId.value,
      measureNo: form.measureNo.trim(),
      startDistanceM: form.startDistanceM,
      measuredFlowM3s: form.measuredFlowM3s,
      lineNo: form.lineNo.trim() || 'A',
      linkageStatus: 'pending' as LinkageStatus,
      linkageMessage: '等待按测流时段挂接水位过程段',
      linkedAt: null,
      method: form.method,
      measureStartAt: fromLocalDateTimeInput(form.measureStartAt),
      measureEndAt: fromLocalDateTimeInput(form.measureEndAt)
    }
    if (editingId.value) {
      await sectionStore.updateSection(editingId.value, payload)
      ElMessage.success('测次已更新')
    } else {
      const created = await sectionStore.createSection(payload)
      sectionStore.selectSection(created.id)
      ElMessage.success('测次已新增，已按测流时段核对水位过程')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeSection(row: { section: Section }): Promise<void> {
  const section = row.section
  try {
    await ElMessageBox.confirm(
      `删除测次「${section.measureNo}」将同时删除其垂线、流速测点与待整编点据，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.removeSection(section.id)
  ElMessage.success('测次及其垂线测点已删除')
}

function gotoVerticals(row: { section: Section }): void {
  sectionStore.selectSection(row.section.id)
  void router.push(`/sections/${row.section.id}/verticals`)
}

async function retryLinkage(row: { section: Section }): Promise<void> {
  const outcome = await linkageStore.retryPending(undefined, row.section.id)
  if (outcome.linked > 0) ElMessage.success('挂接成功，点据已重新取水位')
  else {
    const latest = sectionStore.sectionById(row.section.id)
    ElMessage.warning(latest?.linkageMessage || '仍未找到可挂接的完整水位过程')
  }
}

async function retryAllPending(): Promise<void> {
  const outcome = await linkageStore.retryPending(stationId.value)
  if (outcome.linked > 0 && outcome.pending === 0) ElMessage.success(`挂接成功 ${outcome.linked} 个测次`)
  else if (outcome.linked > 0) ElMessage.success(`新挂接 ${outcome.linked} 个，仍有 ${outcome.pending} 个等待补录`)
  else ElMessage.warning('暂无新挂接测次；水位过程缺失或读数仍为空')
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(sectionStore.filter.keyword.trim() ? { kw: sectionStore.filter.keyword.trim() } : {}),
      ...(sectionStore.filter.methods.length ? { methods: sectionStore.filter.methods.join(',') } : {}),
      ...(sectionStore.filter.minStageM !== null ? { minStage: String(sectionStore.filter.minStageM) } : {})
    }
  })
}

function handleReset(): void {
  sectionStore.resetFilter()
  void router.replace({ query: {} })
}

function reseedIfEmpty(): void {
  if (stationStore.stations.length === 0) void initDatabase()
}

onMounted(() => {
  reseedIfEmpty()
  const query = route.query
  sectionStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    methods: typeof query.methods === 'string' ? (query.methods.split(',') as MeasureMethod[]) : [],
    minStageM: typeof query.minStage === 'string' ? Number(query.minStage) : null
  })
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!stationStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!station"
      entity-label="测站"
      :missing-id="stationId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        stationStore.stations.slice(0, 3).map((item) => ({
          id: item.id,
          label: `${item.name} 的测次`,
          path: `/stations/${item.id}/sections`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item>{{ station.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>断面测次</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 断面测次
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ station.river }}</el-tag>
          </h2>
          <p class="gb-hint">
            巡测队记录断面测次、测流起止时刻与实测流量；点据水位由水位站过程段挂接，缺段或缺读数时保持待补录。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="RefreshRight" :disabled="stats.pendingCount === 0" @click="retryAllPending">
            重试挂接（{{ stats.pendingCount }}）
          </el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增测次</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="测次总数" :value="stats.count" suffix="次" icon="Files" />
        <StatBadge
          label="当前水位"
          :value="stats.currentStageM === null ? '—' : stats.currentStageM.toFixed(2)"
          suffix="m"
          tone="info"
          icon="Odometer"
        />
        <StatBadge
          label="待挂接"
          :value="stats.pendingCount"
          suffix="次"
          :tone="stats.pendingCount > 0 ? 'danger' : 'success'"
          :icon="stats.pendingCount > 0 ? 'WarningFilled' : 'CircleCheck'"
        />
        <StatBadge label="垂线合计" :value="stats.verticalCount" suffix="条" tone="success" icon="Histogram" />
      </div>

      <FilterBar
        :model-value="filterModel"
        :selects="[
          { key: 'methods', label: '测法', options: MEASURE_METHODS.map((method) => ({ label: method, value: method })) }
        ]"
        :number-ranges="[{ key: 'minStageM', label: '水位不低于', placeholder: '不限', unit: 'm' }]"
        keyword-placeholder="搜索测次号 / 测法"
        @change="handleFilterChange"
        @reset="handleReset"
      >
        <template #extra>
          <el-tag v-if="stats.latest" type="success" effect="plain">
            最新测次 {{ stats.latest.measureNo }} · 流量 {{ stats.latest.measuredFlowM3s.toFixed(1) }} m³/s
          </el-tag>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="sectionRows.length === 0"
        :title="sectionStore.sectionsOfStation(stationId).length === 0 ? '该测站还没有测次' : '没有符合条件的测次'"
        description="新增一次流量测验后，即可布设垂线、录入测深与流速测点。"
        action-text="新增测次"
        secondary-text="重置筛选"
        @action="openCreate"
        @secondary="handleReset"
      />

      <el-table v-else :data="sectionRows" border stripe class="gb-table-compact">
        <el-table-column prop="section.measureNo" label="测次号" min-width="145" />
        <el-table-column label="定线" width="70" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.section.lineNo }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测法" width="95">
          <template #default="{ row }">
            <el-tag size="small" :type="row.section.method === 'ADCP' ? 'success' : row.section.method === '浮标' ? 'warning' : 'primary'" effect="plain">
              {{ row.section.method }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="挂接水位 (m)" width="125" align="right">
          <template #default="{ row }">
            <span v-if="row.stageM !== null" class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
            <el-tag v-else-if="row.linkageStatus === 'pending'" type="danger" size="small">待补录</el-tag>
            <span v-else class="gb-hint">历史水位</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.section.measuredFlowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="起点距 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.section.startDistanceM.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="垂线条数" width="100" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoVerticals(row)">
              {{ sectionStore.sectionVerticalCounts[row.section.id] ?? 0 }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="测流起止" min-width="210">
          <template #default="{ row }">
            <div class="gb-mono">{{ new Date(row.section.measureStartAt).toLocaleString('zh-CN') }}</div>
            <div class="gb-mono gb-hint">至 {{ new Date(row.section.measureEndAt).toLocaleString('zh-CN') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="挂接状态" min-width="170">
          <template #default="{ row }">
            <el-tag :type="row.linkageStatus === 'linked' ? 'success' : row.linkageStatus === 'pending' ? 'danger' : 'info'" size="small">
              {{ row.linkageStatus === 'linked' ? '已挂接' : row.linkageStatus === 'pending' ? '待补录' : '历史手工' }}
            </el-tag>
            <div class="gb-hint page__link-message">{{ row.rating?.linkageMessage ?? row.section.linkageMessage }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoVerticals(row)">垂线</el-button>
            <el-button v-if="row.linkageStatus === 'pending'" size="small" type="warning" :icon="RefreshRight" @click="retryLinkage(row)">重试</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSection(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无测次" description="点击右上角「新增测次」开始录入。" compact />
        </template>
      </el-table>

      <p class="gb-hint">
        <el-icon><Timer /></el-icon>
        提示：巡测队只维护测流时段与实测流量；点据水位由完整覆盖该时段的水位过程段提供，待补录测次可在此重试挂接。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑测次' : '新增断面测次'" width="560px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="测次号" required>
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="测法" required>
          <el-radio-group v-model="form.method">
            <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="实测流量" required>
          <el-input-number v-model="form.measuredFlowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="起点距" required>
          <el-input-number v-model="form.startDistanceM" :min="0" :max="2000" :step="0.5" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测流开始" required>
          <el-date-picker v-model="form.measureStartAt" type="datetime" placeholder="开始时刻" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
        <el-form-item label="测流结束" required>
          <el-date-picker v-model="form.measureEndAt" type="datetime" placeholder="结束时刻" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="巡测队不直接录点据水位；保存后按测流时段挂接水位站过程段，缺段或缺读数则等待补录。"
        class="page__dialog-note"
      />
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增并布设垂线' }}
        </el-button>
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__tag {
  font-weight: 400;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__link-message {
  margin-top: 2px;
  line-height: 1.4;
}

.page__dialog-note {
  margin-top: 4px;
}
</style>
