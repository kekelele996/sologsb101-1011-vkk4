<script setup lang="ts">
/**
 * 水位过程页：水位站维护自记水位计的分段起止时刻与逐时读数。
 * 本页不修改巡测队测次；过程段保存后，由对账逻辑重新给相关点据取水位。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Delete, Edit, Plus, Timer, WarningFilled } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useStationStore } from '@/stores/stationStore'
import { useWaterLevelStore } from '@/stores/waterLevelStore'
import type { WaterLevelReading, WaterLevelSegment } from '@/types/waterLevel'
import { buildHourlyTimes } from '@/types/waterLevel'
import { initDatabase } from '@/utils/db'
import { fromLocalDateTimeInput, toLocalDateTimeInput } from '@/utils/time'

const stationStore = useStationStore()
const waterLevelStore = useWaterLevelStore()

const selectedStationId = ref('')
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)

interface ReadingDraft {
  observedAtLocal: string
  stageM: number | null
}

const form = reactive({
  startsAtLocal: '',
  endsAtLocal: '',
  remark: '',
  readings: [] as ReadingDraft[]
})

const stations = computed(() => stationStore.stations)
const station = computed(() => stationStore.stationById(selectedStationId.value))
const segments = computed(() => waterLevelStore.segmentsOfStation(selectedStationId.value))

const stats = computed(() => {
  const allReadings = segments.value.flatMap((segment) => segment.readings)
  return {
    segmentCount: segments.value.length,
    readingCount: allReadings.length,
    missingCount: allReadings.filter((reading) => reading.stageM === null).length
  }
})

function syncReadingsFromWindow(): void {
  const times = buildHourlyTimes(fromLocalDateTimeInput(form.startsAtLocal), fromLocalDateTimeInput(form.endsAtLocal))
  const existing = new Map(form.readings.map((row) => [row.observedAtLocal, row.stageM]))
  form.readings = times.map((time) => {
    const local = toLocalDateTimeInput(time)
    return { observedAtLocal: local, stageM: existing.has(local) ? existing.get(local)! : null }
  })
}

function openCreate(): void {
  if (!selectedStationId.value) {
    ElMessage.warning('请先选择水位站')
    return
  }
  editingId.value = null
  const start = new Date(Math.ceil(Date.now() / 3600000) * 3600000)
  const end = new Date(start.getTime() + 3 * 3600000)
  form.startsAtLocal = toLocalDateTimeInput(start.toISOString())
  form.endsAtLocal = toLocalDateTimeInput(end.toISOString())
  form.remark = ''
  form.readings = []
  syncReadingsFromWindow()
  dialogVisible.value = true
}

function openEdit(segment: WaterLevelSegment): void {
  editingId.value = segment.id
  form.startsAtLocal = toLocalDateTimeInput(segment.startsAt)
  form.endsAtLocal = toLocalDateTimeInput(segment.endsAt)
  form.remark = segment.remark
  form.readings = segment.readings.map((reading) => ({
    observedAtLocal: toLocalDateTimeInput(reading.observedAt),
    stageM: reading.stageM
  }))
  dialogVisible.value = true
}

function addReading(): void {
  form.readings.push({
    observedAtLocal: form.startsAtLocal || toLocalDateTimeInput(new Date().toISOString()),
    stageM: null
  })
}

function removeReading(index: number): void {
  form.readings.splice(index, 1)
}

function validateReadings(): boolean {
  const start = Date.parse(fromLocalDateTimeInput(form.startsAtLocal))
  const end = Date.parse(fromLocalDateTimeInput(form.endsAtLocal))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    ElMessage.warning('过程段开始时刻不能晚于结束时刻')
    return false
  }
  const seen = new Set<string>()
  for (const row of form.readings) {
    const at = Date.parse(fromLocalDateTimeInput(row.observedAtLocal))
    if (!Number.isFinite(at)) {
      ElMessage.warning('存在无法识别的读数时刻')
      return false
    }
    if (at < start || at > end) {
      ElMessage.warning('逐时读数必须位于过程段起止时刻之间')
      return false
    }
    const key = String(at)
    if (seen.has(key)) {
      ElMessage.warning('存在重复的读数时刻')
      return false
    }
    seen.add(key)
    if (row.stageM !== null && (!Number.isFinite(row.stageM) || row.stageM < -50 || row.stageM > 200)) {
      ElMessage.warning('水位读数应为空或 -50 ~ 200 m 之间的数字')
      return false
    }
  }
  return true
}

async function submitForm(): Promise<void> {
  if (!validateReadings()) return
  submitting.value = true
  try {
    const readings: WaterLevelReading[] = form.readings
      .slice()
      .sort((a, b) => Date.parse(fromLocalDateTimeInput(a.observedAtLocal)) - Date.parse(fromLocalDateTimeInput(b.observedAtLocal)))
      .map((row) => ({ observedAt: fromLocalDateTimeInput(row.observedAtLocal), stageM: row.stageM }))
    const payload = {
      stationId: selectedStationId.value,
      startsAt: fromLocalDateTimeInput(form.startsAtLocal),
      endsAt: fromLocalDateTimeInput(form.endsAtLocal),
      readings,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await waterLevelStore.updateSegment(editingId.value, payload)
      ElMessage.success('水位过程段已补录 / 更新，相关点据已重新取水位')
    } else {
      await waterLevelStore.createSegment(payload)
      ElMessage.success('水位过程段已保存，系统已按测流时段对账')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeSegment(segment: WaterLevelSegment): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${new Date(segment.startsAt).toLocaleString('zh-CN')} 起的水位过程段后，盖在该段上的点据会重新挂接并可能转为待补录；确认删除？`,
      '删除水位过程段',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await waterLevelStore.removeSegment(segment.id)
  ElMessage.success('水位过程段已删除，相关点据已重新对账')
}

function missingCountOf(segment: WaterLevelSegment): number {
  return segment.readings.filter((reading) => reading.stageM === null).length
}

watch(
  stations,
  (list) => {
    if (!selectedStationId.value && list.length > 0) selectedStationId.value = list[0].id
  },
  { immediate: true }
)

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">自记水位过程段</h2>
        <p class="gb-hint">
          水位站只管过程段起止时刻与逐时读数；整编前按测流时段完整覆盖关系挂接，缺段或空读数不拿邻段顶替。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增过程段</el-button>
    </div>

    <el-card shadow="never" class="gb-panel page__selector">
      <span>水位站</span>
      <el-select v-model="selectedStationId" placeholder="请选择水位站" class="page__station-select">
        <el-option v-for="item in stations" :key="item.id" :label="`${item.name}（${item.sectionCode}）`" :value="item.id" />
      </el-select>
      <span v-if="station" class="gb-hint">{{ station.river }} · 集水面积 {{ station.catchmentKm2 }} km²</span>
    </el-card>

    <template v-if="selectedStationId">
      <div class="gb-stats-row">
        <StatBadge label="过程段" :value="stats.segmentCount" suffix="段" icon="Timer" />
        <StatBadge label="逐时读数" :value="stats.readingCount" suffix="个" tone="info" icon="DataLine" />
        <StatBadge
          label="待补读数"
          :value="stats.missingCount"
          suffix="个"
          :tone="stats.missingCount > 0 ? 'danger' : 'success'"
          :icon="stats.missingCount > 0 ? 'WarningFilled' : 'CircleCheck'"
        />
      </div>

      <EmptyPanel
        v-if="segments.length === 0"
        title="该水位站还没有过程段"
        description="先录入自记水位计过程段的起止时刻与逐时读数；巡测队随后可按测流时段重试挂接。"
        action-text="新增过程段"
        @action="openCreate"
      />

      <div v-else class="page__segments">
        <el-card v-for="segment in segments" :key="segment.id" shadow="never" class="page__segment">
          <template #header>
            <div class="page__segment-head">
              <div>
                <strong>{{ new Date(segment.startsAt).toLocaleString('zh-CN') }}</strong>
                <span class="page__arrow">→</span>
                <strong>{{ new Date(segment.endsAt).toLocaleString('zh-CN') }}</strong>
              </div>
              <div>
                <el-tag v-if="missingCountOf(segment) > 0" type="danger" effect="plain" :icon="WarningFilled">
                  {{ missingCountOf(segment) }} 个读数待补
                </el-tag>
                <el-tag v-else type="success" effect="plain" :icon="CircleCheck">读数完整</el-tag>
                <el-button size="small" :icon="Edit" @click="openEdit(segment)">补录 / 编辑</el-button>
                <el-button size="small" type="danger" plain :icon="Delete" @click="removeSegment(segment)">删除</el-button>
              </div>
            </div>
          </template>

          <el-table :data="segment.readings" border size="small" class="gb-table-compact">
            <el-table-column label="观测时刻" min-width="180">
              <template #default="{ row }">
                <span class="gb-mono">{{ new Date(row.observedAt).toLocaleString('zh-CN') }}</span>
              </template>
            </el-table-column>
            <el-table-column label="水位 (m)" width="150" align="right">
              <template #default="{ row }">
                <el-tag v-if="row.stageM === null" type="danger" size="small" effect="plain">空</el-tag>
                <span v-else class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
              </template>
            </el-table-column>
          </el-table>
          <p v-if="segment.remark" class="gb-hint page__remark">备注：{{ segment.remark }}</p>
        </el-card>
      </div>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '补录 / 编辑水位过程段' : '新增水位过程段'" width="760px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="开始时刻" required>
          <el-date-picker v-model="form.startsAtLocal" type="datetime" value-format="YYYY-MM-DDTHH:mm" @change="syncReadingsFromWindow" />
        </el-form-item>
        <el-form-item label="结束时刻" required>
          <el-date-picker v-model="form.endsAtLocal" type="datetime" value-format="YYYY-MM-DDTHH:mm" @change="syncReadingsFromWindow" />
        </el-form-item>
        <el-form-item label="过程段备注">
          <el-input v-model="form.remark" placeholder="如：自记水位计正常 / 某时读数待补" maxlength="80" />
        </el-form-item>
      </el-form>

      <div class="page__reading-head">
        <h3>逐时读数</h3>
        <div>
          <el-button size="small" @click="syncReadingsFromWindow">按整小时生成</el-button>
          <el-button size="small" :icon="Plus" @click="addReading">添加读数</el-button>
        </div>
      </div>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="勾选“读数空缺”表示等待水位站补录；空缺读数所在测流时段不会挂接，也不会借用邻段水位。"
        class="page__reading-alert"
      />
      <el-table :data="form.readings" border size="small" max-height="300">
        <el-table-column label="观测时刻" min-width="210">
          <template #default="{ $index }">
            <el-date-picker
              v-model="form.readings[$index].observedAtLocal"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm"
              size="small"
            />
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="190">
          <template #default="{ $index }">
            <div class="page__reading-value">
              <el-input-number
                v-model="form.readings[$index].stageM"
                :min="-50"
                :max="200"
                :step="0.01"
                :precision="2"
                :disabled="form.readings[$index].stageM === null"
                size="small"
                controls-position="right"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="读数空缺" width="100" align="center">
          <template #default="{ $index }">
            <el-checkbox
              :model-value="form.readings[$index].stageM === null"
              @change="
                (value: boolean) => {
                  form.readings[$index].stageM = value ? null : 0
                }
              "
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="center">
          <template #default="{ $index }">
            <el-button size="small" type="danger" text :icon="Delete" @click="removeReading($index)" />
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存过程段</el-button>
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

.page__selector {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page__station-select {
  width: 320px;
}

.page__segments {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__segment {
  border: 1px solid #d8e4ec;
}

.page__segment-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.page__arrow {
  margin: 0 8px;
  color: #8194a2;
}

.page__remark {
  margin: 8px 0 0;
}

.page__reading-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 4px 0 10px;
}

.page__reading-head h3 {
  margin: 0;
  font-size: 15px;
  color: #0f4c75;
}

.page__reading-alert {
  margin-bottom: 10px;
}

.page__reading-value {
  display: flex;
  justify-content: flex-end;
}
</style>
