<script setup lang="ts">
/**
 * 思隅·主动陪伴（方向 D 落地）——主界面替代根组件。
 *
 * 设计原则（用户确认的设计方向）：
 * - 保留角色和对话结构，以明确入口打开已有会话、学习与日记；
 * - 首页入口只做导航，不以固定文案冒充推荐或执行结果；
 * - 输入框常驻，草稿和未决提交随会话保留；
 * - 对话盒为思隅唯一声音出口：问候、流式回复、动作确认都经打字机呈现。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from 'vue';
import { useUISurfaceContext } from '@aervox/ui-host';
import { useMaterial3 } from '@aervox/ui/material3';
import { AervoxDialog, ExtensionSlot } from '@aervox/ui/primitives';
import { AervoxBrandMark, CompanionAvatar, UserQuestionComposer, readCompanionIdentity, useSessionDraft, useCompanionAvatarBinding } from '@aervox/ui/companion';
import { AervoxHttpError, createConversationController, getClientTransport, useAervoxApi, useAervoxPlugins, useAervoxSessions } from '@aervox/api-client';
import { createUIRegistry, provideUIRegistry, createWorkbenchPluginRuntime, createPluginEventBus, createPluginStateStore, provideUIPluginContext, resolveOutgoingMessage, type BuiltinUIPlugin, type UIPluginContext } from '@aervox/ui/plugin-api';
import { ArrowUpRight, BookOpen, Copy, History, Mic, Paperclip, RotateCcw, Settings, Square, Volume2, X } from 'lucide-vue-next';
import type { AskUserQuestionAnswerItem } from '@aervox/contracts';
import { useDialogueTyper } from './dialogue-typer';
import MobileSettingsDialog from './MobileSettingsDialog.vue';
import MobileSessionsDialog from './MobileSessionsDialog.vue';
import MobileHistoryDialog from './MobileHistoryDialog.vue';
import DiaryView from './DiaryView.vue';
import { renderMarkdown } from '@aervox/ui/markdown';
import '@aervox/ui/theme/companion';
import type { SurfaceNavigation } from '@aervox/ui/companion';

const props = withDefaults(defineProps<{
  surfaceNavigation?: SurfaceNavigation;
  settingsPanels?: readonly { category: string; component: Component }[];
  plugins?: BuiltinUIPlugin[];
  nativeRuntime?: boolean;
  learningPanel?: Component;
  draftStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}>(), { settingsPanels: () => [], plugins: () => [] });
const settingsOpen = ref(false);
const settingsDialog = ref<InstanceType<typeof MobileSettingsDialog>>();
const todayOpen = ref(false);
const learningOpen = ref(false);
const diaryOpen = ref(false);

const surface = useUISurfaceContext();
const avatarBinding = useCompanionAvatarBinding();
const registry = createUIRegistry();
provideUIRegistry(registry);
const pluginEvents = createPluginEventBus();
const pluginState = createPluginStateStore();
const pluginApi = useAervoxPlugins();
const learning = useAervoxApi();
const pluginLoadError = ref(false);
const material3 = useMaterial3();
const mobileScreen = ref<HTMLElement>();
const mobileFeedbackRegion = ref<HTMLElement>();
// The Android composition root registers the official Material Web elements.
// Other hosts keep their existing native controls and visual language.
const buttonTag = (materialTag: string) => material3 ? materialTag : 'button';
const sessions = useAervoxSessions();
const resumeSession = computed(() => sessions.activeSession.value ?? [...sessions.sessions.value]
  .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null);
const sessionsOpen = ref(false);
const historyOpen = ref(false);
const historySessionId = ref('');
const historyTitle = ref('');
const sessionsReady = ref(false);
const sessionChanging = ref(false);
const preparingSession = ref(false);
const sessionFeedback = ref('');
const sessionCreationError = ref('');
const sessionListError = ref<string | null>(null);
const sessionManaging = ref(false);
const sessionManageError = ref<string | null>(null);
// A stale management failure should not greet the next opening of the list.
watch(sessionsOpen, open => { if (open) sessionManageError.value = null; });
const mobileSessionTitle = computed(() => sessions.activeSession.value?.title ?? (!sessionsReady.value ? '正在读取会话…'
  : sessions.activeSessionError.value ? sessions.activeSessionError.value.startsWith('当前会话已不存在') ? '当前会话不可用' : '当前会话未能确认'
  : sessionListError.value ? '会话读取失败' : sessions.activeSessionId.value && sessions.activeSessionId.value !== 'web_default' ? '当前会话未能确认' : '新对话'));

/* ---------- 卡片堆叠（对话 / 会话 / 工具 / 日记，横向滑动切换） ---------- */
const deckTrack = ref<HTMLDivElement>();
const deckIndex = ref(0);
const deckSize = computed(() => material3 ? 4 : 1);
function onDeckScroll() {
  const track = deckTrack.value;
  if (!track || !track.clientWidth) return;
  deckIndex.value = Math.min(Math.max(Math.round(track.scrollLeft / track.clientWidth), 0), deckSize.value - 1);
}
function goDeck(index: number, behavior: ScrollBehavior = 'smooth') {
  const track = deckTrack.value;
  if (!track) return;
  if (typeof track.scrollTo === 'function') track.scrollTo({ left: index * track.clientWidth, behavior });
  else track.scrollLeft = index * track.clientWidth;
  deckIndex.value = index;
}

/* ---------- 日记（今天 + 往期） ---------- */
interface DiaryEntry { id: string; localDate: string; title: string; content: string }
const diaryToday = ref<DiaryEntry | null>(null);
const diaryPast = ref<DiaryEntry[]>([]);
/** 非空表示正在回看往期；空表示看今天。 */
const diaryViewing = ref<DiaryEntry | null>(null);
const diaryLoading = ref(false);
const diaryWriting = ref(false);
const diaryBusy = computed(() => diaryLoading.value || diaryWriting.value);
const diaryError = ref('');
const diaryNote = ref('');
let diaryLoadedDate = '';
const diaryHistoryOpen = ref(false);
const diaryShown = computed(() => diaryViewing.value ?? diaryToday.value);
const diaryTitle = computed(() => diaryShown.value?.title ?? '今天的日记');
const diaryBody = computed(() => {
  // 服务端把标题作为首行写入正文，卡片已单独显示标题，这里去掉重复的那一行与首尾空行。
  return (diaryShown.value?.content ?? '').replace(/^\s*标题[：:].*\n+/, '').trim();
});
const diaryLocalDate = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function loadDiary(force = false) {
  const localDate = diaryLocalDate();
  if (diaryLoading.value || (diaryWriting.value && !force) || (diaryLoadedDate === localDate && !force)) return;
  // A cached yesterday must never remain labelled as today's diary.
  if (diaryLoadedDate && diaryLoadedDate !== localDate
    || diaryToday.value && diaryToday.value.localDate !== localDate) {
    diaryToday.value = null; diaryViewing.value = null; diaryHistoryOpen.value = false; diaryNote.value = '';
  }
  diaryLoading.value = true;
  diaryError.value = '';
  let todayRead = false;
  let historyRead = false;
  try {
    diaryToday.value = await clientTransport.request<DiaryEntry>('GET', `/v1/diaries?localDate=${localDate}`);
    todayRead = true;
  } catch (error) {
    if (error instanceof AervoxHttpError && error.status === 404) {
      diaryToday.value = null;
      todayRead = true;
    } else {
      diaryError.value = '今天的日记没有读到，可以重试。';
    }
  }
  try {
    const list = await clientTransport.request<{ items: DiaryEntry[] }>('GET', '/v1/diaries?limit=8');
    diaryPast.value = list.items ?? [];
    historyRead = true;
  } catch {
    diaryError.value ||= '往期日记没有读到，可以重试。';
  }
  // Failed reads remain retryable when the card is revisited.
  diaryLoadedDate = todayRead && historyRead ? localDate : '';
  diaryLoading.value = false;
}

async function writeDiary() {
  if (diaryBusy.value || chatPending.value) return;
  diaryWriting.value = true;
  diaryError.value = '';
  diaryNote.value = '';
  try {
    const result = await clientTransport.request<{ diaryId: string; localDate: string; title: string; content: string; mode: string; generatedBy: string }>(
      'POST', '/v1/diaries/generate-today', { rewrite: diaryToday.value?.localDate === diaryLocalDate() },
    );
    const entry = { id: result.diaryId, localDate: result.localDate, title: result.title, content: result.content };
    diaryToday.value = entry;
    diaryPast.value = [entry, ...diaryPast.value.filter(item => item.id !== entry.id)].slice(0, 8);
    diaryViewing.value = null;
    diaryHistoryOpen.value = false;
    diaryNote.value = result.generatedBy === 'template' ? '已按模板写好；配置模型后我会亲手写。' : '写好了。';
    await loadDiary(true);
  } catch {
    diaryError.value = '这篇没写成，稍后再试。';
  } finally {
    diaryWriting.value = false;
  }
}

function openPastDiary(entry: DiaryEntry) {
  diaryViewing.value = entry;
  diaryHistoryOpen.value = false;
}
function closePastDiary() {
  diaryViewing.value = null;
}

// 只在真的翻到日记卡时读取，别让首页启动多两次请求。
const diaryVisible = computed(() => material3 ? deckIndex.value === 3 : diaryOpen.value);
watch(diaryVisible, visible => { if (visible) void loadDiary(); });
let diaryDayTimer: ReturnType<typeof setInterval> | undefined;
const refreshDiaryOnForeground = () => {
  if (!document.hidden && diaryVisible.value) void loadDiary();
};

/* ---------- 对话盒 ---------- */
const identity = readCompanionIdentity();
const companionName = ref(identity.companionName);
const greeting = '你好' + (identity.userAddress === '你' ? '' : '，' + identity.userAddress) + '，我是' + identity.companionName
  + '。想聊什么，直接告诉我。';
const dialogueCtx = ref(props.nativeRuntime ? '本机对话' : '主动陪伴 · 每日开场');
const { shown: dialogueText, streaming: dialogueTyping, say, appendDelta, finish } = useDialogueTyper(greeting);

