/** 把 ISO 时刻转换为 el-date-picker datetime 使用的本地 yyyy-MM-ddTHH:mm 字符串 */
export function toLocalDateTimeInput(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

/** 把 el-date-picker 的本地 yyyy-MM-ddTHH:mm 字符串转换为 ISO 字符串 */
export function fromLocalDateTimeInput(value: string): string {
  return new Date(value).toISOString()
}
