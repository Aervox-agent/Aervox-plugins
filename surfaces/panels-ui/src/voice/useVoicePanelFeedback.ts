/**
 * 语音配置面板的共享交互状态：保存闪烁、试听忙碌与音频、错误文案。
 *
 * 本地输出面板与在线语音面板此前各自声明同一批 ref，并各自复制「保存成功闪一下」
 * 与「试听合成 → base64 data URL」的流程。两处文案是用户可见字符串，任一侧改动
 * 就会出现「一个面板闪、另一个不闪」或提示语不一致。这里把状态机收成一处，
 * 面板只保留自己真正的业务差异（本地有 ASR 段，在线有 API Key 与连通性测试）。
 */
import { ref } from 'vue'

/** 保存成功后按钮显示「已保存」的时长；两侧必须一致。 */
export const SAVED_FLASH_MS = 1600

/** 试听使用的固定文案；改这里即同时改两侧，避免只改一处。 */
export const PREVIEW_TEXT = '你好，我是思隅，很高兴与你相遇。'

export interface SynthesizedAudio {
  contentType: string
  audioBase64: string
}

export function useVoicePanelFeedback(errorFallback: { save: string; preview: string }) {
  const saving = ref(false)
  const savedFlash = ref(false)
  const previewBusy = ref(false)
  const previewAudio = ref<string | null>(null)
  const error = ref<string | null>(null)

  /** 短暂显示「已保存」；重复保存会重置计时，不会叠加。 */
  function flashSaved(): void {
    savedFlash.value = true
    setTimeout(() => { savedFlash.value = false }, SAVED_FLASH_MS)
  }

  function messageOf(cause: unknown, fallback: string): string {
    return cause instanceof Error ? cause.message : fallback
  }

  /**
   * 执行一次保存：统一维护 saving / error / 成功闪烁。
   *
   * 返回保存结果供调用方投影到自己持有的 config ref；抛错已被吞掉并转成
   * `error` 文案，因为面板的职责是如实显示失败而不是中断交互。
   */
  async function runSave<T>(save: () => Promise<T>): Promise<T | null> {
    saving.value = true
    error.value = null
    try {
      const result = await save()
      flashSaved()
      return result
    } catch (cause) {
      error.value = messageOf(cause, errorFallback.save)
      return null
    } finally {
      saving.value = false
    }
  }

  /**
   * 执行一次试听合成。`request` 负责各面板自己的参数组装（本地带 speakerId，
   * 在线带 endpoint 与 settings），本函数只管通用状态与 data URL 编码。
   */
  async function runPreview(
    request: () => Promise<SynthesizedAudio>,
    validate?: () => string | null,
  ): Promise<void> {
    const problem = validate?.()
    if (problem) {
      error.value = problem
      return
    }
    previewBusy.value = true
    error.value = null
    previewAudio.value = null
    try {
      const result = await request()
      previewAudio.value = `data:${result.contentType};base64,${result.audioBase64}`
    } catch (cause) {
      error.value = messageOf(cause, errorFallback.preview)
    } finally {
      previewBusy.value = false
    }
  }

  return { saving, savedFlash, previewBusy, previewAudio, error, runSave, runPreview, messageOf };
}