function relativeDay(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '最近';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return '今天早些时候';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

const sending = ref(false);
const stopping = ref(false);
const waitingForReply = ref(false);
/** Device work is announced by tool name only; arguments can contain user text. */
const toolActivity = ref('');
const copyFeedback = ref('');
let copyTimer: ReturnType<typeof setTimeout> | undefined;
/** Copies only the text already shown, so a partial answer cannot be mistaken for a full one. */
async function copyReply() {
  const text = dialogueText.value;
  if (!text.trim() || dialogueTyping.value) return;
  try {
    await navigator.clipboard.writeText(text);
    copyFeedback.value = '已复制这次回复。';
  } catch {
    copyFeedback.value = '这台设备不允许直接复制，可以长按回复文字选择。';
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyFeedback.value = ''; }, 4000);
}
// inject() only resolves during setup; event handlers must reuse this capture.
const clientTransport = getClientTransport();
const dictationSupported = typeof clientTransport.speechInput === 'function';
const dictating = ref(false);
const dictationFeedback = ref('');
let dictationTimer: ReturnType<typeof setTimeout> | undefined;
const DICTATION_ERRORS: Record<string, string> = {
  RECORD_AUDIO_REQUIRED: '需要麦克风权限，请在系统设置中允许后重试。',
  NO_SPEECH: '没有听到内容，请再试一次。',
  SPEECH_INPUT_TIMEOUT: '聆听超时，请再试一次。',
  SPEECH_INPUT_BUSY: '正在聆听中，请稍候。',
  SPEECH_INPUT_UNAVAILABLE: '这台手机没有可用的语音识别。',
  SPEECH_INPUT_FAILED: '语音识别没有启动，请稍后再试。',
  CLOSED: '语音识别没有启动，请稍后再试。',
};
/** One bounded recognition fills the draft; the phone owns the recognizer. */
async function dictate() {
  if (!dictationSupported || dictating.value) return;
  dictating.value = true;
  dictationFeedback.value = '正在聆听…';
  try {
    const { text } = await clientTransport.speechInput!();
    whisperText.value = whisperText.value ? `${whisperText.value} ${text}` : text;
    dictationFeedback.value = '已识别，可继续编辑或发送。';
  } catch (error) {
    dictationFeedback.value = DICTATION_ERRORS[error instanceof Error ? error.message : '']
      ?? '语音识别没有开始，可以稍后再试。';
  } finally {
    dictating.value = false;
    clearTimeout(dictationTimer);
    dictationTimer = setTimeout(() => { dictationFeedback.value = ''; }, 4000);
  }
}
const speechSupported = typeof clientTransport.speakText === 'function';
const speechFeedback = ref('');
let speechTimer: ReturnType<typeof setTimeout> | undefined;
/** Reads the reply that is already on screen; the phone owns the speech engine. */
async function readAloud() {
  const text = dialogueText.value;
  if (!text.trim() || dialogueTyping.value || !speechSupported) return;
  speechFeedback.value = '';
  try {
    await clientTransport.speakText!({ text });
    speechFeedback.value = '正在朗读这次回复。';
  } catch (error) {
    speechFeedback.value = error instanceof Error && error.message === 'SPEECH_UNAVAILABLE'
      ? '这台手机没有可用的朗读引擎。'
      : '朗读没有开始，可以稍后再试。';
  }
  clearTimeout(speechTimer);
  speechTimer = setTimeout(() => { speechFeedback.value = ''; }, 4000);
}
const DEVICE_TOOL_LABELS: Record<string, string> = {
  device_tap: '正在点击屏幕…', device_swipe: '正在滑动屏幕…', device_key: '正在按键…',
  device_text: '正在输入文字…', device_launch_app: '正在打开应用…', device_info: '正在读取设备信息…',
};
const turnFeedback = ref<{ kind: 'connection-error' | 'observer-error' | 'turn-error' | 'cancel-error' | 'stopped' | 'completed'; message: string; action?: 'configure-model' }>();
// Local admission feedback belongs in the dialogue surface, while the last
// actual assistant text remains available to plugins and after dismissal.
const modelConfigurationNotice = computed(() => turnFeedback.value?.action === 'configure-model' ? turnFeedback.value.message : undefined);
const dialogueBox = ref<HTMLElement>();
function openModelConfiguration() {
  settingsDialog.value?.selectCategory('model');
  settingsOpen.value = true;
}
interface FailedTurn {
  content: string;
  source: 'suggestion' | 'whisper';
  sessionId?: string;
  draftText?: string;
  metadata?: Record<string, unknown>;
  attachment?: TextAttachment | null;
  draftReservationStarted?: boolean;
}
const failedTurn = shallowRef<FailedTurn>();
const turnController = createConversationController(clientTransport, surface.signal);
const conversationState = ref(turnController.state);
const unsubscribeConversation = turnController.subscribe(state => { conversationState.value = state; });
let pluginRuntime: ReturnType<typeof createWorkbenchPluginRuntime> | undefined;
async function refreshPluginUI() {
  if (!props.plugins.length || surface.signal.aborted) return;
  await pluginApi.loadPlugins();
  if (surface.signal.aborted) return;
  pluginLoadError.value = !!pluginApi.error.value;
  if (pluginLoadError.value) throw new Error('PLUGIN_LIST_UNAVAILABLE');
  await pluginRuntime?.sync(pluginApi.plugins.value, id => pluginApi.getConfig(id));
}
const unavailableCapability = (): never => { throw new Error('SURFACE_CAPABILITY_UNAVAILABLE'); };
const pluginContext: UIPluginContext = Object.freeze({
  navigation: Object.freeze({
    openTool: (tool: string) => { if (tool === 'history') openMobileHistory(); else if (tool === 'diary') openDiary(); else unavailableCapability(); },
    runMenuAction: (action: () => void) => action(),
  }),
  cards: Object.freeze({ reviewCount: computed(() => learning.dueReviews.value.length) }),
  conversation: Object.freeze({ streaming: computed(() => sending.value), latestAssistantText: computed(() => dialogueText.value) }),
  learning, pluginEvents, pluginState,
  isPluginAvailable: (id: string) => pluginRuntime?.isPluginAvailable(id) ?? false,
  refreshPluginUI,
  async sendMessage(value?: string, options?: {metadata?: Record<string, unknown>}) {
    if (!value?.trim()) return;
    if (!await sendTurn(value, 'suggestion', undefined, options?.metadata)) throw new Error('MESSAGE_NOT_COMPLETED');
  },
});
provideUIPluginContext(pluginContext);
pluginRuntime = createWorkbenchPluginRuntime(registry, () => pluginContext, props.plugins, { surfaceKind: 'companion' });
watch(settingsOpen, (open, previous) => {
  if (open && modelConfigurationNotice.value) turnFeedback.value = undefined;
  if (previous && !open) void refreshPluginUI().catch(() => undefined);
});
const interactionBusy = ref(false);
let stopPreparing = false;
let hasTurnReply = false;
const chatPending = computed(() => sending.value || stopping.value || interactionBusy.value
  || ['submitting', 'observing', 'awaiting-input', 'awaiting-approval', 'observer-error'].includes(conversationState.value.status)
  || conversationState.value.retryAvailable === true);
const sessionSwitchLocked = computed(() => chatPending.value || sessionChanging.value || sessionManaging.value || diaryWriting.value);
const switchLockReason = computed(() => diaryWriting.value ? '正在写日记，请等待完成后再发送、切换或新建会话。'
  : conversationState.value.retryAvailable && !conversationState.value.turnId
  ? '上一条消息的提交结果尚未确认，请先重试。回看记录不会再次发送消息。'
  : conversationState.value.question ? '请先回答当前问题，或明确停止当前回复，再切换会话。'
  : conversationState.value.approval ? '请先处理当前工具授权，或明确停止当前回复，再切换会话。'
  : '回复尚未结束。可以回看记录，结束当前回复后再切换或新建。');
const observationFailed = () => turnController.state.status === 'observer-error';
const canStop = computed(() => sending.value || ['observing', 'awaiting-input', 'awaiting-approval', 'observer-error'].includes(conversationState.value.status));
const companionStatus = computed(() => {
  if (stopping.value) return '正在停止';
  if (preparingSession.value || sessionChanging.value) return '正在准备会话';
  if (conversationState.value.question) return '等待你的回答';
  if (conversationState.value.approval) return '等待工具授权';
  if (conversationState.value.status === 'observer-error') return '接收已中断';
  if (sending.value || ['submitting', 'observing'].includes(conversationState.value.status)) return '正在回复';
  if (!sessionsReady.value) return '正在读取会话';
  if (sessionListError.value) return '会话读取失败';
  return '对话';
});

async function stopTurn() {
  if (!canStop.value || stopping.value) return;
  stopping.value = true;
  stopPreparing = true;
  turnFeedback.value = undefined;
  try {
    await turnController.stop();
    if (turnController.state.status === 'stopped') {
      finish(); waitingForReply.value = false;
      turnFeedback.value = {kind: 'stopped', message: '已停止回复。'};
    }
  } catch {
    stopPreparing = false;
    turnFeedback.value = {kind: 'cancel-error', message: '停止失败，回复仍在继续。可以再试一次。'};
  } finally { stopping.value = false; }
}

function dialogueCallbacks(previousContext: string, preserveReply = false) {
  let receivedReply = preserveReply;
  return {
    get hasReply() { return receivedReply; },
    onDelta(text: string) {
      if (surface.signal.aborted || !text) return;
      if (!receivedReply) { say(''); receivedReply = true; }
      hasTurnReply = true; waitingForReply.value = false;
      appendDelta(text);
    },
    onDone() {
      if (surface.signal.aborted) return;
      finish(); waitingForReply.value = false; toolActivity.value = '';
      dialogueCtx.value = turnController.state.question ? '等待你的回答' : turnController.state.approval ? '等待工具授权' : receivedReply ? companionName.value + ' · 刚刚回复' : previousContext;
      turnFeedback.value = receivedReply || turnController.state.question || turnController.state.approval ? undefined : {kind: 'completed', message: '本次回复已完成。'};
    },
    onError(error: unknown) { throw error; },
    onUserQuestion() { finish(); waitingForReply.value = false; dialogueCtx.value = '等待你的回答'; },
    onToolApproval() { finish(); waitingForReply.value = false; dialogueCtx.value = '等待工具授权'; },
    onEvent(event: { eventType?: string; data?: unknown }) {
      const name = (event.data as { name?: unknown } | undefined)?.name;
      if (event.eventType === 'tool_request' && typeof name === 'string' && DEVICE_TOOL_LABELS[name]) {
        toolActivity.value = DEVICE_TOOL_LABELS[name]!;
      } else if (event.eventType === 'tool_result') toolActivity.value = '';
    },
    onPluginEvent(eventType: string, data: unknown) { pluginEvents.emit(eventType, data); },
  };
}

async function sendTurn(content: string, source: 'suggestion' | 'whisper' = 'suggestion', draftText?: string, metadata?: Record<string, unknown>, submittedAttachment?: TextAttachment | null, draftReservationStarted = false) {
  if (surface.signal.aborted || sessionSwitchLocked.value) return false;
  if (!sessionsReady.value || sessionListError.value) {
    sessionFeedback.value = '请先读取会话列表，再发送消息。你的草稿会保留。'; sessionsOpen.value = true; return false;
  }
  if (sessions.activeSessionId.value && sessions.activeSessionId.value !== 'web_default'
    && !sessions.activeSession.value) {
    sessionFeedback.value = sessions.activeSessionError.value?.startsWith('当前会话已不存在')
      ? '当前会话已不可用，请选择其他会话或新建。草稿仍保留在原会话。'
      : '当前会话未能确认，请刷新后重试。草稿仍保留在原会话。';
    sessionsOpen.value = true; return false;
  }
  sending.value = true; waitingForReply.value = true; stopPreparing = false;
  turnFeedback.value = undefined; failedTurn.value = undefined; finish();
  const previousContext = dialogueCtx.value;
  let submission: FailedTurn = {content, source, draftText, metadata, attachment: submittedAttachment, draftReservationStarted};
  hasTurnReply = false;
  const callbacks = dialogueCallbacks(previousContext);
  try {
    if (!sessions.activeSessionId.value || sessions.activeSessionId.value === 'web_default') {
      const previousId = sessions.activeSessionId.value;
      preparingSession.value = true;
      try { await sessions.createNewSession(); } finally { preparingSession.value = false; }
      if (draftText !== undefined) transferInitialTextDraft(previousId, sessions.activeSessionId.value, draftText);
      transferUnsubmittedAttachment(previousId, sessions.activeSessionId.value, submittedAttachment);
    }
    surface.signal.throwIfAborted();
    if (stopPreparing) { turnFeedback.value = {kind: 'stopped', message: '已停止回复。'}; return false; }
    const sessionId = sessions.activeSessionId.value;
    if (draftText !== undefined && !draftReservationStarted) {
      drafts.beginDraftSubmission(draftText, sessionId);
      draftReservationStarted = true;
    }
    submission = {content, source, sessionId, draftText, metadata, attachment: submittedAttachment, draftReservationStarted};
    dialogueCtx.value = '正在回复';
    const outgoing = resolveOutgoingMessage(registry, content, {...metadata, ...identity});
    await turnController.submit(sessionId, outgoing.text, callbacks, {
      signal: surface.signal,
      metadata: outgoing.metadata,
      onAccepted: source === 'whisper' ? () => {
        if (surface.signal.aborted) return;
        drafts.acceptDraftSubmission(sessionId);
        acceptAttachmentSubmission(sessionId, submittedAttachment);
      } : undefined,
    });
    if (turnController.state.status === 'stopped') turnFeedback.value = {kind: 'stopped', message: '已停止回复。'};
    return turnController.state.status !== 'stopped';
  } catch (error) {
    if (!surface.signal.aborted) {
      finish(); waitingForReply.value = false;
      if (source === 'whisper') {
        if (turnController.state.turnId) {
          drafts.acceptDraftSubmission(submission.sessionId);
          if (submission.sessionId) acceptAttachmentSubmission(submission.sessionId, submittedAttachment);
        }
        else if (draftText !== undefined) drafts.restoreFailedDraft();
      }
      if (props.nativeRuntime && error instanceof AervoxHttpError && error.status === 422 && error.code === 'MODEL_NOT_CONFIGURED'
        && !turnController.state.turnId && !turnController.state.retryAvailable) {
        // Only a definite refusal can release the draft as a new action. An
        // earlier unknown acceptance still belongs to the controller's retry.
        drafts.completeDraftSubmission(submission.sessionId);
        failedTurn.value = undefined;
        turnFeedback.value = {kind: 'connection-error', message: '请先配置模型服务。消息尚未发送，草稿已保留。', action: 'configure-model'};
        dialogueCtx.value = previousContext;
        if (material3) goDeck(0, 'auto');
        void nextTick(() => {
          if (surface.signal.aborted || !modelConfigurationNotice.value) return;
          if (dialogueBox.value) dialogueBox.value.scrollTop = 0;
          dialogueBox.value?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        });
      } else if (observationFailed()) {
        turnFeedback.value = {kind: 'observer-error', message: '连接中断，已保留收到的回复。可恢复接收。'};
      } else {
        // Controller.retry owns uncertain submissions and their idempotency reservation.
        failedTurn.value = submission;
        turnFeedback.value = turnController.state.turnId
          ? {kind: 'turn-error', message: '本次回复未完成，已保留收到的内容。'}
          : {kind: 'connection-error', message: callbacks.hasReply ? '连接中断，已保留收到的回复。' : '未能收到回复，请重试。'};
        if (turnController.state.turnId) dialogueCtx.value = '回复未完成';
      }
    }
    return false;
  } finally { sending.value = false; stopping.value = false; waitingForReply.value = false; }
}

