<script setup lang="ts">
/**
 * 模块 2：/stations/:id/sections 巡测队断面测次与水位挂接状态
 * 新增测次记录测流起止时段和实测流量；点据水位只从覆盖时段的水位过程段取得。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshRight, Right } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore, type SectionCreatePayload } from '@/stores/sectionStore'
import { MEASURE_METHODS, type MeasureMethod, type Section } from '@/types/section'
import { initDatabase } from '@/utils/db'
import { retryAllPendingSections } from '@/utils/stageLink'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const retrying = ref(false)
const form = reactive({
  measureNo: '',
  startDistanceM: 0,
  measuredFlowM3s: 0,
  method: '流速仪' as MeasureMethod,
  startedAt: new Date().toISOString().slice(0, 16),
  endedAt: new Date(Date.now() + 3600_000).toISOString().slice(0, 16)
})

const allSections = computed(() => sectionStore.sectionsOfStation(stationId.value))
const sectionRows = computed(() =>
  allSections.value.filter((section) => {
    const keyword = sectionStore.filter.keyword.trim()
    if (keyword.length > 0 && !`${section.measureNo}${section.method}`.includes(keyword)) return false
    if (sectionStore.filter.methods.length > 0 && !sectionStore.filter.methods.includes(section.method)) return false
    if (sectionStore.filter.minStageM !== null && (section.linkedStageM ?? -Infinity) < sectionStore.filter.minStageM) return false
    if (sectionStore.filter.pendingOnly && section.linkOk) return false
    return true
  })
)

const filterModel = computed<FilterModel>(() => ({
  keyword: sectionStore.filter.keyword,
  methods: sectionStore.filter.methods,
  minStageM: sectionStore.filter.minStageM,
  pendingOnly: sectionStore.filter.pendingOnly
}))

const stats = computed(() => {
  const list = allSections.value
  const linkedStages = list.map((section) => section.linkedStageM).filter((value): value is number => value !== null)
  return {
    count: list.length,
    pendingCount: list.filter((section) => !section.linkOk).length,
    maxStageM: linkedStages.length ? Math.max(...linkedStages) : null,
    minStageM: linkedStages.length ? Math.min(...linkedStages) : null,
    latest: list.reduce<Section | null>((acc, section) => {
      if (!acc) return section
      return Date.parse(section.startedAt) > Date.parse(acc.startedAt) ? section : acc
    }, null),
    verticalCount: list.reduce(
      (sum, section) => sum + (sectionStore.sectionVerticalCounts[section.id] ?? 0),
      0
    ),
    currentStageM: linkedStages.length ? linkedStages[0] : null
  }
})

function openCreate(): void {
  editingId.value = null
  form.measureNo = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(
    stats.value.count + 1
  ).padStart(3, '0')}`
  form.startDistanceM = stats.value.latest?.startDistanceM ?? 0
  form.measuredFlowM3s = stats.value.latest?.measuredFlowM3s ?? 0
  form.method = '流速仪'
  form.startedAt = new Date().toISOString().slice(0, 16)
  form.endedAt = new Date(Date.now() + 3600_000).toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(section: Section): void {
  editingId.value = section.id
  form.measureNo = section.measureNo
  form.startDistanceM = section.startDistanceM
  form.measuredFlowM3s = section.measuredFlowM3s ?? 0
  form.method = section.method
  form.startedAt = section.startedAt.slice(0, 16)
  form.endedAt = section.endedAt.slice(0, 16)
  dialogVisible.value = true
}

function buildPayload(): SectionCreatePayload | null {
  const startedAt = new Date(form.startedAt)
  const endedAt = new Date(form.endedAt)
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime()) || endedAt <= startedAt) {
    ElMessage.warning('测流结束时刻必须晚于开始时刻')
    return null
  }
  return {
    stationId: stationId.value,
    measureNo: form.measureNo.trim(),
    startDistanceM: form.startDistanceM,
    measuredFlowM3s: form.measuredFlowM3s,
    method: form.method,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString()
  }
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
  if (!Number.isFinite(form.startDistanceM) || form.startDistanceM < 0) {
    ElMessage.warning('起点距应为非负数字（m）')
    return
  }
  const payload = buildPayload()
  if (!payload) return

  submitting.value = true
  try {
    if (editingId.value) {
      const updated = await sectionStore.updateSection(editingId.value, payload)
      ElMessage[updated.linkOk ? 'success' : 'warning'](
        updated.linkOk ? '测次已更新并完成水位挂接' : `测次已保存：${updated.linkReason}`
      )
    } else {
      const created = await sectionStore.createSection(payload)
      sectionStore.selectSection(created.id)
      ElMessage[created.linkOk ? 'success' : 'warning'](
        created.linkOk
          ? `测次已新增，点据水位 ${created.linkedStageM?.toFixed(2)} m`
          : `测次已挂起：${created.linkReason}`
      )
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function retryLink(section: Section): Promise<void> {
  const updated = await sectionStore.retrySectionLink(section.id)
  if (updated.linkOk) ElMessage.success(`重试成功，点据水位 ${updated.linkedStageM?.toFixed(2)} m`)
  else ElMessage.warning(`仍未挂接：${updated.linkReason}`)
}

async function retryAll(): Promise<void> {
  retrying.value = true
  try {
    const result = await retryAllPendingSections()
    if (result.failed === 0) ElMessage.success(`全部 ${result.success} 个挂起测次已挂接成功`)
    else ElMessage.warning(`成功 ${result.success} 个，仍有 ${result.failed} 个等待水位站补录`)
  } finally {
    retrying.value = false
  }
}

async function removeSection(section: Section): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除测次「${section.measureNo}」将同时删除其垂线、测点、挂接生成的点据与比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.removeSection(section.id)
  ElMessage.success('测次及挂接点据已删除')
}

function gotoVerticals(section: Section): void {
  sectionStore.selectSection(section.id)
  void router.push(`/sections/${section.id}/verticals`)
}

function handleFilterChange(model?: FilterModel): void {
  if (model) {
    sectionStore.patchFilter({
      keyword: typeof model.keyword === 'string' ? model.keyword : '',
      methods: Array.isArray(model.methods) ? (model.methods as MeasureMethod[]) : [],
      minStageM: typeof model.minStageM === 'number' ? model.minStageM : null,
      pendingOnly: Boolean(model.pendingOnly)
    })
  }
  void router.replace({
    query: {
      ...(sectionStore.filter.keyword.trim() ? { kw: sectionStore.filter.keyword.trim() } : {}),
      ...(sectionStore.filter.methods.length ? { methods: sectionStore.filter.methods.join(',') } : {}),
      ...(sectionStore.filter.minStageM !== null ? { minStage: String(sectionStore.filter.minStageM) } : {}),
      ...(sectionStore.filter.pendingOnly ? { pending: '1' } : {})
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
    minStageM: typeof query.minStage === 'string' ? Number(query.minStage) : null,
    pendingOnly: query.pending === '1'
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
            {{ station.name }} · 巡测断面测次
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ station.river }}</el-tag>
          </h2>
          <p class="gb-hint">
            巡测队登记测流起止时刻与实测流量；系统只把完整覆盖测流时段的水位过程段作为点据水位，缺段或空读数时挂起等待补录。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="RefreshRight" :loading="retrying" :disabled="stats.pendingCount === 0" @click="retryAll">
            重试挂接 ({{ stats.pendingCount }})
          </el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增测次</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="测次总数" :value="stats.count" suffix="次" icon="Files" />
        <StatBadge
          label="已挂接水位"
          :value="stats.currentStageM === null ? '—' : stats.currentStageM.toFixed(2)"
          suffix="m"
          tone="info"
          icon="Odometer"
        />
        <StatBadge
          label="待补录挂起"
          :value="stats.pendingCount"
          suffix="次"
          :tone="stats.pendingCount > 0 ? 'danger' : 'success'"
          icon="WarningFilled"
        />
        <StatBadge label="垂线合计" :value="stats.verticalCount" suffix="条" tone="success" icon="Histogram" />
      </div>

      <FilterBar
        :model-value="filterModel"
        :selects="[
          { key: 'methods', label: '测法', options: MEASURE_METHODS.map((method) => ({ label: method, value: method })) }
        ]"
        :number-ranges="[{ key: 'minStageM', label: '点据水位不低于', placeholder: '不限', unit: 'm' }]"
        keyword-placeholder="搜索测次号 / 测法"
        @change="handleFilterChange"
        @reset="handleReset"
      >
        <template #extra>
          <el-checkbox
            :model-value="sectionStore.filter.pendingOnly"
            @update:model-value="(value: string | number | boolean) => { sectionStore.patchFilter({ pendingOnly: Boolean(value) }); handleFilterChange() }"
          >
            只看待挂接
          </el-checkbox>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="sectionRows.length === 0"
        :title="allSections.length === 0 ? '该测站还没有测次' : '没有符合条件的测次'"
        description="新增一次流量测验并登记测流起止时段；若水位过程段缺测，点据会先挂起，不能用邻段水位顶替。"
        action-text="新增测次"
        secondary-text="重置筛选"
        @action="openCreate"
        @secondary="handleReset"
      />

      <el-table v-else :data="sectionRows" border stripe class="gb-table-compact">
        <el-table-column prop="measureNo" label="测次号" min-width="145" />
        <el-table-column label="测法" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.method === 'ADCP' ? 'success' : row.method === '浮标' ? 'warning' : 'primary'" effect="plain">
              {{ row.method }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测流时段" min-width="230">
          <template #default="{ row }">
            <div class="gb-mono">{{ new Date(row.startedAt).toLocaleString('zh-CN') }}</div>
            <div class="gb-mono gb-hint">至 {{ new Date(row.endedAt).toLocaleString('zh-CN') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据水位 (m)" width="150" align="right">
          <template #default="{ row }">
            <el-tag v-if="!row.linkOk" type="danger" effect="plain">待补录</el-tag>
            <span v-else class="gb-mono">{{ row.linkedStageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.measuredFlowM3s === null ? '—' : row.measuredFlowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="挂接状态 / 原因" min-width="210">
          <template #default="{ row }">
            <el-tag v-if="row.linkOk" type="success" size="small" effect="plain">已挂接</el-tag>
            <div v-else>
              <el-tag type="danger" size="small" effect="plain">挂起</el-tag>
              <span class="gb-hint">{{ row.linkReason }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="垂线" width="80" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoVerticals(row)">
              {{ sectionStore.sectionVerticalCounts[row.id] ?? 0 }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="285" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoVerticals(row)">垂线</el-button>
            <el-button v-if="!row.linkOk" size="small" type="warning" :icon="RefreshRight" @click="retryLink(row)">重试</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSection(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <p class="gb-hint">
        挂接失败后只由巡测队在此页重试；水位站补录过程段后，挂过该段的点据会自动按新读数重新取水位，已定案定线不回改。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑测次（巡测队）' : '新增断面测次（巡测队）'" width="600px" :close-on-click-modal="false">
      <el-form label-width="112px">
        <el-form-item label="测次号" required>
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="测法" required>
          <el-radio-group v-model="form.method">
            <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="测流起止" required>
          <div class="page__time-row">
            <el-date-picker v-model="form.startedAt" type="datetime" placeholder="开始时刻" value-format="YYYY-MM-DDTHH:mm" />
            <span>至</span>
            <el-date-picker v-model="form.endedAt" type="datetime" placeholder="结束时刻" value-format="YYYY-MM-DDTHH:mm" />
          </div>
        </el-form-item>
        <el-form-item label="实测流量" required>
          <el-input-number v-model="form.measuredFlowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="起点距" required>
          <el-input-number v-model="form.startDistanceM" :min="0" :max="2000" :step="0.5" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        title="本页不手填水位。保存后按测流时段向水位过程段挂接；缺段或空读数时点据挂起等待补录。"
        class="page__note"
      />
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重试挂接' : '新增并对账' }}
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
.page__actions,
.page__time-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
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
.page__note {
  margin-top: 8px;
}
</style>
