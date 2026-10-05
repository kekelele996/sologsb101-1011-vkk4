/**
 * 水位站 store：维护自记水位计的分段水位过程与逐时读数。
 * 水位站只负责过程段和读数，不修改巡测队的断面测次。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { WaterLevelSegment, WaterLevelReading } from '@/types/waterLevel'
import { useLinkageStore } from '@/stores/linkageStore'

function toIsoMinute(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

export const useWaterLevelStore = defineStore('waterLevel', () => {
  const segments = ref<WaterLevelSegment[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<WaterLevelSegment>(() => db.waterLevelSegments).subscribe((rows) => {
      segments.value = rows
      ready.value = true
    })
  }

  const segmentsByStation = computed<Record<string, WaterLevelSegment[]>>(() => {
    const map: Record<string, WaterLevelSegment[]> = {}
    segments.value.forEach((segment) => {
      const list = map[segment.stationId] ?? []
      list.push(segment)
      map[segment.stationId] = list
    })
    Object.values(map).forEach((list) =>
      list.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    )
    return map
  })

  function segmentsOfStation(stationId: string | null | undefined): WaterLevelSegment[] {
    if (!stationId) return []
    return segmentsByStation.value[stationId] ?? []
  }

  function segmentById(id: string | null | undefined): WaterLevelSegment | null {
    if (!id) return null
    return segments.value.find((segment) => segment.id === id) ?? null
  }

  function normalizeReadings(readings: WaterLevelReading[]): WaterLevelReading[] {
    const unique = new Map<string, WaterLevelReading>()
    readings.forEach((reading) => {
      const observedAt = toIsoMinute(reading.observedAt)
      if (Number.isNaN(Date.parse(observedAt))) return
      unique.set(observedAt, {
        observedAt,
        stageM: reading.stageM === null || !Number.isFinite(reading.stageM) ? null : reading.stageM
      })
    })
    return Array.from(unique.values()).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
  }

  async function createSegment(
    payload: Omit<WaterLevelSegment, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<WaterLevelSegment> {
    const now = Date.now()
    const row: WaterLevelSegment = {
      ...payload,
      readings: normalizeReadings(payload.readings),
      id: createId('wls'),
      createdAt: now,
      updatedAt: now
    }
    await db.waterLevelSegments.put(row)
    await useLinkageStore().refreshForStation(row.stationId)
    return row
  }

  async function updateSegment(id: string, patch: Partial<WaterLevelSegment>): Promise<void> {
    const existing = await db.waterLevelSegments.get(id)
    const next: Partial<WaterLevelSegment> = { ...patch, updatedAt: Date.now() }
    if (patch.readings) next.readings = normalizeReadings(patch.readings)
    if (patch.startsAt) next.startsAt = toIsoMinute(patch.startsAt)
    if (patch.endsAt) next.endsAt = toIsoMinute(patch.endsAt)
    await db.waterLevelSegments.update(id, next as never)
    const linkageStore = useLinkageStore()
    await linkageStore.refreshForStation(existing?.stationId ?? patch.stationId ?? '')
    if (existing && patch.stationId && patch.stationId !== existing.stationId) {
      await linkageStore.refreshForStation(patch.stationId)
    }
  }

  async function removeSegment(id: string): Promise<void> {
    const existing = await db.waterLevelSegments.get(id)
    await db.waterLevelSegments.delete(id)
    if (existing) await useLinkageStore().refreshForStation(existing.stationId)
  }

  return {
    segments,
    segmentsByStation,
    ready,
    start,
    segmentsOfStation,
    segmentById,
    normalizeReadings,
    createSegment,
    updateSegment,
    removeSegment
  }
})
