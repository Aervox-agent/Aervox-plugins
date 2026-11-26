import { describe, expect, it, vi } from 'vitest'
import { PREVIEW_TEXT, SAVED_FLASH_MS, useVoicePanelFeedback } from '../src/voice/useVoicePanelFeedback'

const fallbacks = { save: '保存失败', preview: '试听失败' }

describe('voice panel feedback (shared by local and remote panels)', () => {
  it('projects a successful save and flashes the saved state', async () => {
    vi.useFakeTimers()
    const panel = useVoicePanelFeedback(fallbacks)
    const saved = await panel.runSave(async () => ({ id: 'vc_1' }))
    expect(saved).toEqual({ id: 'vc_1' })
    expect(panel.savedFlash.value).toBe(true)
    expect(panel.saving.value).toBe(false)
    expect(panel.error.value).toBeNull()
    vi.advanceTimersByTime(SAVED_FLASH_MS)
    expect(panel.savedFlash.value).toBe(false)
    vi.useRealTimers()
  })

  it('turns a failed save into an error message instead of throwing', async () => {
    const panel = useVoicePanelFeedback(fallbacks)
    const saved = await panel.runSave(async () => { throw new Error('boom') })
    expect(saved).toBeNull()
    expect(panel.error.value).toBe('boom')
    expect(panel.saving.value).toBe(false)
  })

  it('falls back to the panel-specific message when the cause is not an Error', async () => {
    const panel = useVoicePanelFeedback(fallbacks)
    await panel.runSave(async () => { throw 'not-an-error' })
    expect(panel.error.value).toBe(fallbacks.save)
  })

  it('blocks preview when validation reports a problem, without calling the API', async () => {
    const panel = useVoicePanelFeedback(fallbacks)
    const request = vi.fn()
    await panel.runPreview(request, () => '请先填写模型 ID')
    expect(request).not.toHaveBeenCalled()
    expect(panel.error.value).toBe('请先填写模型 ID')
    expect(panel.previewBusy.value).toBe(false)
  })

  it('encodes synthesised audio as a data URL', async () => {
    const panel = useVoicePanelFeedback(fallbacks)
    await panel.runPreview(async () => ({ contentType: 'audio/wav', audioBase64: 'AAA' }))
    expect(panel.previewAudio.value).toBe('data:audio/wav;base64,AAA')
    expect(panel.previewBusy.value).toBe(false)
  })

  it('clears a previous preview when a new attempt fails', async () => {
    const panel = useVoicePanelFeedback(fallbacks)
    await panel.runPreview(async () => ({ contentType: 'audio/wav', audioBase64: 'AAA' }))
    await panel.runPreview(async () => { throw new Error('offline') })
    expect(panel.previewAudio.value).toBeNull()
    expect(panel.error.value).toBe('offline')
  })

  it('keeps one preview sentence for both panels', () => {
    expect(PREVIEW_TEXT).toBe('你好，我是思隅，很高兴与你相遇。')
  })
})