async function resumeAfterSavedAnswer() {
  if (sending.value || turnController.state.status !== 'observing' || !turnController.state.turnId) return;
  sending.value = true; waitingForReply.value = true;
  try { await turnController.observe(turnController.state.turnId, dialogueCallbacks(dialogueCtx.value, hasTurnReply), {
    afterEventId: turnController.state.afterEventId, signal: surface.signal,
  }); } catch {
    if (!surface.signal.aborted) turnFeedback.value = {kind: 'observer-error', message: '回答已保存，接收回复失败。可以恢复接收。'};
  } finally { sending.value = false; waitingForReply.value = false; }
}
async function answerQuestion(answers: AskUserQuestionAnswerItem[]) {
  if (interactionBusy.value) return;
  interactionBusy.value = true;
  let saved = false;
  try {
    await turnController.answer(answers); saved = true;
    dialogueCtx.value = '正在继续回复';
    await nextTick();
  } catch { turnFeedback.value = {kind: 'connection-error', message: '回答没有保存，请重试。'}; }
  finally { interactionBusy.value = false; }
  // A transport can finish its first stream while awaiting a question. Observe
  // the same turn without holding the answer control busy through its next question.
  if (saved) void resumeAfterSavedAnswer();
}
async function decideApproval(decision: 'granted' | 'denied') {
  if (interactionBusy.value || sending.value) return;
  interactionBusy.value = true; sending.value = true;
  turnFeedback.value = undefined;
  try { await turnController.decide(decision, dialogueCallbacks(dialogueCtx.value, hasTurnReply)); }
  catch { turnFeedback.value = {kind: observationFailed() ? 'observer-error' : 'connection-error', message: '授权或续跑连接失败，请重试。'}; }
  finally { interactionBusy.value = false; sending.value = false; }
}

function openResume() {
  const target = resumeSession.value;
  if (target) openMobileHistory(target.id, target.title);
}
function openDiary() {
  todayOpen.value = false;
  if (material3) goDeck(3);
  else diaryOpen.value = true;
}
function openLearning() {
  if (!props.learningPanel) return;
  todayOpen.value = false;
  learningOpen.value = true;
}

/* ---------- 悄悄话输入（淡化） ---------- */
const whisperText = ref('');
// Text attachments ride along with the next message (images await a multimodal
// bridge; a text file is an honest first slice of the attachment story).
interface TextAttachment { name: string; text: string }
const attachment = shallowRef<TextAttachment | null>(null);
const attachmentCache = new Map<string, { value: TextAttachment | null; stored: string | null | undefined }>();
const attachmentSupported = typeof clientTransport.pickTextFile === 'function';
// Match the host draft key namespace so the native cache allowlist accepts it.
const attachmentKey = (sessionId = sessions.activeSessionId.value) => `aervox-mobile-draft:attachment-${sessionId || 'none'}`;
const attachmentStorage = () => props.draftStorage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
function readOwnerAttachment(ownerId: string): TextAttachment | null {
  const cached = attachmentCache.get(ownerId);
  let raw: string | null;
  try { raw = attachmentStorage()?.getItem(attachmentKey(ownerId)) ?? null; }
  catch { return cached?.value ?? null; }
  // Reuse the exact object across A → B → A. A new pick updates this cache
  // even if its serialized bytes happen to match the older attachment.
  if (cached && (cached.stored === undefined || cached.stored === raw)) return cached.value;
  let value: TextAttachment | null = null;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && 'name' in parsed && typeof parsed.name === 'string'
      && 'text' in parsed && typeof parsed.text === 'string') value = parsed as TextAttachment;
  } catch { /* A corrupt draft is absent; do not compose it into a message. */ }
  attachmentCache.set(ownerId, { value, stored: raw });
  return value;
}
function persistOwnerAttachment(ownerId: string, value: TextAttachment | null): boolean {
  const key = attachmentKey(ownerId), serialized = value ? JSON.stringify(value) : null;
  let stored = attachmentCache.get(ownerId)?.stored;
  let persisted = true;
  try {
    const target = attachmentStorage();
    if (target) {
      stored = target.getItem(key);
      if (serialized === null) target.removeItem(key); else target.setItem(key, serialized);
      stored = target.getItem(key);
      persisted = stored === serialized;
    }
  } catch { persisted = false; /* Keep the latest in-process edit if persistence fails. */ }
  attachmentCache.set(ownerId, { value, stored });
  if (sessions.activeSessionId.value === ownerId) attachment.value = value;
  return persisted;
}
function transferUnsubmittedAttachment(fromId: string, toId: string, expected?: TextAttachment | null) {
  if (!expected || fromId === toId || readOwnerAttachment(fromId) !== expected || readOwnerAttachment(toId)) return;
  // Write the new owner first. If it cannot persist, keep the original owner's
  // copy as well as the visible in-process draft; a create receipt cannot lose it.
  if (persistOwnerAttachment(toId, expected) && readOwnerAttachment(fromId) === expected) persistOwnerAttachment(fromId, null);
}
function acceptAttachmentSubmission(ownerId: string, submitted?: TextAttachment | null) {
  // Owner cache identity protects both the visible chip and away-owner storage
  // from an old receipt after a same-content attachment has been picked anew.
  if (submitted && readOwnerAttachment(ownerId) === submitted) persistOwnerAttachment(ownerId, null);
}
function persistAttachment() {
  persistOwnerAttachment(sessions.activeSessionId.value, attachment.value);
}
function restoreAttachment() {
  attachment.value = readOwnerAttachment(sessions.activeSessionId.value);
}
restoreAttachment();
watch(() => sessions.activeSessionId.value, () => {
  attachment.value = null;
  restoreAttachment();
});
async function pickAttachment() {
  if (!attachmentSupported) return;
  try {
    const picked = await clientTransport.pickTextFile!();
    // Keep the JSON envelope under the host draft value cap (32 KiB).
    const budget = 28 * 1024;
    const text = picked.text.length > budget
      ? `${picked.text.slice(0, budget)}\n（附件超过 28 KiB，已截断）`
      : picked.text;
    attachment.value = { name: picked.name, text };
    persistAttachment();
  } catch (error) {
    // Cancellation is quiet; a broken picker must be visible, not swallowed.
    const code = error instanceof Error ? error.message : '';
    if (code !== 'FILE_PICK_CANCELLED') dictationFeedback.value = '文件选择没有打开，可以稍后再试。';
  }
}
const whisperInput = ref<HTMLInputElement | HTMLTextAreaElement>();
const drafts = useSessionDraft({ input: whisperText, sessionId: sessions.activeSessionId, storage: props.draftStorage,
  enabled: computed(() => true) });
function transferInitialTextDraft(fromId: string, toId: string, text: string) {
  if (drafts.transferUnsubmittedDraft(fromId, toId, text) || fromId || !toId || !text.trim() || whisperText.value.trim()) return;
  // The shared draft helper persists named owners only. An initial empty owner
  // has its text in memory; move it after creation before stop/submit can return.
  whisperText.value = text;
  drafts.saveDraft(text, toId);
  try {
    const target = attachmentStorage();
    if (target?.getItem(`aervox-mobile-draft:${encodeURIComponent(toId)}`) === text
      && target.getItem('aervox-mobile-draft:') === text) target.removeItem('aervox-mobile-draft:');
  } catch { /* Keep the visible text and any original persisted copy. */ }
}
// 输入条常驻（没有收起态），因此不再注册返回层：返回键应交给当前弹层，
// 而不是收起一个永远可见的输入框。
function resizeWhisper() {
  if (!material3 || !(whisperInput.value instanceof HTMLTextAreaElement)) return;
  const input = whisperInput.value;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}
let whisperResizeObserver: ResizeObserver | undefined;
let whisperResizePending = false;
let whisperDisposed = false;
function scheduleWhisperResize() {
  if (!material3 || whisperResizePending || whisperDisposed) return;
  whisperResizePending = true;
  void nextTick(() => {
    whisperResizePending = false;
    if (!whisperDisposed) resizeWhisper();
  });
}
watch(whisperInput, input => {
  whisperResizeObserver?.disconnect();
  whisperResizeObserver = undefined;
  if (!material3 || !(input instanceof HTMLTextAreaElement)) return;
  scheduleWhisperResize();
  if (typeof ResizeObserver === 'undefined') return;
  let previousWidth: number | undefined;
  whisperResizeObserver = new ResizeObserver(entries => {
    if (whisperDisposed || whisperInput.value !== input) return;
    const width = entries.find(entry => entry.target === input)?.contentRect.width;
    // Growing the textarea changes its height too. Only width changes alter
    // wrapping, so our own height write must not trigger another measurement.
    if (width === undefined || width === previousWidth) return;
    previousWidth = width;
    scheduleWhisperResize();
  });
  whisperResizeObserver.observe(input);
}, { flush: 'post' });
watch([whisperText, settingsOpen, sessionsOpen, historyOpen], scheduleWhisperResize, { immediate: true, flush: 'post' });
async function openWhisper() {
  await nextTick();
  whisperInput.value?.focus();
  // 手机输入条常驻：再次聚焦也要按当前内容重测高度（草稿恢复、窗口宽度变化后同理）。
  scheduleWhisperResize();
}
async function closeWhisper() {
  await nextTick();
  whisperInput.value?.blur();
  mobileScreen.value?.focus({ preventScroll: true });
}
function onWhisperKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && (!material3 || event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendWhisper();
  } else if (event.key === 'Escape') void closeWhisper();
}
async function sendWhisper() {
  const raw = whisperText.value;
  const text = raw.trim();
  if (!text || sending.value) return;
  const attached = attachment.value;
  const composed = attached ? `${text}\n\n（附件：${attached.name}）\n${attached.text}` : text;
  await sendTurn(composed, 'whisper', raw, undefined, attached);
}

async function retryTurn() {
  if (observationFailed()) {
    if (sending.value || !turnController.state.retryAvailable) return;
    sending.value = true; turnFeedback.value = undefined;
    try { await turnController.retry(dialogueCallbacks(dialogueCtx.value, hasTurnReply)); }
    catch { if (!surface.signal.aborted) turnFeedback.value = {kind: 'observer-error', message: '连接失败，已保留回复。可再次恢复接收。'}; }
    finally { sending.value = false; waitingForReply.value = false; }
    return;
  }
  const failed = failedTurn.value;
  if (!failed || sending.value) return;
  if (failed.sessionId && failed.sessionId !== sessions.activeSessionId.value) {
    sessionFeedback.value = '请回到原会话后恢复这条消息。提交结果和草稿仍保留。';
    return;
  }
  sending.value = true; waitingForReply.value = true; turnFeedback.value = undefined;
  try {
    await turnController.retry(dialogueCallbacks(dialogueCtx.value));
    failedTurn.value = undefined;
  } catch (error) {
    if (error instanceof Error && error.message === 'submission_not_retryable') {
      sending.value = false;
      // A definite retry is a new Turn, but the old draft reservation still
      // owns its original edit history (or was already cleared by acceptance).
      await sendTurn(failed.content, failed.source, failed.draftText, failed.metadata, failed.attachment, failed.draftReservationStarted);
    } else if (!surface.signal.aborted) {
      turnFeedback.value = {kind: observationFailed() ? 'observer-error' : 'connection-error', message: '连接失败，请稍后重试。'};
      if (observationFailed()) failedTurn.value = undefined;
    }
  } finally { sending.value = false; waitingForReply.value = false; }
}

