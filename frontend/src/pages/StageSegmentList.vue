<script setup lang="ts">
/**
 * 水位站页面：维护水位过程段起止时刻与逐时读数。
 * 空读数显式保留；保存 / 补录后由巡测队挂接逻辑自动重取点据水位。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshLeft } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useStageStore, createEmptyStageSegmentDraft, type StageSegmentDraft } from '@/stores/stageStore'
import type { StageSegment } from '@/types/stageSegment'
import { initDatabase } from '@/utils/db'

const stationStore = useStationStore()
const stageStore = useStageStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const stationId = ref('')
const form = reactive<StageSegmentDraft>(createEmptyStageSegmentDraft())

const selectedSegment = ref<StageSegment | null>(null)
const fillDialogVisible = ref(false)
const fillAt = ref('')
const fillStageM = ref(0)
const activeNames = ref<string[]>([])

const segments = computed(() => stageStore.segmentsOfStation(stationId.value))
const station = computed(() => stationStore.stationById(stationId.value))

const stats = computed(() => {
  const list = segments.value
  const pending = list.reduce((sum, segment) => sum + segment.readings.filter((item) => item.stageM === null).length, 0)
  return {
    count: list.length,
    readingCount: list.reduce((sum, segment) => sum + segment.readings.length, 0),
    pending
  }
})

function nextSegmentNo(): string {
  const count = stageStore.stageSegments.filter((item) => item.stationId === stationId.value).length
  const month = new Date().toISOString().slice(0, 7).replace('-', '-')
  return `${month}-S${count + 1}`
}

function openCreate(): void {
  if (!stationId.value) {
    ElMessage.warning('请先选择测站')
    return
  }
  editingId.value = null
  Object.assign(form, createEmptyStageSegmentDraft(stationId.value), { segmentNo: nextSegmentNo() })
  dialogVisible.value = true
}

function openEdit(segment: StageSegment): void {
  editingId.value = segment.id
  Object.assign(form, {
    stationId: segment.stationId,
    segmentNo: segment.segmentNo,
    startedAt: segment.startedAt.slice(0, 16),
    endedAt: segment.endedAt.slice(0, 16),
    readings: segment.readings.map((item) => ({ ...item })),
    note: segment.note
  })
  dialogVisible.value = true
}

/** 按起止时刻生成整点读数；已存在的读数（含空值）原样保留 */
function generateHourlyReadings(): void {
  const start = new Date(form.startedAt)
  const end = new Date(form.endedAt)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    ElMessage.warning('请先填写有效的起止时刻')
    return
  }
  const existing = new Map(form.readings.map((item) => [new Date(item.at).toISOString(), item]))
  const rows = []
  const cursor = new Date(start)
  while (cursor.getTime() <= end.getTime()) {
    const at = cursor.toISOString()
    rows.push(existing.get(at) ?? { at, stageM: null })
    cursor.setTime(cursor.getTime() + 3600_000)
  }
  form.readings = rows
  ElMessage.success(`已生成 ${rows.length} 个整点读数，空读数保持为空`)
}

function addReading(): void {
  form.readings.push({ at: new Date().toISOString().slice(0, 16), stageM: null })
}

function clearReadingValue(index: number): void {
  form.readings[index].stageM = null
}

function removeReading(index: number): void {
  form.readings.splice(index, 1)
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!form.segmentNo.trim()) {
    ElMessage.warning('请填写段号')
    return
  }
  const startedAt = new Date(form.startedAt)
  const endedAt = new Date(form.endedAt)
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime()) || endedAt <= startedAt) {
    ElMessage.warning('结束时刻必须晚于开始时刻')
    return
  }
  const invalid = form.readings.some((item) => !Number.isFinite(Date.parse(item.at)))
  if (invalid) {
    ElMessage.warning('逐时读数存在无效时刻')
    return
  }

  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      segmentNo: form.segmentNo.trim(),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      readings: form.readings.map((item) => ({
        at: new Date(item.at).toISOString(),
        stageM: item.stageM
      })),
      note: form.note.trim()
    }
    if (editingId.value) {
      await stageStore.updateSegment(editingId.value, payload)
      ElMessage.success('过程段已保存，挂过该段的点据已重新取水位')
    } else {
      await stageStore.createSegment(payload)
      ElMessage.success('过程段已录入，挂过该时段的点据已重新取水位')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeSegment(segment: StageSegment): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除过程段「${segment.segmentNo}」后，挂接该段的测次会重新挂起等待补录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await stageStore.removeSegment(segment.id)
  ElMessage.success('过程段已删除，相关测次已重新挂起')
}

function openFill(segment: StageSegment, at: string, current: number | null): void {
  selectedSegment.value = segment
  fillAt.value = at.slice(0, 16)
  fillStageM.value = current ?? 0
  fillDialogVisible.value = true
}

async function submitFill(): Promise<void> {
  if (!selectedSegment.value) return
  if (!Number.isFinite(fillStageM.value)) {
    ElMessage.warning('请填写补录水位')
    return
  }
  await stageStore.fillReading(selectedSegment.value.id, new Date(fillAt.value).toISOString(), fillStageM.value)
  fillDialogVisible.value = false
  ElMessage.success('空读数已补录，挂过该过程段的点据已自动重新取水位')
}