async function refreshMobileSessions() {
  sessionCreationError.value = '';
  await sessions.fetchSessions({ pageSize: 100, preserveSelection: true, includeActive: true });
  sessionsReady.value = true;
  sessionListError.value = sessions.error.value === sessions.activeSessionError.value ? null : sessions.error.value;
}
async function loadMoreSessions() {
  await sessions.loadMoreSessions();
  if (!surface.signal.aborted) sessionListError.value = sessions.error.value === sessions.activeSessionError.value ? null : sessions.error.value;
}
function openMobileHistory(id = sessions.activeSessionId.value, title = sessions.activeSession.value?.title ?? '当前会话') {
  historySessionId.value = id; historyTitle.value = title; historyOpen.value = true;
}
function resetMobilePresentation() {
  turnController.reset(); failedTurn.value = undefined; turnFeedback.value = undefined;
  hasTurnReply = false; waitingForReply.value = false; sessionFeedback.value = ''; toolActivity.value = '';
}
function selectMobileSession(id: string) {
  if (sessionSwitchLocked.value || !(sessions.activeSession.value?.id === id || sessions.sessions.value.some(item => item.id === id))) return;
  if (id !== sessions.activeSessionId.value) {
    resetMobilePresentation(); sessions.switchSession(id);
    say('已切换会话。可以回看已保存的记录，或继续发送消息。', '继续对话');
  }
  sessionsOpen.value = false;
}
async function createMobileSession() {
  if (sessionSwitchLocked.value || sessions.loading.value) return;
  sessionChanging.value = true; sessionFeedback.value = ''; sessionCreationError.value = '';
  const previous = sessions.activeSessionId.value, draft = whisperText.value, draftAttachment = attachment.value;
  try {
    await sessions.createNewSession();
    if (surface.signal.aborted) return;
    // Explicit creation supplies an authoritative selected session even if the
    // earlier list read failed. Do not keep that stale read error blocking it.
    sessionsReady.value = true; sessionListError.value = null;
    if (!previous || previous === 'web_default') {
      if (draft.trim()) transferInitialTextDraft(previous, sessions.activeSessionId.value, draft);
      transferUnsubmittedAttachment(previous, sessions.activeSessionId.value, draftAttachment);
    }
    resetMobilePresentation(); sessionsOpen.value = false;
    say('新的对话准备好了。想聊什么，直接告诉我。', '新对话');
  } catch { sessionCreationError.value = '新对话没有创建成功，草稿已保留。可以再次点击“新对话”。'; }
  finally { sessionChanging.value = false; }
}

/* ---------- 会话管理（改名 / 删除） ---------- */
/** Map a definite host rejection to an action the user can take; never claim success. */
function sessionFailure(error: unknown, fallback: string): string {
  if (error instanceof AervoxHttpError) {
    if (error.status === 409 && error.code === 'STOP_REPLY_BEFORE_DELETING') return '当前会话仍在回答或等待交互，请先停止再删除。';
    if (error.status === 404) return '该会话已不存在，列表已刷新。';
    if (error.status === 400) return '名称不合法，标题需为 1–200 个字符。';
  }
  return fallback;
}
async function renameMobileSession(id: string, title: string) {
  if (sessionManaging.value) return;
  if (!sessions.sessions.value.some(item => item.id === id)) return;
  sessionManaging.value = true; sessionManageError.value = null; sessionFeedback.value = ''; sessionCreationError.value = '';
  try {
    const updated = await sessions.renameSession(id, { title });
    if (surface.signal.aborted) return;
    if (!updated) throw new Error('SESSION_NOT_FOUND');
    // The list already holds the acknowledged title; the notice only reports it.
    sessionFeedback.value = `已改名为「${updated.title}」。`;
  } catch (error) {
    if (surface.signal.aborted) return;
    sessionManageError.value = sessionFailure(error, '改名没有成功，名称保持不变。可以重试。');
    if (error instanceof AervoxHttpError && error.status === 404) await refreshMobileSessions();
  } finally { sessionManaging.value = false; }
}
function clearDeletedSessionDrafts(id: string) {
  attachmentCache.delete(id);
  try {
    const target = props.draftStorage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    // Use the acknowledged deleted identity: the session hook may already have
    // selected a replacement, whose text and attachment must stay intact.
    target?.removeItem(`aervox-mobile-draft:${encodeURIComponent(id)}`);
    target?.removeItem(`aervox-mobile-draft:attachment-${id}`);
  } catch { /* Native storage exposes its persistence failure through the host. */ }
}
async function deleteMobileSession(id: string) {
  if (sessionManaging.value) return;
  const target = sessions.sessions.value.find(item => item.id === id);
  if (!target) return;
  const wasActive = id === sessions.activeSessionId.value;
  // A running or awaiting turn owns its session; stopping is a separate, explicit act.
  if (wasActive && sessionSwitchLocked.value) {
    sessionManageError.value = '当前会话仍在回答或等待交互，请先停止再删除。';
    return;
  }
  // Preserve drafts while deletion is pending: this surface can unmount before
  // a refusal arrives. After acknowledgement, the session hook changes draft
  // ownership and clearDeletedSessionDrafts removes only the deleted identity.
  const draft = wasActive ? whisperText.value : '';
  // Whether a replacement conversation survives decides the reported destination.
  const remaining = sessions.sessions.value.filter(item => item.id !== id).length;
  sessionManaging.value = true; sessionManageError.value = null; sessionFeedback.value = ''; sessionCreationError.value = '';
  try {
    await sessions.deleteSession(id);
    clearDeletedSessionDrafts(id);
    if (surface.signal.aborted) return;
    if (wasActive) {
      resetMobilePresentation();
      say(remaining
        ? '已删除当前会话。可以在会话列表里继续选择，或直接开始新的对话。'
        : '已删除当前会话。新的对话已准备好。', '会话已删除');
    }
    sessionFeedback.value = wasActive
      ? (draft ? '当前会话已删除，未发送的草稿一并清除。' : remaining ? '当前会话已删除，已切换到其他会话。' : '当前会话已删除，新的对话已准备好。')
      : `已删除「${target.title}」。`;
  } catch (error) {
    if (surface.signal.aborted) return;
    sessionManageError.value = sessionFailure(error, '删除结果未能确认，列表保持不变。可以刷新后重试。');
    if (error instanceof AervoxHttpError && error.status === 404) await refreshMobileSessions();
  } finally { sessionManaging.value = false; }
}

/* ---------- 回到默认工作台（逃生口） ---------- */
function backToDefaultSurface() { props.surfaceNavigation?.openDefault(); }

/* Follow the visible viewport when a mobile keyboard or browser toolbar moves. */
const viewportHeight = ref<number>();
const viewportTop = ref(0);
function syncViewport() {
  const viewport = window.visualViewport;
  // Pinch zoom must remain available without resizing the app's layout.
  if (viewport && viewport.scale !== 1) return;
  viewportHeight.value = viewport?.height ?? window.innerHeight;
  viewportTop.value = viewport?.offsetTop ?? 0;
}