onMounted(async () => {
  await initDatabase()
  stationId.value = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位站水位过程段</h2>
        <p class="gb-hint">
          水位站只管过程段起止时刻与逐时读数；空读数不顶替、不外推。保存后巡测队挂过该段的点据自动重新取水位。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" :disabled="!stationId" @click="openCreate">新增过程段</el-button>
    </div>

    <div class="page__toolbar">
      <span class="page__label">所属测站</span>
      <el-select v-model="stationId" placeholder="选择测站" class="page__station">
        <el-option v-for="item in stationStore.stations" :key="item.id" :label="item.name" :value="item.id" />
      </el-select>
      <el-tag v-if="station" effect="plain">{{ station.sectionCode }}</el-tag>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="过程段" :value="stats.count" suffix="段" icon="Files" />
      <StatBadge label="逐时读数" :value="stats.readingCount" suffix="个" tone="info" icon="DataLine" />
      <StatBadge
        label="空读数"
        :value="stats.pending"
        suffix="个"
        :tone="stats.pending > 0 ? 'danger' : 'success'"
        icon="WarningFilled"
      />
    </div>

    <EmptyPanel
      v-if="!stationId"
      title="请选择测站"
      description="先在测站台账中选择或新建一个水位站，再维护自记水位过程段。"
      compact
    />
    <EmptyPanel
      v-else-if="segments.length === 0"
      title="该站还没有水位过程段"
      description="录入过程段起止时刻并生成整点读数；暂缺的读数请留空，等待水位站补录。"
      action-text="新增过程段"
      @action="openCreate"
    />

    <el-collapse v-else v-model="activeNames" class="page__collapse">
      <el-collapse-item v-for="segment in segments" :key="segment.id" :name="segment.id">
        <template #title>
          <div class="page__segment-title">
            <strong>{{ segment.segmentNo }}</strong>
            <span class="gb-mono">
              {{ new Date(segment.startedAt).toLocaleString('zh-CN') }} ~ {{ new Date(segment.endedAt).toLocaleString('zh-CN') }}
            </span>
            <el-tag v-if="segment.readings.some((item) => item.stageM === null)" type="danger" size="small">
              空读数 {{ segment.readings.filter((item) => item.stageM === null).length }}
            </el-tag>
            <el-tag v-else type="success" size="small">读数完整</el-tag>
          </div>
        </template>

        <div class="page__segment-actions">
          <el-button size="small" :icon="Edit" @click.stop="openEdit(segment)">编辑段</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click.stop="removeSegment(segment)">删除</el-button>
        </div>

        <el-table :data="segment.readings" border size="small" class="gb-table-compact">
          <el-table-column label="读数时刻" min-width="180">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.at).toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="150" align="right">
            <template #default="{ row }">
              <el-tag v-if="row.stageM === null" type="danger" effect="plain">空，待补录</el-tag>
              <span v-else class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130">
            <template #default="{ row }">
              <el-button size="small" text type="primary" :icon="RefreshLeft" @click="openFill(segment, row.at, row.stageM)">
                {{ row.stageM === null ? '补录' : '改正' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <p v-if="segment.note" class="gb-hint">备注：{{ segment.note }}</p>
      </el-collapse-item>
    </el-collapse>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑水位过程段' : '新增水位过程段'" width="760px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" class="page__full" :disabled="editingId !== null">
            <el-option v-for="item in stationStore.stations" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="段号" required>
          <el-input v-model="form.segmentNo" placeholder="如 2024-08-S1" />
        </el-form-item>
        <el-form-item label="起止时刻" required>
          <div class="page__time-row">
            <el-date-picker v-model="form.startedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="开始" />
            <span>至</span>
            <el-date-picker v-model="form.endedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="结束" />
            <el-button @click="generateHourlyReadings">生成整点读数</el-button>
          </div>
        </el-form-item>
        <el-form-item label="逐时读数">
          <div class="page__readings">
            <div v-for="(item, index) in form.readings" :key="`${item.at}-${index}`" class="page__reading-row">
              <el-date-picker v-model="item.at" type="datetime" value-format="YYYY-MM-DDTHH:mm" size="small" />
              <el-input-number
                v-model="item.stageM"
                :min="-50"
                :max="200"
                :step="0.01"
                :precision="2"
                size="small"
                controls-position="right"
                placeholder="空"
              />
              <el-button size="small" text type="warning" @click="clearReadingValue(index)">置空</el-button>
              <el-button size="small" text type="danger" :icon="Delete" @click="removeReading(index)" />
            </div>
            <el-button size="small" :icon="Plus" @click="addReading">追加读数</el-button>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="补录情况、仪器故障等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存并重取挂接点据</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="fillDialogVisible" title="补录 / 改正逐时水位" width="420px">
      <el-form label-width="88px">
        <el-form-item label="读数时刻">
          <el-date-picker v-model="fillAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" disabled />
        </el-form-item>
        <el-form-item label="水位">
          <el-input-number v-model="fillStageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="fillDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitFill">保存补录</el-button>
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
.page__head,
.page__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}
.page__label {
  color: #5b6b78;
  font-size: 13px;
}
.page__station {
  width: 260px;
}
.page__full {
  width: 100%;
}
.page__time-row,
.page__reading-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.page__readings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.page__segment-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.page__segment-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 8px;
}
.page__unit {
  margin-left: 8px;
  color: #8194a2;
  font-size: 12px;
}
</style>