onMounted(() => {
  if (surface.platform !== 'desktop') {
    let savedTheme: string | null = null;
    try { savedTheme = localStorage.getItem('aervox-theme'); } catch { /* Follow the system when storage is unavailable. */ }
    document.documentElement.dataset.theme = savedTheme === 'dark' || savedTheme === 'light'
      ? savedTheme : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  void refreshMobileSessions();
  void refreshPluginUI().catch(() => undefined);
  syncViewport();
  diaryDayTimer = setInterval(refreshDiaryOnForeground, 60_000);
  document.addEventListener('visibilitychange', refreshDiaryOnForeground);
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('resize', scheduleWhisperResize);
});
onBeforeUnmount(() => {
  whisperDisposed = true;
  clearTimeout(copyTimer);
  clearTimeout(speechTimer);
  clearTimeout(dictationTimer);
  whisperResizeObserver?.disconnect();
  whisperResizeObserver = undefined;
  unsubscribeConversation(); turnController.dispose();
  pluginRuntime?.destroy(); registry.dispose(); pluginState.dispose();
  finish();
  if (diaryDayTimer) clearInterval(diaryDayTimer);
  document.removeEventListener('visibilitychange', refreshDiaryOnForeground);
  window.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('scroll', syncViewport);
  window.removeEventListener('resize', scheduleWhisperResize);
});
</script>

<template>
  <div
    ref="mobileScreen"
    :tabindex="material3 ? -1 : undefined"
    class="proactive-companion"
    :class="{ 'pc-viewport--short': viewportHeight !== undefined && viewportHeight < 500, 'pc-has-feedback': material3 && !!turnFeedback && !modelConfigurationNotice }"
    :data-platform="surface.platform"
    :data-design-system="material3 ? 'material3' : undefined"
    :style="{ '--pc-viewport-height': viewportHeight === undefined ? undefined : `${viewportHeight}px`, '--pc-viewport-top': `${viewportTop}px` }"
  >
    <header class="pc-header">
      <div class="pc-brand"><AervoxBrandMark class="pc-brand-mark" :size="28" aria-hidden="true" /><span>思隅</span></div>
      <div class="pc-top-right">
        <component v-if="material3" :is="'md-icon-button'" class="pc-quiet-btn" type="button" title="回看当前会话" aria-label="回看当前会话" :disabled="!sessions.activeSession.value" @click="openMobileHistory()"><History :size="24" aria-hidden="true" /></component>
        <component v-if="material3" :is="'md-icon-button'" class="pc-quiet-btn" type="button" title="设置" aria-label="打开设置" @click="settingsOpen = true"><Settings :size="24" aria-hidden="true" /></component>
        <component :is="buttonTag('md-icon-button')" v-if="!material3" class="pc-quiet-btn" type="button" title="设置" aria-label="打开设置" @click="settingsOpen = true"><Settings :size="material3 ? 24 : 18" aria-hidden="true" /></component>
        <component :is="buttonTag('md-icon-button')" v-if="surfaceNavigation && !material3" class="pc-quiet-btn" type="button" title="回到完整工作台" aria-label="回到完整工作台" @click="backToDefaultSurface"><ArrowUpRight :size="material3 ? 24 : 19" aria-hidden="true" /></component>
      </div>
    </header>

    <p class="pc-current-session">{{ mobileSessionTitle }}</p>
    <main class="pc-content">
    <div class="pc-stage">
      <div class="pc-pet-wrap">
        <div class="pc-pet-status">{{ companionStatus }}</div>
        <CompanionAvatar :model="avatarBinding.model.value" :binding-state="avatarBinding.state.value" @retry-binding="avatarBinding.refresh" />
      </div>
    </div>

    <div class="pc-deck-track" ref="deckTrack" @scroll.passive="onDeckScroll">
    <section class="pc-dialogue pc-deck-slide" aria-label="陪伴对话">
      <div class="pc-dialogue-name">{{ companionName }}</div>
      <div ref="dialogueBox" class="pc-dialogue-box" :class="{ 'pc-dialogue-box--notice': !!modelConfigurationNotice }">
        <p v-if="modelConfigurationNotice" class="pc-dialogue-text pc-model-configuration-notice" role="status">{{ modelConfigurationNotice }}</p>
        <p v-else-if="waitingForReply" class="pc-dialogue-waiting" role="status">
          <component v-if="material3" :is="'md-linear-progress'" class="pc-material-progress" indeterminate aria-hidden="true" />
          <span v-else class="pc-waiting-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>正在等待回复…</span>
        </p>
        <!-- Typing stays plain so the caret lands on real characters; a finished
             answer renders the same safe markdown the history panel uses. -->
        <div v-else-if="!dialogueTyping && dialogueText.trim()" class="pc-dialogue-text markdown-body" aria-live="polite" v-html="renderMarkdown(dialogueText)" />
        <p v-else class="pc-dialogue-text" aria-live="polite">{{ dialogueText }}<span v-if="dialogueTyping" class="pc-caret" aria-hidden="true" /></p>
        <component :is="buttonTag('md-text-button')"
          v-if="modelConfigurationNotice"
          type="button"
          class="pc-configure-model pc-feedback-action"
          @click="openModelConfiguration"
        ><Settings :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 14" aria-hidden="true" />配置模型服务</component>
        <div class="pc-dialogue-foot">
          <span class="pc-dialogue-ctx">{{ modelConfigurationNotice ? '模型配置提示' : dialogueCtx }}</span>
          <span v-if="toolActivity" class="pc-dialogue-ctx pc-tool-activity" role="status">{{ toolActivity }}</span>
          <span v-if="copyFeedback && !modelConfigurationNotice" class="pc-dialogue-ctx pc-copy-feedback" role="status">{{ copyFeedback }}</span>
          <span v-if="speechFeedback && !modelConfigurationNotice" class="pc-dialogue-ctx pc-copy-feedback" role="status">{{ speechFeedback }}</span>
          <component v-if="material3 && !modelConfigurationNotice" :is="'md-icon-button'" class="pc-copy" type="button" aria-label="复制这次回复"
            :disabled="dialogueTyping || !dialogueText.trim()" @click="copyReply"><Copy :size="18" aria-hidden="true" /></component>
          <component v-if="material3 && speechSupported && !modelConfigurationNotice" :is="'md-icon-button'" class="pc-speak" type="button" aria-label="朗读这次回复"
            :disabled="dialogueTyping || !dialogueText.trim()" @click="readAloud"><Volume2 :size="18" aria-hidden="true" /></component>
        </div>
      </div>
      <Teleport :to="mobileFeedbackRegion" :disabled="!material3 || !mobileFeedbackRegion">
      <div v-if="turnFeedback && !modelConfigurationNotice" class="pc-feedback" :data-kind="turnFeedback.kind" role="status">
        <span>{{ turnFeedback.message }}</span>
        <component :is="buttonTag('md-text-button')"
          v-if="failedTurn"
          type="button"
          class="pc-retry pc-feedback-action"
          :disabled="sending || diaryWriting"
          @click="retryTurn"
        ><RotateCcw :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 14" aria-hidden="true" />重试发送</component>
        <component :is="buttonTag('md-text-button')" v-else-if="conversationState.status === 'observer-error' && conversationState.retryAvailable" type="button" class="pc-resume pc-feedback-action" :disabled="sending" @click="retryTurn"><RotateCcw :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 14" aria-hidden="true" />恢复接收回复</component>
        <component :is="buttonTag('md-text-button')" v-else-if="turnFeedback.kind === 'cancel-error' && sending" type="button" class="pc-retry pc-feedback-action" :disabled="stopping" @click="stopTurn">重试停止</component>
      </div>
      </Teleport>
    </section>

    <section v-if="material3" class="pc-deck-slide" aria-label="会话">
      <div class="pc-dialogue-name">会话</div>
      <div class="pc-dialogue-box pc-deck-box">
        <div class="pc-deck-head">
          <span class="pc-deck-current">{{ mobileSessionTitle }}</span>
          <component :is="'md-filled-tonal-button'" type="button" class="pc-deck-new" :disabled="sessionSwitchLocked || sessions.loading.value" @click="createMobileSession()">新建对话</component>
        </div>
        <ul v-if="sessions.sessions.value.length" class="pc-deck-sessions">
          <li v-for="item in sessions.sessions.value.slice(0, 3)" :key="item.id">
            <button type="button" class="pc-deck-session" :class="{ 'is-active': item.id === sessions.activeSessionId.value }"
              :disabled="sessionSwitchLocked" @click="selectMobileSession(item.id)">
              <span class="pc-deck-session-title">{{ item.title }}</span>
              <span v-if="item.id === sessions.activeSessionId.value" class="pc-deck-session-mark">当前</span>
            </button>
          </li>
        </ul>
        <p v-else class="pc-deck-empty">{{ sessions.loading.value ? '正在读取会话…' : '还没有已保存的会话。' }}</p>
        <div class="pc-deck-foot">
          <component :is="'md-text-button'" type="button" aria-label="会话列表" @click="sessionsOpen = true">全部会话</component>
        </div>
      </div>
    </section>

    <section v-if="material3" class="pc-deck-slide" aria-label="工具">
      <div class="pc-dialogue-name">工具</div>
      <div class="pc-dialogue-box pc-deck-box pc-deck-box--tools">
        <div class="pc-deck-tools">
          <button v-if="attachmentSupported" type="button" class="pc-home-tool" aria-label="添加文本附件"
            :disabled="preparingSession || sessionChanging || !!attachment" @click="pickAttachment">
            <Paperclip :size="20" aria-hidden="true" /><span>{{ attachment ? '已附加文件' : '附加文件' }}</span>
          </button>
          <button v-if="dictationSupported" type="button" class="pc-home-tool" :aria-label="dictating ? '正在聆听' : '语音输入'"
            :disabled="dictating || preparingSession || sessionChanging" @click="dictate">
            <Mic :size="20" aria-hidden="true" /><span>{{ dictating ? '正在聆听…' : '语音输入' }}</span>
          </button>
        </div>
      </div>
    </section>

    <section v-if="material3" class="pc-deck-slide" aria-label="日记">
      <div class="pc-dialogue-name">日记</div>
      <div class="pc-dialogue-box pc-deck-box">
        <DiaryView :title="diaryTitle" :body="diaryBody" :busy="diaryBusy" :writing="diaryWriting" :has-today="!!diaryToday"
          :has-shown="!!diaryShown" :viewing-past="!!diaryViewing" :history-open="diaryHistoryOpen" :past="diaryPast"
          :error="diaryError" :note="diaryNote" :write-disabled="chatPending"
          @write="writeDiary" @refresh="loadDiary(true)" @toggle-history="diaryHistoryOpen = !diaryHistoryOpen"
          @select="openPastDiary" @today="closePastDiary" />
      </div>
    </section>
    </div>
    <div v-if="material3" class="pc-deck-dots" role="tablist" aria-label="卡片切换">
      <button v-for="(label, index) in ['对话', '会话', '工具', '日记']" :key="label" type="button" role="tab"
        class="pc-deck-dot" :class="{ 'is-active': deckIndex === index }" :aria-selected="deckIndex === index"
        :aria-label="'切换到' + label" @click="goDeck(index)" />
    </div>

    <section v-if="conversationState.question" class="pc-interaction" aria-label="回答问题">
      <UserQuestionComposer :question-data="conversationState.question" :submitting="interactionBusy" @submit="answerQuestion" />
    </section>
    <section v-if="conversationState.approval" class="pc-interaction" aria-label="工具授权">
      <p>请求执行 {{ conversationState.approval.toolName }}，需要你的确认。</p>
      <component :is="buttonTag('md-filled-button')" type="button" :disabled="interactionBusy || sending" @click="decideApproval('granted')">批准</component>
      <component :is="buttonTag('md-text-button')" type="button" :disabled="interactionBusy || sending" @click="decideApproval('denied')">拒绝</component>
    </section>

    <nav class="pc-home-nav" aria-label="首页入口">
      <button type="button" class="pc-home-entry" :class="{ 'pc-home-entry--material3': material3 }" :disabled="!resumeSession" @click="openResume">
        <span>接着上次</span><small>{{ resumeSession ? `${resumeSession.title} · ${relativeDay(resumeSession.updatedAt)}` : '尚未选择会话' }}</small>
      </button>
      <button type="button" class="pc-home-entry" :class="{ 'pc-home-entry--material3': material3 }" @click="todayOpen = true"><span>今日</span><small>学习与复习</small></button>
      <button type="button" class="pc-home-entry" :class="{ 'pc-home-entry--material3': material3 }" @click="sessionsOpen = true"><span>记录</span><small>已保存的会话</small></button>
      <button type="button" class="pc-home-entry" :class="{ 'pc-home-entry--material3': material3 }" @click="openDiary"><span>日记</span><small>今天与往期</small></button>
    </nav>
    <p v-if="pluginLoadError" class="pc-mobile-session-feedback" role="alert">扩展加载失败。<button type="button" @click="refreshPluginUI().catch(() => undefined)">重试加载</button></p>
    </main>

    <!-- Keep the same feedback and actions outside the phone's scrolling stage. -->
    <div v-if="material3" ref="mobileFeedbackRegion" class="pc-mobile-feedback" />
    <p v-if="preparingSession || sessionChanging" class="pc-mobile-preparing" role="status">正在准备新对话，草稿会保留…</p>
    <p v-if="sessionFeedback" class="pc-mobile-session-feedback" role="alert">{{ sessionFeedback }}</p>
    <p v-if="material3 && dictationFeedback" class="pc-mobile-status" role="status">{{ dictationFeedback }}</p>
    <aside class="pc-whisper pc-whisper--open" aria-label="对话输入">
      <div class="pc-whisper-input">
        <span v-if="attachment" class="pc-attachment-chip">
          <Paperclip :size="13" aria-hidden="true" />{{ attachment.name }}
          <button type="button" class="pc-attachment-remove" aria-label="移除附件" @click="attachment = null; persistAttachment()"><X :size="12" aria-hidden="true" /></button>
        </span>
        <label v-if="material3" class="pc-whisper-label" for="pc-material-whisper">悄悄对{{ companionName }}说</label>
        <textarea v-if="material3" :readonly="preparingSession || sessionChanging" id="pc-material-whisper" ref="whisperInput" v-model="whisperText" rows="1"
          :aria-label="'悄悄对' + companionName + '说'" placeholder="输入消息…" enterkeyhint="enter"
          @focus="openWhisper()" @input="scheduleWhisperResize" @keydown="onWhisperKeydown" />
        <input v-else ref="whisperInput" v-model="whisperText" :readonly="preparingSession || sessionChanging" :aria-label="'悄悄对' + companionName + '说'"
          :placeholder="'想到什么，直接告诉' + companionName" enterkeyhint="send" @keydown="onWhisperKeydown" />
        <component :is="buttonTag('md-filled-tonal-button')" v-if="canStop" type="button" class="pc-stop" :disabled="stopping" @click="stopTurn"><Square :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 12" aria-hidden="true" />{{ stopping ? '停止中' : '停止' }}</component>
        <component :is="buttonTag('md-filled-button')" v-else type="button" :disabled="!whisperText.trim() || sessionSwitchLocked || !sessionsReady" @click="sendWhisper()">发送</component>
      </div>
    </aside>
    <MobileSessionsDialog v-model="sessionsOpen" :sessions="sessions.sessions.value" :active-session-id="sessions.activeSessionId.value"
      :has-more="sessions.hasMore.value" :loading="sessions.loading.value" :error="sessionListError" :notice="sessionCreationError || sessionFeedback" :changing="sessionChanging" :switch-locked="sessionSwitchLocked" :lock-reason="switchLockReason"
      :managing="sessionManaging" :manage-error="sessionManageError"
      @refresh="refreshMobileSessions" @more="loadMoreSessions" @new="createMobileSession" @select="selectMobileSession" @history="session => openMobileHistory(session.id, session.title)"
      @rename="renameMobileSession" @delete="deleteMobileSession" />
    <MobileHistoryDialog v-model="historyOpen" :session-id="historySessionId" :title="historyTitle" />
    <AervoxDialog v-model="todayOpen" title="今日" :destroy-on-close="false" body-max-height="calc(100dvh - 180px)">
      <p>从已有学习记录或日记继续。打开入口不会发送消息。</p>
      <button v-if="learningPanel" type="button" class="pc-home-entry" :class="{ 'pc-home-entry--material3': material3 }" @click="openLearning"><BookOpen :size="18" aria-hidden="true" />学习与复习</button>
      <ExtensionSlot name="companion:cards" wrapper-class="pc-plugin-cards" />
      <p v-if="!learningPanel && !registry.getSlotComponents('companion:cards').length">当前宿主未提供学习入口。</p>
      <button type="button" class="pc-home-entry" :class="{ 'pc-home-entry--material3': material3 }" @click="openDiary">打开日记</button>
    </AervoxDialog>
    <AervoxDialog v-if="learningPanel" v-model="learningOpen" title="学习与复习" :destroy-on-close="false" body-max-height="calc(100dvh - 180px)">
      <component :is="learningPanel" />
    </AervoxDialog>
    <AervoxDialog v-if="!material3" v-model="diaryOpen" title="日记" :destroy-on-close="false" body-max-height="calc(100dvh - 180px)">
      <DiaryView :title="diaryTitle" :body="diaryBody" :busy="diaryBusy" :writing="diaryWriting" :has-today="!!diaryToday"
          :has-shown="!!diaryShown" :viewing-past="!!diaryViewing" :history-open="diaryHistoryOpen" :past="diaryPast"
          :error="diaryError" :note="diaryNote" :write-disabled="chatPending"
          @write="writeDiary" @refresh="loadDiary(true)" @toggle-history="diaryHistoryOpen = !diaryHistoryOpen"
          @select="openPastDiary" @today="closePastDiary" />
    </AervoxDialog>
    <MobileSettingsDialog ref="settingsDialog" v-model="settingsOpen" :panels="props.settingsPanels" />
    <ExtensionSlot name="companion:drawers" />
  </div>
</template>

<style scoped>
/* 方向 D：Codex 式克制 × 视觉小说。自包含表面，不依赖工作台主题链。 */
.proactive-companion {
  --pc-bg: #fbfbfa;
  --pc-ink: #17181a;
  --pc-ink-2: #565b63;
  --pc-ink-3: #656d79;
  --pc-feedback: #994424;
  --pc-line: rgba(23, 24, 26, .09);
  --pc-line-soft: rgba(23, 24, 26, .055);
  --pc-accent: #2f5bd0;
  --pc-accent-soft: rgba(47, 91, 208, .07);
  --pc-card: #fff;
  --pc-radius: 12px;
  --pc-ease: cubic-bezier(.22, 1, .36, 1);

  position: fixed;
  inset: var(--pc-viewport-top, 0px) 0 auto;
  height: var(--pc-viewport-height, 100dvh);
  /* The JS viewport var can go stale across window resizes (split screen,
   * freeform); dvh always tracks the real viewport and clamps the overshoot. */
  max-height: 100dvh;
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background:
    radial-gradient(46% 40% at 42% 62%, rgba(47, 91, 208, .05), transparent 70%),
    var(--pc-bg);
  color: var(--pc-ink);
  font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
}
.proactive-companion,
.proactive-companion :deep(*) { box-sizing: border-box; }
:root[data-theme="dark"] .proactive-companion {
  --pc-bg: #101318;
  --pc-ink: #e7ebf2;
  --pc-ink-2: #a4adbd;
  --pc-ink-3: #a0aabc;
  --pc-feedback: #f1b08d;
  --pc-line: rgba(231, 235, 242, .1);
  --pc-line-soft: rgba(231, 235, 242, .06);
  --pc-accent: #7ea2f8;
  --pc-accent-soft: rgba(126, 162, 248, .1);
  --pc-card: #171b22;
}

/* 顶栏与输入各占一行；只有中间内容随可用视口滚动。 */
.pc-header {
  z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-width: 0;
  padding: calc(8px + env(safe-area-inset-top, 0px))
    max(16px, env(safe-area-inset-right, 0px)) 8px
    max(16px, env(safe-area-inset-left, 0px));
}
.pc-brand {
  display: flex; align-items: center; gap: 9px; min-width: 0;
  font-size: 13.5px; font-weight: 600; letter-spacing: .02em; overflow-wrap: anywhere;
}
.pc-brand-mark {
  flex: 0 0 28px; color: var(--pc-ink);
}
.pc-top-right { display: flex; align-items: center; gap: 2px; }
.pc-quiet-btn {
  display: grid; place-items: center;
  width: 44px; height: 44px; flex: 0 0 44px; border: 0; background: transparent; border-radius: 8px;
  color: var(--pc-ink-3); cursor: pointer; font-size: 15px;
}
.pc-quiet-btn:hover { color: var(--pc-ink); background: rgba(128, 134, 146, .12); }
.pc-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: max-content;
  align-content: start;
  gap: 18px;
  min-width: 0; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: 16px max(16px, env(safe-area-inset-right, 0px)) 20px
    max(16px, env(safe-area-inset-left, 0px));
  scroll-padding-block: 16px;
}
.pc-content > * { min-width: 0; }
.pc-home-nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; width: 100%; max-width: 620px; justify-self: center; }
.pc-home-entry { display: flex; flex-direction: column; justify-content: center; gap: 6px; min-width: 0; min-height: 52px; padding: 10px 12px; border: 1px solid var(--pc-line, var(--border)); border-radius: 14px; background: var(--pc-card, var(--bg-card)); color: var(--pc-ink, var(--text-primary)); font: inherit; cursor: pointer; text-align: left; }
.pc-home-entry small { font-size: 11px; line-height: 16px; color: var(--pc-ink-3, var(--text-secondary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-home-entry:disabled { opacity: .6; cursor: default; }
.pc-home-entry:focus-visible { outline: 2px solid var(--pc-accent, var(--accent)); outline-offset: 2px; }
.pc-home-entry--material3 {
  min-height: 56px; background: var(--md-sys-color-surface-container); color: var(--md-sys-color-on-surface);
  border-color: var(--md-sys-color-outline-variant); font-size: 14px; line-height: 20px;
}
.pc-home-entry--material3 small { color: var(--md-sys-color-on-surface-variant); }
.proactive-companion[data-design-system="material3"] .pc-home-nav > .pc-home-entry:first-child:not(:disabled) {
  background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); border-color: transparent;
}
.proactive-companion[data-design-system="material3"] .pc-home-nav > .pc-home-entry:first-child:not(:disabled) small { color: var(--md-sys-color-on-primary-container); }
.pc-home-entry--material3:hover:not(:disabled),
.pc-home-entry--material3:active:not(:disabled) {
  background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);
}
.pc-home-entry--material3:hover:not(:disabled) small,
.pc-home-entry--material3:active:not(:disabled) small { color: var(--md-sys-color-on-primary-container); }
.pc-home-entry--material3:disabled {
  opacity: 1; background: var(--md-sys-color-surface-container); color: color-mix(in srgb, var(--md-sys-color-on-surface) 38%, transparent);
}
.pc-home-entry--material3:disabled small { color: color-mix(in srgb, var(--md-sys-color-on-surface) 38%, transparent); }
.pc-home-entry--material3:focus-visible { outline-color: var(--md-sys-color-primary); }
@media (max-width: 499px) { .pc-home-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.proactive-companion[data-design-system="material3"] .pc-home-nav {
  grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px;
}
.proactive-companion[data-design-system="material3"] .pc-home-nav > .pc-home-entry {
  min-height: 56px; gap: 4px; padding: 8px 6px;
}
.proactive-companion[data-design-system="material3"] .pc-home-nav > .pc-home-entry span,
.proactive-companion[data-design-system="material3"] .pc-home-nav > .pc-home-entry small {
  width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@media (max-width: 899px) and (min-height: 521px) {
  .proactive-companion[data-design-system="material3"][data-platform="mobile"] .pc-content { gap: 10px; padding-block: 10px 12px; }
}

/* 舞台跟随内容流；手机的对话层可覆盖角色下半身。 */
.pc-stage {
  display: grid; place-items: center;
  min-width: 0;
  padding-top: 24px;
  pointer-events: none;
}
.pc-pet-wrap {
  position: relative;
  width: min(280px, 76vw);
  height: clamp(180px, 29dvh, 300px);
  max-width: 100%;
  pointer-events: auto;
}
/* Explicit phone hosts let dialogue overlap the larger character's lower body.
 * Short viewports still yield the stage to dialogue and the software keyboard. */
@media (max-width: 899px) {
  .proactive-companion[data-platform="mobile"] .pc-stage {
    position: relative;
    z-index: 0;
    /* 舞台就是「角色可见窗口」：盒子比舞台高（人物因此被放大），
       超出部分在舞台底边裁掉，而卡片正好压在这条裁切线上。
       这样角色不会半透明地透出卡面，也不会从卡片下方露腿。 */
    align-items: start;
    overflow: hidden;
    height: clamp(280px, 42dvh, 480px);
  }

  .proactive-companion[data-platform="mobile"] .pc-pet-wrap {
    /* 角色按画布高度等比缩放到撑满（fitLive2DModelToViewport 只吃高度）：
       所以这里给得比舞台高，人物就更大；多出来的部分由舞台裁掉。 */
    width: min(420px, 96vw);
    height: clamp(440px, 72dvh, 720px);
  }
  /* Pixi sets an inline touch-action:none. Keep vertical page gestures while
   * retaining taps on the character in the larger phone stage. */
  .proactive-companion[data-platform="mobile"] .pc-pet-wrap :deep(canvas) {
    touch-action: pan-y pinch-zoom !important;
  }
  /* 卡片上提量 = 间隙 + 名牌高度 + 压住裁切线的重叠量（约 16px），
     让卡片盒子的上缘正好落在舞台裁切线略上方，盖住角色的断口。 */
  .proactive-companion[data-platform="mobile"] .pc-deck-track {
    display: flex; gap: 12px;
    overflow-x: auto; overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory; scrollbar-width: none;
    margin-block-start: clamp(-260px, -9dvh, -40px);
    padding-block-end: 2px;
    /* 三张卡统一尺寸：切换时不再因为内容多少而跳动，长内容在卡内滚动。 */
    height: clamp(200px, 31dvh, 270px);
  }
  .proactive-companion[data-platform="mobile"] .pc-deck-slide { height: 100%; }
  /* 卡片是纵向 flex，名牌作为 flex 项会被拉满整行——收成内容宽度的胶囊。 */
  .proactive-companion[data-platform="mobile"] .pc-deck-slide > .pc-dialogue-name { align-self: flex-start; }
  .proactive-companion[data-platform="mobile"] .pc-deck-track::-webkit-scrollbar { display: none; }
  .proactive-companion[data-platform="mobile"] .pc-deck-slide {
    flex: 0 0 100%; min-width: 0; display: flex; flex-direction: column;
    scroll-snap-align: center; scroll-snap-stop: always;
  }
  .proactive-companion[data-platform="mobile"] .pc-deck-box {
    flex: 1 1 auto; min-height: 0; overflow: hidden;
    display: flex; flex-direction: column;
  }
  /* 卡片高度固定后，长内容在卡内滚动：对话正文滚正文，会话列表滚列表，页脚常驻。 */
  .proactive-companion[data-platform="mobile"] .pc-deck-slide > .pc-dialogue-box:not(.pc-deck-box) {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain;
  }
  .proactive-companion[data-platform="mobile"] .pc-deck-sessions {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain;
  }
  .proactive-companion[data-platform="mobile"] .pc-deck-dots { display: flex; justify-content: center; gap: 2px; }
  .proactive-companion[data-platform="mobile"] .pc-dialogue {
    position: relative;
    z-index: 1;
    margin-block-start: 0;
  }
}
.pc-pet-wrap :deep(.aervox-companion-avatar),
.pc-pet-wrap :deep(.aervox-live2d-pet) { min-height: 0; }
.pc-pet-wrap :deep(.aervox-live2d-pet__canvas) { inset: 0; }
.pc-pet-status {
  position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
  max-width: 100%;
  font-size: 11px; color: var(--pc-ink-3); letter-spacing: .12em;
  display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere;
}
.pc-pet-status::before { content: ""; flex: 0 0 5px; width: 5px; height: 5px; border-radius: 50%; background: #35a06f; }

/* 对话盒 */
.pc-dialogue {
  width: 100%; max-width: 620px;
  justify-self: center;
  min-width: 0;
}
.pc-dialogue-name {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%;
  font-size: 11.5px; font-weight: 600; letter-spacing: .22em; color: var(--pc-ink-2);
  margin-bottom: 10px; margin-left: 4px; overflow-wrap: anywhere;
}
.pc-dialogue-name::after { content: ""; flex: 0 0 28px; width: 28px; height: 1px; background: var(--pc-line); }
.pc-dialogue-box {
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: 20px;
  min-width: 0; padding: 20px 20px 14px;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .05), 0 18px 48px -18px rgba(23, 24, 26, .16);
}
.pc-dialogue-text {
  font-size: 15px; line-height: 1.85; min-height: 56px;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;
}
/* Finished answers render block markdown, so wrapping returns to normal flow. */
.pc-dialogue-text.markdown-body { white-space: normal; }
.pc-dialogue-text :deep(p) { margin: 0 0 .7em; }
.pc-dialogue-text :deep(p:last-child) { margin-bottom: 0; }
.pc-dialogue-text :deep(ul), .pc-dialogue-text :deep(ol) { margin: .3em 0 .8em; padding-inline-start: 1.3em; }
.pc-dialogue-text :deep(li) { margin: .2em 0; }
.pc-dialogue-text :deep(code) { padding: .12em .35em; border-radius: 6px; background: var(--pc-line-soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
.pc-dialogue-text :deep(pre) { margin: .6em 0; padding: 12px; border-radius: 12px; background: var(--pc-line-soft); overflow-x: auto; }
.pc-dialogue-text :deep(pre code) { padding: 0; background: transparent; font-size: .88em; line-height: 1.6; }
.pc-dialogue-text :deep(h1), .pc-dialogue-text :deep(h2), .pc-dialogue-text :deep(h3) { margin: .8em 0 .4em; font-size: 1.05em; line-height: 1.45; }
.pc-dialogue-text :deep(blockquote) { margin: .6em 0; padding-inline-start: .8em; border-inline-start: 3px solid var(--pc-line); color: var(--pc-ink-2); }
.pc-dialogue-text :deep(a) { color: var(--pc-accent); text-decoration: underline; overflow-wrap: anywhere; }
.pc-dialogue-text :deep(img) { max-width: 100%; height: auto; border-radius: 12px; }
.pc-dialogue-text :deep(hr) { border: 0; border-top: 1px solid var(--pc-line); margin: 1em 0; }
.pc-dialogue-waiting {
  display: flex; align-items: center; gap: 10px;
  min-height: 56px; margin-block: 1em;
  font-size: 13px; line-height: 1.6; color: var(--pc-ink-2);
}
.pc-waiting-dots { display: flex; flex: 0 0 auto; gap: 4px; }
.pc-waiting-dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--pc-accent); animation: pc-waiting-pulse 1.2s var(--pc-ease) infinite; }
.pc-waiting-dots i:nth-child(2) { animation-delay: .15s; }
.pc-waiting-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes pc-waiting-pulse { 0%, 100% { opacity: .35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
.pc-caret {
  display: inline-block; width: 2px; height: 1em; background: var(--pc-ink-3);
  vertical-align: -2px; margin-left: 2px; animation: pc-caret-blink 1s steps(1) infinite;
}
@keyframes pc-caret-blink { 50% { opacity: 0; } }
.pc-dialogue-foot {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px;
  min-width: 0;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--pc-line-soft);
}
.pc-dialogue-ctx { min-width: 0; font-size: 11px; color: var(--pc-ink-3); letter-spacing: .04em; overflow-wrap: anywhere; }
.pc-tool-activity, .pc-copy-feedback {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 11px; border-radius: 999px; letter-spacing: .02em; font-weight: 600;
  color: var(--md-sys-color-primary, var(--pc-accent));
  background: color-mix(in srgb, var(--pc-accent) 10%, transparent);
}
.pc-copy { flex: 0 0 48px; width: 48px; height: 48px; margin-inline-start: auto; }
.pc-speak { flex: 0 0 48px; width: 48px; height: 48px; }
.pc-dictate { flex: 0 0 48px; width: 48px; height: 48px; }
.pc-mobile-status { flex: 0 0 auto; margin: 8px 16px; padding: 5px 14px; border-radius: 999px; font-size: 13px; line-height: 20px; color: var(--md-sys-color-on-surface-variant, var(--pc-ink-2)); background: var(--md-sys-color-surface-container, rgba(23, 24, 26, .05)); }
.pc-dialogue-foot button { min-width: 44px; min-height: 44px; }
.pc-feedback {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px;
  padding: 8px 4px 0; font-size: 12px; line-height: 1.6; color: var(--pc-ink-2);
}
.pc-feedback[data-kind$="error"] { color: var(--pc-feedback); }
.pc-feedback > span { min-width: 0; overflow-wrap: anywhere; }
.pc-feedback-action {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 44px; padding: 4px 8px; border: 0; border-radius: 8px;
  background: transparent; color: var(--pc-accent); font: inherit; font-weight: 600; cursor: pointer;
}
.pc-feedback-action:hover { background: var(--pc-accent-soft); }
.pc-feedback-action:disabled { color: var(--pc-ink-3); cursor: default; }

/* 悄悄话底栏随 visual viewport 缩放，始终留出安全区。 */
.pc-whisper {
  z-index: 6;
  display: flex; justify-content: flex-end;
  min-width: 0;
  padding: 10px max(16px, env(safe-area-inset-right, 0px))
    calc(12px + env(safe-area-inset-bottom, 0px))
    max(16px, env(safe-area-inset-left, 0px));
  background: var(--pc-bg);
}
.pc-stop { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 44px; min-height: 44px; margin-left: 8px; padding: 8px 12px; border: 1px solid var(--pc-line); border-radius: 10px; background: var(--pc-card); color: var(--pc-ink); font: inherit; font-size: 12px; cursor: pointer; }
.pc-stop:disabled { opacity: .5; cursor: default; }
.pc-stop:focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 3px; }

.pc-whisper--open { justify-content: center; }
.pc-whisper-input {
  display: flex; width: 100%; max-width: 620px; min-width: 0; align-items: center; gap: 6px;
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: 26px;
  padding: 6px 8px 6px 16px;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .05), 0 18px 48px -18px rgba(23, 24, 26, .18);
}
.pc-whisper-input input {
  flex: 1 1 0%; min-width: 0; width: 0; min-height: 44px;
  border: 0; outline: 0; font: inherit; font-size: 16px;
  color: var(--pc-ink); background: transparent;
}
.pc-whisper-input input::placeholder { color: var(--pc-ink-3); opacity: 1; }
.pc-whisper-input button {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  flex: 0 0 auto; min-width: 44px; min-height: 44px;
  border: 0; background: var(--pc-ink); color: var(--pc-bg); border-radius: 8px;
  padding: 8px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.pc-whisper-input button:disabled { opacity: .5; cursor: default; }
.pc-attachment-chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 40%; font-size: 12px; line-height: 18px; overflow: hidden; white-space: nowrap; }

.pc-quiet-btn:focus-visible,
.pc-feedback-action:focus-visible,
.pc-whisper-input button:focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 3px; }
.pc-whisper-input:focus-within { border-color: var(--pc-accent); }
.pc-quiet-btn, .pc-stop, .pc-feedback-action, .pc-whisper-input button { transition: color .18s, background .18s, transform .18s var(--pc-ease); }
.pc-quiet-btn:active, .pc-stop:active:not(:disabled), .pc-feedback-action:active:not(:disabled), .pc-whisper-input button:active:not(:disabled) { transform: scale(.98) translateY(1px); }

@media (min-width: 520px) {

  .pc-dialogue-box { padding: 20px 24px 18px; }
}
.pc-plugin-cards { min-width: 0; display: grid; gap: 16px; }
@media (min-width: 900px) {
  .pc-header { padding-inline: max(24px, env(safe-area-inset-left, 0px)) max(24px, env(safe-area-inset-right, 0px)); }
  .pc-content {
    width: min(1120px, 100%); justify-self: center;
    grid-template-columns: minmax(0, .9fr) minmax(0, 1.2fr);
    grid-template-rows: minmax(min-content, 1fr) max-content;
    align-content: stretch; column-gap: 40px; row-gap: 18px;
    padding-block: 24px 32px;
  }
  .pc-stage { grid-column: 1; grid-row: 1 / 3; align-self: center; }
  .pc-pet-wrap { width: min(420px, 100%); height: clamp(340px, 55dvh, 560px); }
  .pc-dialogue { grid-column: 2; grid-row: 1; align-self: end; }
  .pc-home-nav { grid-column: 2; grid-row: 2; }
  .pc-plugin-cards { grid-column: 2; }
  .pc-whisper { padding-inline: max(24px, env(safe-area-inset-left, 0px)) max(24px, env(safe-area-inset-right, 0px)); }
}
.proactive-companion.pc-viewport--short .pc-stage,
.pc-viewport--short .pc-stage { display: none; }
.proactive-companion.pc-viewport--short .pc-content,
.pc-viewport--short .pc-content {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: none;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 12px;
  padding-block: 8px 12px;
}
.proactive-companion.pc-viewport--short .pc-dialogue,
.proactive-companion.pc-viewport--short .pc-home-nav,
.proactive-companion.pc-viewport--short .pc-plugin-cards,
.pc-viewport--short .pc-dialogue,
.pc-viewport--short .pc-home-nav,
.pc-viewport--short .pc-plugin-cards { grid-column: auto; grid-row: auto; }
.proactive-companion[data-platform="mobile"].pc-viewport--short .pc-dialogue,
.proactive-companion[data-platform="mobile"].pc-viewport--short .pc-deck-track { margin-block-start: 0; }
.proactive-companion.pc-viewport--short .pc-whisper-label,
.pc-viewport--short .pc-whisper-label { display: none; }
.proactive-companion.pc-viewport--short .pc-whisper-input textarea,
.proactive-companion.pc-viewport--short .pc-whisper-input input,
.pc-viewport--short .pc-whisper-input textarea,
.pc-viewport--short .pc-whisper-input input { grid-row: 1; }
.proactive-companion.pc-viewport--short .pc-whisper-input,
.pc-viewport--short .pc-whisper-input { padding: 6px 8px 6px 12px; }
.proactive-companion.pc-viewport--short .pc-dialogue-box,
.pc-viewport--short .pc-dialogue-box { padding: 12px 16px; border-radius: 16px; }
.proactive-companion.pc-viewport--short .pc-dialogue-text,
.pc-viewport--short .pc-dialogue-text { font-size: 14px; line-height: 22px; }
@media (max-height: 520px) {
  .pc-stage { display: none; }
  .pc-content {
    grid-template-columns: minmax(0, 1fr); grid-template-rows: none;
    grid-auto-rows: max-content; align-content: start; gap: 12px; padding-block: 8px 12px;
  }
  .pc-dialogue, .pc-home-nav, .pc-plugin-cards { grid-column: auto; grid-row: auto; }
  .proactive-companion[data-platform="mobile"] .pc-dialogue,
  .proactive-companion[data-platform="mobile"] .pc-deck-track { margin-block-start: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .pc-caret, .pc-waiting-dots i { animation: none; }
  .pc-home-entry, .pc-quiet-btn, .pc-stop, .pc-feedback-action, .pc-whisper-input button { transition: none; }
}

/* Android: Material 3 roles and official component states. The composition
 * root alone opts into this language; desktop/web retain the existing surface. */
.proactive-companion[data-design-system="material3"][data-platform] {
  --pc-bg: var(--md-sys-color-surface);
  --pc-ink: var(--md-sys-color-on-surface);
  --pc-ink-2: var(--md-sys-color-on-surface-variant);
  --pc-ink-3: var(--md-sys-color-on-surface-variant);
  --pc-feedback: var(--md-sys-color-error);
  --pc-line: var(--md-sys-color-outline-variant);
  --pc-line-soft: var(--md-sys-color-outline-variant);
  --pc-accent: var(--md-sys-color-primary);
  --pc-accent-soft: var(--md-sys-color-primary-container);
  --pc-card: var(--md-sys-color-surface-container-low);
  --pc-radius: 24px;
  --pc-ease: cubic-bezier(.2, 0, 0, 1);
  background: var(--pc-bg);
  font-family: var(--md-ref-typeface-plain, Roboto, "Noto Sans SC", sans-serif);
  letter-spacing: 0;
}
.proactive-companion[data-design-system="material3"] .pc-header {
  min-height: calc(64px + env(safe-area-inset-top, 0px));
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: 0;
  background: var(--md-sys-color-surface);
}
.proactive-companion[data-design-system="material3"] .pc-brand { gap: 12px; font-size: 22px; line-height: 28px; font-weight: 400; letter-spacing: 0; }
.proactive-companion[data-design-system="material3"] .pc-top-right { gap: 0; }
.proactive-companion[data-design-system="material3"] .pc-quiet-btn {
  --md-icon-button-icon-size: 24px;
  --md-icon-button-state-layer-shape: 50%;
  width: 48px; height: 48px; flex-basis: 48px; border-radius: 50%; padding: 0;
  background: transparent; color: var(--md-sys-color-on-surface-variant);
}
.proactive-companion[data-design-system="material3"] .pc-content { gap: 14px; padding-block: 14px 14px; }
.proactive-companion[data-design-system="material3"] .pc-stage { padding-top: 0; }
.proactive-companion[data-design-system="material3"] .pc-pet-status {
  top: 2px; padding: 2px 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--md-sys-color-surface) 70%, transparent);
  backdrop-filter: blur(8px);
  font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: .5px;
}
.proactive-companion[data-design-system="material3"] .pc-pet-status::before { background: var(--md-sys-color-outline); }
.proactive-companion[data-design-system="material3"] .pc-dialogue-name { margin: 0 16px 8px; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: .1px; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-name::after { display: none; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-box { padding: 20px 24px; border: 0; border-radius: 24px; box-shadow: none; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-text { margin-block: 0; font-size: 16px; line-height: 26px; letter-spacing: .2px; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-foot { padding-top: 0; margin-top: 16px; border-top: 0; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-ctx { font-size: 12px; line-height: 16px; letter-spacing: .4px; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-waiting { display: grid; gap: 12px; margin: 0; font-size: 14px; line-height: 20px; }
.pc-material-progress { width: min(160px, 100%); }

.proactive-companion[data-design-system="material3"] .pc-feedback {
  gap: 4px 12px; margin: 8px 0; padding: 12px 16px; border-radius: 16px;
  color: var(--md-sys-color-on-surface-variant); background: var(--md-sys-color-surface-container-high);
  font-size: 14px; line-height: 20px;
}
.proactive-companion[data-design-system="material3"] .pc-feedback[data-kind$="error"] { background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); }
.proactive-companion[data-design-system="material3"] .pc-feedback-action { min-height: 48px; padding: 0; background: transparent; font-weight: 500; border-radius: 24px; }
.proactive-companion[data-design-system="material3"] .pc-whisper { gap: 8px; align-items: center; background: transparent; }

.proactive-companion[data-design-system="material3"] .pc-stop {
  --md-filled-tonal-button-container-height: 48px;
  margin: 0; min-height: 48px; border: 0; padding: 0; border-radius: 24px; background: transparent;
}
.proactive-companion[data-design-system="material3"] .pc-whisper-input {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  gap: 0 4px; padding: 8px 8px 8px 16px; background: var(--md-sys-color-surface-container-high);
  border: 0; border-radius: 28px; box-shadow: none;
}
/* 输入条只留「一个框 + 发送键」：标签退成可访问名称，不再占视觉行。 */
.proactive-companion[data-design-system="material3"] .pc-whisper-label {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; white-space: nowrap; clip-path: inset(50%);
}
.proactive-companion[data-design-system="material3"] .pc-whisper-input input { grid-column: 1; grid-row: 1; min-height: 32px; width: 100%; font-size: 16px; line-height: 24px; letter-spacing: .2px; }
.proactive-companion[data-design-system="material3"] .pc-whisper-input > :is(md-filled-button, md-filled-tonal-button) { grid-column: 2; grid-row: 1; min-width: 64px; --md-filled-button-container-height: 48px; }
.proactive-companion[data-design-system="material3"] .pc-attachment-chip {
  grid-column: 1 / -1; grid-row: 2; display: inline-flex; align-items: center; gap: 6px;
  justify-self: start; max-width: 100%; margin-top: 4px; padding: 4px 6px 4px 12px;
  border-radius: 999px; font-size: 12px; line-height: 18px;
  color: var(--md-sys-color-on-surface-variant); background: var(--md-sys-color-surface-container-highest);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pc-attachment-remove { display: grid; place-items: center; flex: 0 0 22px; width: 22px; height: 22px; border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; }
.pc-attachment-remove:hover { background: rgba(128, 134, 146, .18); }
.proactive-companion[data-design-system="material3"] .pc-interaction {
  width: 100%; max-width: 620px; justify-self: center; padding: 20px; border-radius: 24px;
  background: var(--md-sys-color-surface-container-low); color: var(--md-sys-color-on-surface);
}
.proactive-companion[data-design-system="material3"] .pc-interaction > md-filled-button { margin-inline-end: 8px; }
.proactive-companion[data-design-system="material3"] .pc-whisper-input:focus-within { outline: 3px solid var(--md-sys-color-primary); outline-offset: 3px; }
.proactive-companion[data-design-system="material3"] :is(.pc-quiet-btn, .pc-stop, .pc-feedback-action):active { transform: none; }
.proactive-companion[data-design-system="material3"].pc-viewport--short .pc-content { padding-block: 12px; gap: 16px; }
@media (max-width: 359px) {
  .proactive-companion[data-design-system="material3"] .pc-dialogue-box { padding: 16px; }
  .proactive-companion[data-design-system="material3"] .pc-whisper-input { padding-inline-start: 12px; }
  .proactive-companion[data-design-system="material3"] .pc-whisper-input > :is(md-filled-button, md-filled-tonal-button) { min-width: 48px; }
  /* Tiny multi-window widths wrap the placeholder; cap the growth so the
   * composer row stays on screen instead of pushing past the viewport. */
  .proactive-companion[data-design-system="material3"] .pc-whisper-input textarea,
  .pc-viewport--short .pc-whisper-input textarea { min-height: 24px; max-height: 48px; }
}
</style>

<style scoped>
.proactive-companion[data-design-system="material3"] { display: flex; flex-direction: column; }
.proactive-companion[data-design-system="material3"] > .pc-header,
.proactive-companion[data-design-system="material3"] > .pc-whisper { flex: 0 0 auto; }
.proactive-companion[data-design-system="material3"] > .pc-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.pc-mobile-feedback {
  display: grid; flex: 0 0 auto; min-width: 0;
  margin-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px));
}
.pc-mobile-preparing { flex: 0 0 auto; margin: 8px 16px; color: var(--md-sys-color-on-surface-variant); font-size: 14px; line-height: 20px; }
.pc-current-session { flex: 0 0 auto; margin: -4px 24px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--md-sys-color-on-surface-variant); font-size: 14px; line-height: 20px; }
/* 首页卡片堆叠：对话 / 会话 / 工具 三张卡同层叠放，左右滑动切换。
 * 桌面把轨道设为 contents，保持原有栅格排布不变。 */
.pc-deck-track { display: contents; }
.pc-deck-dots { display: none; }
/* 指示点：命中区 24px，视觉是 6px 圆点，当前页拉长成短横。 */
.pc-deck-dot {
  display: grid; place-items: center;
  width: 24px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.pc-deck-dot::before {
  content: ""; width: 6px; height: 6px; border-radius: 999px;
  background: var(--md-sys-color-outline);
  transition: width .18s var(--pc-ease), background-color .18s var(--pc-ease);
}
.pc-deck-dot.is-active::before { width: 18px; background: var(--md-sys-color-primary); }
.pc-deck-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pc-deck-current { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; line-height: 22px; }
.pc-deck-sessions { list-style: none; display: grid; gap: 6px; margin: 12px 0 0; padding: 0; }
.pc-deck-session {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
  padding: 10px 12px; border-radius: 14px; border: 1px solid transparent;
  background: var(--md-sys-color-surface-container-high); color: inherit; font: inherit; font-size: 14px;
  cursor: pointer; text-align: left;
}
.pc-deck-session.is-active { border-color: var(--md-sys-color-primary); }
.pc-deck-session-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-deck-session-mark { flex: 0 0 auto; font-size: 11px; color: var(--md-sys-color-primary); }
.pc-deck-empty { margin: 14px 0 0; color: var(--md-sys-color-on-surface-variant); font-size: 13px; line-height: 19px; }
.pc-deck-foot { display: flex; gap: 4px; margin-top: auto; padding-top: 8px; }
/* 日记卡：正文在卡内滚动，标题与页脚常驻。 */
.pc-diary-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; margin-top: 10px; }
.pc-diary-text { margin: 0; font-size: 14px; line-height: 24px; color: var(--md-sys-color-on-surface); white-space: pre-wrap; overflow-wrap: anywhere; }
.pc-diary-list { display: grid; gap: 6px; }
.pc-deck-hint { margin: 8px 4px 0; font-size: 12px; line-height: 18px; color: var(--md-sys-color-on-surface-variant); }
.pc-diary-error { color: var(--md-sys-color-error); }
.pc-deck-tools { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 10px; }
/* 工具卡内容少，整组垂直居中；否则卡片高度对齐对话卡后底部会空一大块。 */
.pc-deck-box--tools { justify-content: center; }
.pc-home-tool {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  min-height: 84px; padding: 12px; font: inherit; font-size: 13px; cursor: pointer;
  border-radius: 18px; border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low); color: var(--md-sys-color-on-surface-variant);
}
.pc-home-tool:disabled { opacity: .5; cursor: default; }
.pc-home-tool:active:not(:disabled) { background: var(--md-sys-color-surface-container-high); }
.pc-mobile-session-feedback { flex: 0 0 auto; margin: 8px 16px; font-size: 14px; line-height: 20px; color: var(--md-sys-color-error); }
.proactive-companion[data-design-system="material3"] .pc-whisper-input textarea { grid-column: 1; grid-row: 1; width: 100%; min-width: 0; min-height: 32px; max-height: 120px; border: 0; padding: 0; resize: none; outline: none; background: transparent; color: var(--md-sys-color-on-surface); font: inherit; font-size: 16px; line-height: 24px; overflow-y: auto; }
/* Keep feedback, its action and the editable draft available together above an IME. */
.proactive-companion[data-design-system="material3"].pc-viewport--short.pc-has-feedback .pc-whisper-input textarea { max-height: 32px; }

/* Brand color roles keep the companion glass and native controls consistent. */
.proactive-companion[data-design-system="material3"] .pc-dialogue-box {
  border-radius: 28px; padding: 18px 20px 14px;
  background:
    linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.03)),
    color-mix(in srgb, var(--md-sys-color-surface-container-low) 88%, transparent);
  backdrop-filter: blur(18px);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 12px 32px -18px rgba(0,0,0,.45);
}
.proactive-companion[data-design-system="material3"] .pc-dialogue-text { font-size: 16px; line-height: 24px; }
.proactive-companion[data-design-system="material3"] .pc-whisper-input {
  border-radius: 28px; padding: 6px 6px 6px 18px;
  background:
    linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.03)),
    color-mix(in srgb, var(--md-sys-color-surface-container-low) 88%, transparent);
  backdrop-filter: blur(18px);
  border: 1px solid var(--md-sys-color-outline-variant);
  box-shadow: 0 12px 32px -18px rgba(0,0,0,.45);
}
.proactive-companion[data-design-system="material3"] .pc-whisper-input:focus-within {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
  box-shadow: 0 12px 32px -18px rgba(0,0,0,.45);
}

.proactive-companion[data-design-system="material3"] .pc-current-session { margin-block-end: 2px; }
/* 名牌压在角色身上时保持可读：给一层贴近底色的圆角衬底。 */
.proactive-companion[data-design-system="material3"] .pc-dialogue-name {
  padding: 3px 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--md-sys-color-surface) 72%, transparent);
  backdrop-filter: blur(8px);
}
/* Keep the local configuration action reachable when the IME shortens the
 * viewport. Only its text scrolls; the action remains within the same bubble. */
.proactive-companion[data-platform="mobile"] .pc-deck-slide > .pc-dialogue-box.pc-dialogue-box--notice {
  display: flex; flex-direction: column; gap: 8px; overflow: hidden;
}
.pc-dialogue-box--notice .pc-model-configuration-notice { margin: 0; }
.proactive-companion[data-platform="mobile"] .pc-dialogue-box--notice .pc-model-configuration-notice {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain;
}
.pc-dialogue-box--notice .pc-configure-model { flex: 0 0 auto; align-self: flex-start; }
.pc-dialogue-box--notice .pc-dialogue-foot { flex: 0 0 auto; margin-top: 0; padding-top: 0; border-top: 0; }
</style>
